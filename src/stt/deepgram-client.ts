/**
 * QuickRupee Voice Bot — Deepgram Streaming STT Client
 *
 * Maintains a persistent WebSocket connection to Deepgram Nova-2
 * for real-time speech-to-text transcription.
 *
 * Optimization decisions:
 *   - Endpointing set to 200ms (down from 300ms default) for faster
 *     end-of-speech detection. This trades occasional premature cutoffs
 *     for ~100ms lower latency on every turn.
 *   - Interim results are enabled for barge-in detection. The session
 *     layer watches interim transcripts to detect user speech while
 *     the bot is talking.
 *   - Smart formatting is enabled for numbers ("thirty thousand" → "30000")
 *     which simplifies the salary parser.
 *   - Indian English model (en-IN) is used for better accent recognition.
 *
 * Latency targets:
 *   - First token:       <400ms
 *   - Final transcript:  <600ms (from end of speech)
 */

import { EventEmitter } from 'events';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import type { LiveSchema, LiveClient } from '@deepgram/sdk';
import type { STTTranscriptEvent } from '../types/index.js';
import { STTError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { hrtimeNs } from '../metrics/collector.js';
import type pino from 'pino';

// ─── Event Types ───────────────────────────────────────────────

export interface DeepgramClientEvents {
    transcript: (event: STTTranscriptEvent) => void;
    interim: (event: STTTranscriptEvent) => void;
    error: (error: STTError) => void;
    close: () => void;
}

export declare interface DeepgramSTTClient {
    on<E extends keyof DeepgramClientEvents>(event: E, listener: DeepgramClientEvents[E]): this;
    emit<E extends keyof DeepgramClientEvents>(event: E, ...args: Parameters<DeepgramClientEvents[E]>): boolean;
}

// ─── Client Implementation ─────────────────────────────────────

export class DeepgramSTTClient extends EventEmitter {
    private connection: LiveClient | null = null;
    private readonly apiKey: string;
    private readonly model: string;
    private readonly language: string;
    private readonly endpointingMs: number;
    private readonly log: pino.Logger;

    /** Tracks when the first token was received for each utterance */
    private utteranceStartNs: bigint = BigInt(0);
    private hasReceivedFirstToken = false;

    private isConnected = false;
    private reconnectAttempts = 0;
    private readonly maxReconnectAttempts = 5;

    constructor(params: {
        apiKey: string;
        model: string;
        language: string;
        endpointingMs: number;
        callId: string;
    }) {
        super();
        this.apiKey = params.apiKey;
        this.model = params.model;
        this.language = params.language;
        this.endpointingMs = params.endpointingMs;
        this.log = logger.child({ component: 'stt', callId: params.callId });
    }

    /**
     * Open a persistent WebSocket connection to Deepgram.
     * The connection stays open for the duration of the call.
     */
    async connect(): Promise<void> {
        try {
            const deepgram = createClient(this.apiKey);

            const options: LiveSchema = {
                model: this.model,
                language: this.language,
                encoding: 'mulaw',        // Twilio sends μ-law PCM
                sample_rate: 8000,         // Telephony standard
                channels: 1,
                punctuate: true,
                interim_results: true,     // Required for barge-in detection
                endpointing: this.endpointingMs,
                smart_format: true,        // Auto-formats numbers, currencies
                filler_words: false,       // Ignore "um", "uh" for cleaner transcripts
                utterance_end_ms: 1000,    // Silence duration to finalize utterance
            };

            this.connection = deepgram.listen.live(options);

            this.setupEventHandlers();

            // Wait for the connection to open
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new STTError('Deepgram connection timeout', 'STT_CONNECT_TIMEOUT'));
                }, 5000);

                this.connection!.on(LiveTranscriptionEvents.Open, () => {
                    clearTimeout(timeout);
                    this.isConnected = true;
                    this.reconnectAttempts = 0;

                    this.log.info('Deepgram STT connection established');
                    resolve();
                });

                this.connection!.on(LiveTranscriptionEvents.Error, (error) => {
                    clearTimeout(timeout);
                    reject(new STTError(`Deepgram connection error: ${String(error)}`, 'STT_CONNECT_ERROR'));
                });
            });
        } catch (error) {
            const sttError = error instanceof STTError
                ? error
                : new STTError(`Failed to connect to Deepgram: ${String(error)}`, 'STT_CONNECT_FAILED');
            this.log.error({ err: sttError }, 'STT connection failed');
            throw sttError;
        }
    }

    /**
     * Send raw audio data to Deepgram for transcription.
     * Audio must be μ-law PCM 8kHz (Twilio's native format).
     *
     * @param audioBuffer - Raw audio bytes (NOT base64 encoded)
     */
    sendAudio(audioBuffer: Buffer): void {
        if (!this.isConnected || !this.connection) {
            this.log.warn('Attempted to send audio to disconnected STT');
            return;
        }

        // Mark start of new utterance for latency tracking
        if (!this.hasReceivedFirstToken) {
            this.utteranceStartNs = hrtimeNs();
        }

        // Cast required: Deepgram SDK's SocketDataLike type is overly restrictive
        // and doesn't accept Buffer despite it being a valid WebSocket payload
        this.connection.send(audioBuffer as unknown as ArrayBuffer);
    }

    /** Gracefully close the Deepgram connection */
    async disconnect(): Promise<void> {
        if (this.connection) {
            this.isConnected = false;
            this.connection.requestClose();
            this.connection = null;
            this.log.info('Deepgram STT connection closed');
        }
    }

    /** Whether the client is currently connected */
    getIsConnected(): boolean {
        return this.isConnected;
    }

    /** Reset first-token tracking for a new utterance */
    resetUtteranceTracking(): void {
        this.hasReceivedFirstToken = false;
        this.utteranceStartNs = hrtimeNs();
    }

    // ── Private ───────────────────────────────────────────────────

    private setupEventHandlers(): void {
        if (!this.connection) return;

        // Transcript received (both interim and final)
        this.connection.on(LiveTranscriptionEvents.Transcript, (data) => {
            try {
                const now = hrtimeNs();
                const alternative = data.channel?.alternatives?.[0];

                if (!alternative || !alternative.transcript) return;

                const transcript = alternative.transcript.trim();
                if (transcript.length === 0) return;

                // Track first token latency
                if (!this.hasReceivedFirstToken) {
                    this.hasReceivedFirstToken = true;
                    this.log.info({
                        event: 'stt_first_token',
                        latencyMs: Number(now - this.utteranceStartNs) / 1_000_000,
                        transcript: transcript.substring(0, 50),
                    });
                }

                const event: STTTranscriptEvent = {
                    transcript,
                    confidence: alternative.confidence ?? 0,
                    isFinal: data.is_final ?? false,
                    firstTokenNs: this.utteranceStartNs,
                    finalTranscriptNs: data.is_final ? now : BigInt(0),
                };

                if (data.is_final) {
                    this.log.info({
                        event: 'stt_final_transcript',
                        transcript,
                        confidence: alternative.confidence,
                        latencyMs: Number(now - this.utteranceStartNs) / 1_000_000,
                    });
                    // Reset for next utterance
                    this.hasReceivedFirstToken = false;
                    this.emit('transcript', event);
                } else {
                    // Interim result — used for barge-in detection
                    this.emit('interim', event);
                }
            } catch (error) {
                this.log.error({ err: error }, 'Error processing Deepgram transcript');
            }
        });

        // Connection closed
        this.connection.on(LiveTranscriptionEvents.Close, () => {
            this.isConnected = false;
            this.log.info('Deepgram connection closed');
            this.emit('close');

            // Attempt reconnection for unexpected closures
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.attemptReconnect();
            }
        });

        // Error
        this.connection.on(LiveTranscriptionEvents.Error, (error) => {
            this.log.error({ err: error }, 'Deepgram STT error');
            this.emit('error', new STTError(`Deepgram error: ${String(error)}`, 'STT_RUNTIME_ERROR'));
        });
    }

    /**
     * Exponential backoff reconnection.
     * Delays: 1s, 2s, 4s, 8s, 16s
     */
    private attemptReconnect(): void {
        this.reconnectAttempts++;
        const delayMs = Math.pow(2, this.reconnectAttempts) * 1000;

        this.log.info({
            event: 'stt_reconnect_attempt',
            attempt: this.reconnectAttempts,
            delayMs,
        });

        setTimeout(async () => {
            try {
                await this.connect();
            } catch (error) {
                this.log.error({ err: error }, 'STT reconnection failed');
                if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                    this.emit('error', new STTError('Max STT reconnection attempts exceeded', 'STT_RECONNECT_EXHAUSTED'));
                }
            }
        }, delayMs);
    }
}
