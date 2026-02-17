/**
 * QuickRupee Voice Bot — ElevenLabs Streaming TTS Client
 *
 * Connects to ElevenLabs WebSocket API for low-latency text-to-speech.
 *
 * Optimization decisions:
 *   - Uses the Turbo v2.5 model (lowest latency in ElevenLabs lineup)
 *   - Requests μ-law 8kHz output directly to avoid server-side
 *     transcoding — audio is forwarded to Twilio as-is
 *   - Streams audio chunks immediately as they arrive (don't wait
 *     for full synthesis) to minimize time-to-first-byte
 *   - Supports immediate cancellation for barge-in: calling stop()
 *     closes the synthesis and discards remaining chunks
 *
 * Latency targets:
 *   - First byte: <600ms
 *
 * Voice profiles are resolved from the config module and support
 * runtime switching via the VOICE_PROFILE env variable.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { VoiceProfile } from '../types/index.js';
import { TTSError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { hrtimeNs } from '../metrics/collector.js';
import type pino from 'pino';

// ─── Event Types ───────────────────────────────────────────────

export interface ElevenLabsClientEvents {
    audio: (audioBase64: string) => void;
    done: () => void;
    error: (error: TTSError) => void;
}

export declare interface ElevenLabsTTSClient {
    on<E extends keyof ElevenLabsClientEvents>(event: E, listener: ElevenLabsClientEvents[E]): this;
    emit<E extends keyof ElevenLabsClientEvents>(event: E, ...args: Parameters<ElevenLabsClientEvents[E]>): boolean;
}

// ─── Constants ─────────────────────────────────────────────────

const ELEVENLABS_WS_URL = 'wss://api.elevenlabs.io/v1/text-to-speech';

// ─── Client Implementation ─────────────────────────────────────

export class ElevenLabsTTSClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private readonly apiKey: string;
    private readonly model: string;
    private readonly voiceProfile: VoiceProfile;
    private readonly log: pino.Logger;

    /** Tracks when synthesis was requested for first-byte latency */
    private synthesisStartNs: bigint = BigInt(0);
    private hasReceivedFirstByte = false;

    /** Whether synthesis is currently in progress */
    private isSynthesizing = false;

    /** Last measured first-byte latency in ms */
    private lastFirstByteLatencyMs = 0;

    constructor(params: {
        apiKey: string;
        model: string;
        voiceProfile: VoiceProfile;
        callId: string;
    }) {
        super();
        this.apiKey = params.apiKey;
        this.model = params.model;
        this.voiceProfile = params.voiceProfile;
        this.log = logger.child({ component: 'tts', callId: params.callId });
    }

    /**
     * Synthesize text to speech via streaming WebSocket.
     *
     * Opens a new WebSocket connection for each synthesis request.
     * ElevenLabs WebSocket API is per-generation (not persistent).
     *
     * Audio chunks are emitted as 'audio' events with base64-encoded
     * μ-law PCM data ready to send to Twilio.
     *
     * @param text - Text to synthesize
     * @returns Promise that resolves when synthesis is complete
     */
    async synthesize(text: string): Promise<void> {
        if (this.isSynthesizing) {
            this.log.warn('Synthesis already in progress, stopping previous');
            this.stop();
        }

        this.isSynthesizing = true;
        this.hasReceivedFirstByte = false;
        this.synthesisStartNs = hrtimeNs();

        const wsUrl = `${ELEVENLABS_WS_URL}/${this.voiceProfile.voiceId}/stream-input?model_id=${this.model}&output_format=ulaw_8000`;

        return new Promise<void>((resolve, reject) => {
            try {
                this.ws = new WebSocket(wsUrl, {
                    headers: {
                        'xi-api-key': this.apiKey,
                    },
                });

                const timeout = setTimeout(() => {
                    this.stop();
                    reject(new TTSError('ElevenLabs WebSocket connection timeout', 'TTS_CONNECT_TIMEOUT'));
                }, 10000);

                this.ws.on('open', () => {
                    clearTimeout(timeout);
                    this.log.info({ event: 'tts_ws_open', textLength: text.length });

                    // Send the BOS (beginning of stream) message with text
                    const bosMessage = {
                        text: `${text} `,        // Trailing space signals start of generation
                        voice_settings: {
                            stability: this.voiceProfile.stability,
                            similarity_boost: this.voiceProfile.similarityBoost,
                        },
                        // Request generation to begin immediately
                        try_trigger_generation: true,
                        // Optimize for latency over quality
                        generation_config: {
                            chunk_length_schedule: [120, 160, 250, 290],
                        },
                    };

                    this.ws!.send(JSON.stringify(bosMessage));

                    // Send the EOS (end of stream) message to finalize
                    const eosMessage = { text: '' };
                    this.ws!.send(JSON.stringify(eosMessage));
                });

                this.ws.on('message', (data: WebSocket.Data) => {
                    try {
                        const message = JSON.parse(data.toString()) as {
                            audio?: string;
                            isFinal?: boolean;
                            normalizedAlignment?: unknown;
                            error?: string;
                        };

                        if (message.error) {
                            this.log.error({ event: 'tts_api_error', error: message.error });
                            this.emit('error', new TTSError(`ElevenLabs error: ${message.error}`, 'TTS_API_ERROR'));
                            return;
                        }

                        if (message.audio) {
                            // Track first-byte latency
                            if (!this.hasReceivedFirstByte) {
                                this.hasReceivedFirstByte = true;
                                const now = hrtimeNs();
                                this.lastFirstByteLatencyMs = Number(now - this.synthesisStartNs) / 1_000_000;

                                this.log.info({
                                    event: 'tts_first_byte',
                                    latencyMs: this.lastFirstByteLatencyMs,
                                });
                            }

                            // Emit audio chunk for Twilio forwarding
                            this.emit('audio', message.audio);
                        }

                        if (message.isFinal) {
                            this.isSynthesizing = false;
                            this.log.info({ event: 'tts_synthesis_complete' });
                            this.emit('done');
                            this.closeWebSocket();
                            resolve();
                        }
                    } catch (parseError) {
                        this.log.error({ err: parseError }, 'Failed to parse ElevenLabs message');
                    }
                });

                this.ws.on('error', (error) => {
                    clearTimeout(timeout);
                    this.isSynthesizing = false;
                    const ttsError = new TTSError(
                        `ElevenLabs WebSocket error: ${error.message}`,
                        'TTS_WS_ERROR'
                    );
                    this.log.error({ err: ttsError }, 'TTS WebSocket error');
                    this.emit('error', ttsError);
                    reject(ttsError);
                });

                this.ws.on('close', () => {
                    this.isSynthesizing = false;
                    this.log.debug('TTS WebSocket closed');
                });
            } catch (error) {
                this.isSynthesizing = false;
                const ttsError = new TTSError(
                    `Failed to start TTS synthesis: ${String(error)}`,
                    'TTS_SYNTHESIS_FAILED'
                );
                this.log.error({ err: ttsError }, 'TTS synthesis start failed');
                reject(ttsError);
            }
        });
    }

    /**
     * Immediately stop current synthesis.
     * Used for barge-in: when the user interrupts, we cancel TTS
     * and discard any remaining audio chunks.
     */
    stop(): void {
        this.isSynthesizing = false;
        this.closeWebSocket();
        this.log.info({ event: 'tts_stopped' });
    }

    /** Whether synthesis is currently in progress */
    getIsSynthesizing(): boolean {
        return this.isSynthesizing;
    }

    /** Get the last measured first-byte latency */
    getLastFirstByteLatencyMs(): number {
        return this.lastFirstByteLatencyMs;
    }

    /** Clean up all resources */
    async disconnect(): Promise<void> {
        this.stop();
        this.removeAllListeners();
    }

    // ── Private ───────────────────────────────────────────────────

    private closeWebSocket(): void {
        if (this.ws) {
            try {
                if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                    this.ws.close();
                }
            } catch {
                // Ignore close errors
            }
            this.ws = null;
        }
    }
}
