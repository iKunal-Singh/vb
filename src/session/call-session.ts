/**
 * QuickRupee Voice Bot — Call Session Orchestrator
 *
 * Creates and manages one session per active phone call.
 * Orchestrates the real-time pipeline:
 *
 *   Twilio audio → STT (Deepgram) → Engine (state machine)
 *                                → TTS (ElevenLabs) → Twilio audio
 *
 * Responsibilities:
 *   - Instantiate per-call STT, TTS, and state machine instances
 *   - Wire event handlers between components
 *   - Measure per-turn latency with nanosecond precision
 *   - Detect and handle barge-in (user interrupts bot)
 *   - Trigger post-call LLM processing on call end
 *   - Clean up all resources on call termination
 *
 * This module owns the real-time latency budget. Every decision here
 * is optimized for minimal time between user-stops-speaking and
 * bot-starts-speaking.
 */

import type WebSocket from 'ws';
import { config, getActiveVoiceProfile } from '../config/index.js';
import { ConversationState } from '../types/index.js';
import type { TurnDurations, TranscriptTurn, STTTranscriptEvent } from '../types/index.js';
import { ConversationStateMachine } from '../engine/state-machine.js';
import { DeepgramSTTClient } from '../stt/deepgram-client.js';
import { ElevenLabsTTSClient } from '../tts/elevenlabs-client.js';
import { TwilioStreamHandler } from '../telephony/twilio-handler.js';
import { metrics, hrtimeNs } from '../metrics/collector.js';
import { processCallbackNote } from '../llm/claude-worker.js';
import { createCallLogger, hrtimeDiffMs } from '../utils/logger.js';
import type pino from 'pino';

export class CallSession {
    private readonly callId: string;
    private readonly log: pino.Logger;

    private twilioHandler: TwilioStreamHandler | null = null;
    private sttClient: DeepgramSTTClient | null = null;
    private ttsClient: ElevenLabsTTSClient | null = null;
    private stateMachine: ConversationStateMachine;

    /** Whether this session has been cleaned up */
    private destroyed = false;

    /** Per-turn latency tracking */
    private turnStartNs: bigint = BigInt(0);
    private sttFinalNs: bigint = BigInt(0);
    private logicStartNs: bigint = BigInt(0);
    private logicEndNs: bigint = BigInt(0);
    private ttsRequestNs: bigint = BigInt(0);
    private ttsFirstByteNs: bigint = BigInt(0);

    /** Turn counter for unique turn IDs */
    private turnCounter = 0;

    /** DTMF digit accumulator (for salary input via keypad) */
    private dtmfBuffer = '';
    private dtmfTimer: ReturnType<typeof setTimeout> | null = null;

    /** Track call start for duration logging */
    private readonly callStartNs: bigint;

    constructor(callId: string, phoneNumber: string) {
        this.callId = callId;
        this.callStartNs = hrtimeNs();
        this.log = createCallLogger(callId, phoneNumber);
        this.stateMachine = new ConversationStateMachine(callId, phoneNumber);

        this.log.info({ event: 'session_created' });
        metrics.callStarted();
    }

    /**
     * Initialize the session with a Twilio WebSocket connection.
     * Sets up the full streaming pipeline.
     */
    async initialize(ws: WebSocket): Promise<void> {
        try {
            // 1. Create Twilio handler
            this.twilioHandler = new TwilioStreamHandler(ws, {
                onStart: this.handleTwilioStart.bind(this),
                onAudio: this.handleTwilioAudio.bind(this),
                onDTMF: this.handleTwilioDTMF.bind(this),
                onStop: this.handleTwilioStop.bind(this),
            }, this.callId);

            // 2. Create STT client
            this.sttClient = new DeepgramSTTClient({
                apiKey: config.deepgram.apiKey,
                model: config.deepgram.model,
                language: config.deepgram.language,
                endpointingMs: config.deepgram.endpointingMs,
                callId: this.callId,
            });

            // 3. Create TTS client
            const voiceProfile = getActiveVoiceProfile();
            this.ttsClient = new ElevenLabsTTSClient({
                apiKey: config.elevenlabs.apiKey,
                model: config.elevenlabs.model,
                voiceProfile,
                callId: this.callId,
            });

            // 4. Wire STT events
            this.sttClient.on('transcript', this.handleFinalTranscript.bind(this));
            this.sttClient.on('interim', this.handleInterimTranscript.bind(this));
            this.sttClient.on('error', (error) => {
                this.log.error({ err: error }, 'STT error during session');
                metrics.recordError('stt');
            });

            // 5. Wire TTS events
            this.ttsClient.on('audio', this.handleTTSAudio.bind(this));
            this.ttsClient.on('error', (error) => {
                this.log.error({ err: error }, 'TTS error during session');
                metrics.recordError('tts');
            });

            this.log.info({ event: 'session_initialized', voiceProfile: config.voiceProfile });
        } catch (error) {
            this.log.error({ err: error }, 'Failed to initialize session');
            throw error;
        }
    }

    // ── Twilio Event Handlers ─────────────────────────────────────

    private async handleTwilioStart(streamSid: string, callSid: string): Promise<void> {
        this.log.info({
            event: 'call_stream_started',
            streamSid,
            callSid,
        });

        try {
            // Connect to Deepgram STT
            await this.sttClient?.connect();

            // Start the conversation with the greeting
            const result = this.stateMachine.startConversation();

            // Speak the greeting
            await this.speak(result.response);
        } catch (error) {
            this.log.error({ err: error }, 'Failed to start call pipeline');
            metrics.recordError('engine');
            this.destroy();
        }
    }

    /**
     * Handle audio from Twilio (caller's voice).
     * Forward directly to STT — this is the hottest path.
     * No processing, no copying, minimal overhead.
     */
    private handleTwilioAudio(audioBuffer: Buffer): void {
        if (this.destroyed) return;

        // Track turn start if not already tracking
        if (this.turnStartNs === BigInt(0)) {
            this.turnStartNs = hrtimeNs();
        }

        // Forward audio to Deepgram for transcription
        this.sttClient?.sendAudio(audioBuffer);
    }

    /** Handle DTMF digit from Twilio */
    private handleTwilioDTMF(digit: string): void {
        this.log.info({ event: 'dtmf_received', digit });

        // If in DTMF_FALLBACK mode, accumulate digits
        if (this.stateMachine.getCurrentState() === ConversationState.DTMF_FALLBACK) {
            if (digit === '#') {
                // '#' terminates DTMF input — process accumulated digits
                const result = this.stateMachine.handleDTMFInput(this.dtmfBuffer);
                this.dtmfBuffer = '';

                if (this.dtmfTimer) {
                    clearTimeout(this.dtmfTimer);
                    this.dtmfTimer = null;
                }

                if (result.response) {
                    void this.speak(result.response);
                }
                if (result.shouldEnd) {
                    this.endCall(result.newState);
                }
            } else {
                this.dtmfBuffer += digit;

                // Auto-process after 5 seconds of no input
                if (this.dtmfTimer) clearTimeout(this.dtmfTimer);
                this.dtmfTimer = setTimeout(() => {
                    if (this.dtmfBuffer.length > 0) {
                        const result = this.stateMachine.handleDTMFInput(this.dtmfBuffer);
                        this.dtmfBuffer = '';
                        if (result.response) {
                            void this.speak(result.response);
                        }
                        if (result.shouldEnd) {
                            this.endCall(result.newState);
                        }
                    }
                }, 5000);
            }

            // For single-digit DTMF (employment question: 1 or 2)
            if (digit === '1' || digit === '2') {
                const previousState = this.stateMachine.getContext().previousState;
                if (previousState === ConversationState.ASK_EMPLOYMENT) {
                    const result = this.stateMachine.handleDTMFInput(digit);
                    this.dtmfBuffer = '';
                    if (result.response) {
                        void this.speak(result.response);
                    }
                    if (result.shouldEnd) {
                        this.endCall(result.newState);
                    }
                }
            }

            metrics.recordDtmfFallback();
        }
    }

    /** Handle Twilio stream stop */
    private handleTwilioStop(): void {
        this.log.info({ event: 'call_ended' });
        this.endCall(this.stateMachine.getCurrentState());
    }

    // ── STT Event Handlers ────────────────────────────────────────

    /**
     * Handle final transcript from Deepgram.
     * This is where the real-time pipeline kicks in:
     *   STT final → Logic evaluation → TTS synthesis → Audio playback
     */
    private async handleFinalTranscript(event: STTTranscriptEvent): Promise<void> {
        if (this.destroyed) return;

        this.sttFinalNs = hrtimeNs();
        this.turnCounter++;
        const turnId = `turn_${String(this.turnCounter).padStart(3, '0')}`;

        // Record user transcript
        const userTurn: TranscriptTurn = {
            turnId,
            speaker: 'user',
            text: event.transcript,
            confidence: event.confidence,
            timestamp: Date.now(),
            state: this.stateMachine.getCurrentState(),
        };
        this.stateMachine.addTranscriptTurn(userTurn);

        this.log.info({
            event: 'user_input',
            turnId,
            transcript: event.transcript,
            confidence: event.confidence,
            state: this.stateMachine.getCurrentState(),
        });

        // ── Logic evaluation (deterministic, <10ms) ──────────────
        this.logicStartNs = hrtimeNs();
        const result = this.stateMachine.handleUserInput(event.transcript, event.confidence);
        this.logicEndNs = hrtimeNs();

        const logicLatencyMs = hrtimeDiffMs(this.logicStartNs, this.logicEndNs);
        this.log.info({
            event: 'logic_evaluated',
            turnId,
            logicLatencyMs,
            newState: result.newState,
            shouldEnd: result.shouldEnd,
        });

        // Record bot transcript
        if (result.response) {
            const botTurn: TranscriptTurn = {
                turnId,
                speaker: 'bot',
                text: result.response,
                confidence: 1.0,
                timestamp: Date.now(),
                state: result.newState,
            };
            this.stateMachine.addTranscriptTurn(botTurn);

            // ── TTS synthesis ────────────────────────────────────
            await this.speak(result.response);
        }

        // ── Record latency metrics ─────────────────────────────
        const durations: TurnDurations = {
            sttLatencyMs: hrtimeDiffMs(this.turnStartNs, this.sttFinalNs),
            logicLatencyMs,
            ttsLatencyMs: this.ttsClient?.getLastFirstByteLatencyMs() ?? 0,
            totalTurnLatencyMs: hrtimeDiffMs(this.turnStartNs, hrtimeNs()),
        };

        metrics.recordTurnLatency(durations);

        this.log.info({
            event: 'turn_completed',
            turnId,
            latency: durations,
            eligibility: this.stateMachine.getEligibility(),
        });

        // Reset for next turn
        this.turnStartNs = BigInt(0);
        this.sttClient?.resetUtteranceTracking();

        // End the call if needed
        if (result.shouldEnd) {
            // Wait for TTS to finish playing before hanging up
            setTimeout(() => {
                this.endCall(result.newState);
            }, 3000); // Allow 3s for final TTS to play
        }
    }

    /**
     * Handle interim transcript from Deepgram.
     * Used exclusively for barge-in detection:
     * if the user speaks while the bot is talking,
     * stop TTS and clear the audio queue.
     */
    private handleInterimTranscript(event: STTTranscriptEvent): void {
        if (this.destroyed) return;

        // Barge-in detection: user is speaking while bot is speaking
        if (this.stateMachine.isBotSpeaking() && event.confidence > 0.5) {
            this.log.info({
                event: 'barge_in_detected',
                interimTranscript: event.transcript.substring(0, 50),
                confidence: event.confidence,
            });

            // Stop TTS immediately
            this.ttsClient?.stop();
            this.stateMachine.setBotSpeaking(false);

            // Clear Twilio's audio buffer so the bot stops speaking
            this.twilioHandler?.clearAudioQueue();

            metrics.recordBargeIn();
        }
    }

    // ── TTS Handling ──────────────────────────────────────────────

    /**
     * Send text to TTS and stream audio to Twilio.
     * This is the output leg of the pipeline.
     */
    private async speak(text: string): Promise<void> {
        if (this.destroyed || !this.ttsClient || !this.twilioHandler) return;

        this.stateMachine.setBotSpeaking(true);
        this.ttsRequestNs = hrtimeNs();

        this.log.info({
            event: 'tts_request',
            textLength: text.length,
            text: text.substring(0, 100),
        });

        try {
            await this.ttsClient.synthesize(text);
        } catch (error) {
            this.log.error({ err: error }, 'TTS synthesis failed');
            metrics.recordError('tts');
        } finally {
            this.stateMachine.setBotSpeaking(false);
        }
    }

    /** Forward TTS audio chunks to Twilio */
    private handleTTSAudio(audioBase64: string): void {
        if (this.destroyed) return;

        if (!this.ttsFirstByteNs && this.ttsRequestNs) {
            this.ttsFirstByteNs = hrtimeNs();
        }

        this.twilioHandler?.sendAudio(audioBase64);
    }

    // ── Call Lifecycle ────────────────────────────────────────────

    /**
     * End the call and trigger post-call processing.
     */
    private endCall(finalState: ConversationState): void {
        if (this.destroyed) return;

        const callDurationMs = hrtimeDiffMs(this.callStartNs, hrtimeNs());
        const eligible = finalState === ConversationState.ELIGIBLE_CONFIRMATION;

        this.log.info({
            event: 'call_complete',
            finalState,
            eligible,
            callDurationMs,
            totalTurns: this.turnCounter,
        });

        // Record call outcome metric
        if (eligible) {
            metrics.recordCallComplete('eligible');
        } else if (finalState === ConversationState.REJECTION) {
            metrics.recordCallComplete('rejected');
        } else {
            metrics.recordCallComplete('abandoned');
        }

        // Trigger async post-call LLM processing (non-blocking)
        const eligibility = this.stateMachine.getEligibility();
        const transcript = this.stateMachine.getTranscript();
        const context = this.stateMachine.getContext();

        void processCallbackNote({
            callId: this.callId,
            transcript: [...transcript],
            eligibilityResult: {
                eligible,
                isSalaried: eligibility.isSalaried ?? false,
                salary: eligibility.salary,
                location: eligibility.location,
            },
            phoneNumber: context.phoneNumber,
        }).catch((error: unknown) => {
            this.log.error({ err: error }, 'Post-call LLM processing failed');
        });

        this.destroy();
    }

    /**
     * Clean up all session resources.
     * Called on call end, errors, or server shutdown.
     */
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;

        this.log.info({ event: 'session_destroyed' });

        // Clean up timers
        if (this.dtmfTimer) {
            clearTimeout(this.dtmfTimer);
            this.dtmfTimer = null;
        }

        // Disconnect STT
        void this.sttClient?.disconnect().catch((err) => {
            this.log.error({ err }, 'Error disconnecting STT');
        });

        // Disconnect TTS
        void this.ttsClient?.disconnect().catch((err) => {
            this.log.error({ err }, 'Error disconnecting TTS');
        });

        this.sttClient = null;
        this.ttsClient = null;
        this.twilioHandler = null;

        metrics.callEnded();
    }
}
