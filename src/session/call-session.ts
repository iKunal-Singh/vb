/**
 * QuickRupee Voice Bot — Call Session Orchestrator
 */

import { config, getActiveVoiceProfile } from '../config/index.js';
import { ConversationState } from '../types/index.js';
import type { TurnDurations, TranscriptTurn, STTTranscriptEvent } from '../types/index.js';
import { ConversationStateMachine } from '../engine/state-machine.js';
import { DeepgramSTTClient } from '../stt/deepgram-client.js';
import { ElevenLabsTTSClient } from '../tts/elevenlabs-client.js';
import { metrics, hrtimeNs } from '../metrics/collector.js';
import { processCallbackNote } from '../llm/claude-worker.js';
import { createCallLogger, hrtimeDiffMs } from '../utils/logger.js';
import type pino from 'pino';
import type { AudioTransport } from '../transport/audio-transport.js';

export class CallSession {
    private readonly callId: string;
    private readonly log: pino.Logger;

    private transport: AudioTransport | null = null;
    private sttClient: DeepgramSTTClient | null = null;
    private ttsClient: ElevenLabsTTSClient | null = null;
    private stateMachine: ConversationStateMachine;

    private destroyed = false;

    private turnStartNs: bigint = BigInt(0);
    private sttFinalNs: bigint = BigInt(0);
    private logicStartNs: bigint = BigInt(0);
    private logicEndNs: bigint = BigInt(0);
    private ttsRequestNs: bigint = BigInt(0);
    private ttsFirstByteNs: bigint = BigInt(0);

    private turnCounter = 0;

    private dtmfBuffer = '';
    private dtmfTimer: ReturnType<typeof setTimeout> | null = null;

    private readonly callStartNs: bigint;

    constructor(callId: string, phoneNumber: string) {
        this.callId = callId;
        this.callStartNs = hrtimeNs();
        this.log = createCallLogger(callId, phoneNumber);
        this.stateMachine = new ConversationStateMachine(callId, phoneNumber);

        this.log.info({ event: 'session_created' });
        metrics.callStarted();
    }

    async initialize(transport: AudioTransport): Promise<void> {
        try {
            this.transport = transport;

            this.sttClient = new DeepgramSTTClient({
                apiKey: config.deepgram.apiKey,
                model: config.deepgram.model,
                language: config.deepgram.language,
                endpointingMs: config.deepgram.endpointingMs,
                callId: this.callId,
            });

            const voiceProfile = getActiveVoiceProfile();
            this.ttsClient = new ElevenLabsTTSClient({
                apiKey: config.elevenlabs.apiKey,
                model: config.elevenlabs.model,
                voiceProfile,
                callId: this.callId,
            });

            this.sttClient.on('transcript', this.handleFinalTranscript.bind(this));
            this.sttClient.on('interim', this.handleInterimTranscript.bind(this));
            this.sttClient.on('error', (error) => {
                this.log.error({ err: error }, 'STT error during session');
                metrics.recordError('stt');
            });

            this.ttsClient.on('audio', this.handleTTSAudio.bind(this));
            this.ttsClient.on('error', (error) => {
                this.log.error({ err: error }, 'TTS error during session');
                metrics.recordError('tts');
            });

            this.transport.onStart(this.handleTransportStart.bind(this));
            this.transport.onAudio(this.handleTransportAudio.bind(this));
            this.transport.onDTMF(this.handleTransportDTMF.bind(this));
            this.transport.onClose(this.handleTransportStop.bind(this));

            this.log.info({ event: 'session_initialized', voiceProfile: config.voiceProfile });
        } catch (error) {
            this.log.error({ err: error }, 'Failed to initialize session');
            throw error;
        }
    }

    private async handleTransportStart(meta: { streamId: string; callId: string }): Promise<void> {
        this.log.info({
            event: 'call_stream_started',
            streamSid: meta.streamId,
            callSid: meta.callId,
        });

        try {
            await this.sttClient?.connect();
            const result = this.stateMachine.startConversation();
            await this.speak(result.response);
        } catch (error) {
            this.log.error({ err: error }, 'Failed to start call pipeline');
            metrics.recordError('engine');
            this.destroy();
        }
    }

    private handleTransportAudio(audioBuffer: Buffer): void {
        if (this.destroyed) return;

        if (this.turnStartNs === BigInt(0)) {
            this.turnStartNs = hrtimeNs();
        }

        this.sttClient?.sendAudio(audioBuffer);
    }

    private handleTransportDTMF(digit: string): void {
        this.log.info({ event: 'dtmf_received', digit });

        if (this.stateMachine.getCurrentState() === ConversationState.DTMF_FALLBACK) {
            if (digit === '#') {
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

    private handleTransportStop(): void {
        this.log.info({ event: 'call_ended' });
        this.endCall(this.stateMachine.getCurrentState());
    }

    private async handleFinalTranscript(event: STTTranscriptEvent): Promise<void> {
        if (this.destroyed) return;

        this.sttFinalNs = hrtimeNs();
        this.turnCounter++;
        const turnId = `turn_${String(this.turnCounter).padStart(3, '0')}`;

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

        if (result.response) {
            const botTurn: TranscriptTurn = {
                turnId,
                speaker: 'bot',
                text: result.response,
                confidence: 1,
                timestamp: Date.now(),
                state: result.newState,
            };
            this.stateMachine.addTranscriptTurn(botTurn);
            await this.speak(result.response);
        }

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

        this.turnStartNs = BigInt(0);
        this.sttClient?.resetUtteranceTracking();

        if (result.shouldEnd) {
            setTimeout(() => {
                this.endCall(result.newState);
            }, 3000);
        }
    }

    private handleInterimTranscript(event: STTTranscriptEvent): void {
        if (this.destroyed) return;

        if (this.stateMachine.isBotSpeaking() && event.confidence > 0.5) {
            this.log.info({
                event: 'barge_in_detected',
                interimTranscript: event.transcript.substring(0, 50),
                confidence: event.confidence,
            });

            this.ttsClient?.stop();
            this.stateMachine.setBotSpeaking(false);
            this.transport?.clearPlaybackQueue();

            metrics.recordBargeIn();
        }
    }

    private async speak(text: string): Promise<void> {
        if (this.destroyed || !this.ttsClient || !this.transport) return;

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

    private handleTTSAudio(audioBase64: string): void {
        if (this.destroyed) return;

        if (!this.ttsFirstByteNs && this.ttsRequestNs) {
            this.ttsFirstByteNs = hrtimeNs();
        }

        const audioChunk = Buffer.from(audioBase64, 'base64');
        this.transport?.sendAudio(audioChunk);
    }

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

        if (eligible) {
            metrics.recordCallComplete('eligible');
        } else if (finalState === ConversationState.REJECTION) {
            metrics.recordCallComplete('rejected');
        } else {
            metrics.recordCallComplete('abandoned');
        }

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

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;

        this.log.info({ event: 'session_destroyed' });

        if (this.dtmfTimer) {
            clearTimeout(this.dtmfTimer);
            this.dtmfTimer = null;
        }

        void this.sttClient?.disconnect().catch((err) => {
            this.log.error({ err }, 'Error disconnecting STT');
        });

        void this.ttsClient?.disconnect().catch((err) => {
            this.log.error({ err }, 'Error disconnecting TTS');
        });

        this.transport?.close();

        this.sttClient = null;
        this.ttsClient = null;
        this.transport = null;

        metrics.callEnded();
    }
}
