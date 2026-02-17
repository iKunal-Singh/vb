/**
 * QuickRupee Voice Bot — Twilio Media Stream Handler
 *
 * Handles the bidirectional WebSocket connection from Twilio.
 *
 * Twilio sends:
 *   - `connected` — WebSocket handshake complete
 *   - `start` — Media stream metadata (streamSid, callSid, encoding)
 *   - `media` — Audio chunks (base64-encoded μ-law PCM 8kHz)
 *   - `dtmf` — Keypad digit presses
 *   - `stop` — Call ended or stream closed
 *
 * We send back:
 *   - `media` — TTS audio chunks for playback
 *   - `clear` — Clears the audio queue (for barge-in)
 *   - `mark` — Marks in the audio stream (for sync)
 *
 * The TwiML webhook generates the initial <Connect><Stream> response
 * that tells Twilio to open the bidirectional WebSocket.
 */

import type WebSocket from 'ws';
import type { TwilioStreamMessage } from '../types/index.js';
import { logger } from '../utils/logger.js';
import type pino from 'pino';

// ─── TwiML Generation ──────────────────────────────────────────

/**
 * Generate TwiML XML that instructs Twilio to open a bidirectional
 * media stream to our WebSocket endpoint.
 *
 * @param publicUrl - Public URL of this server (or ngrok tunnel)
 */
export function generateStreamTwiML(publicUrl: string): string {
    // Use wss:// for secure WebSocket
    const wsUrl = publicUrl.replace(/^https?:\/\//, 'wss://');

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}/media-stream" />
  </Connect>
</Response>`;
}

// ─── Twilio WebSocket Handler ──────────────────────────────────

export interface TwilioHandlerCallbacks {
    /** Called when media stream metadata is received */
    onStart: (streamSid: string, callSid: string) => void;
    /** Called for each audio chunk from the caller */
    onAudio: (audioBuffer: Buffer) => void;
    /** Called when the caller presses a DTMF key */
    onDTMF: (digit: string) => void;
    /** Called when the call/stream ends */
    onStop: () => void;
}

export class TwilioStreamHandler {
    private readonly ws: WebSocket;
    private readonly callbacks: TwilioHandlerCallbacks;
    private readonly log: pino.Logger;

    private streamSid: string | null = null;
    private callSid: string | null = null;

    /** Counter for media messages — useful for sequencing and debugging */
    private mediaMessageCount = 0;

    constructor(ws: WebSocket, callbacks: TwilioHandlerCallbacks, callId?: string) {
        this.ws = ws;
        this.callbacks = callbacks;
        this.log = logger.child({ component: 'twilio', callId: callId ?? 'unknown' });
        this.setupWebSocketHandlers();
    }

    /**
     * Send a TTS audio chunk to Twilio for playback to the caller.
     *
     * @param audioBase64 - Base64-encoded μ-law PCM audio
     */
    sendAudio(audioBase64: string): void {
        if (!this.streamSid) {
            this.log.warn('Cannot send audio: no active stream');
            return;
        }

        if (this.ws.readyState !== 1 /* WebSocket.OPEN */) {
            this.log.warn('Cannot send audio: WebSocket not open');
            return;
        }

        const message = JSON.stringify({
            event: 'media',
            streamSid: this.streamSid,
            media: {
                payload: audioBase64,
            },
        });

        this.ws.send(message);
    }

    /**
     * Clear Twilio's audio playback queue.
     * Used for barge-in: when the user interrupts, we clear queued
     * audio so the bot stops speaking immediately.
     */
    clearAudioQueue(): void {
        if (!this.streamSid) return;
        if (this.ws.readyState !== 1) return;

        const message = JSON.stringify({
            event: 'clear',
            streamSid: this.streamSid,
        });

        this.ws.send(message);
        this.log.info({ event: 'audio_queue_cleared' });
    }

    /**
     * Send a mark message to the audio stream.
     * Used to detect when audio playback finishes.
     */
    sendMark(markName: string): void {
        if (!this.streamSid) return;
        if (this.ws.readyState !== 1) return;

        const message = JSON.stringify({
            event: 'mark',
            streamSid: this.streamSid,
            mark: {
                name: markName,
            },
        });

        this.ws.send(message);
    }

    /** Get the Twilio stream SID */
    getStreamSid(): string | null {
        return this.streamSid;
    }

    /** Get the Twilio call SID */
    getCallSid(): string | null {
        return this.callSid;
    }

    // ── Private ───────────────────────────────────────────────────

    private setupWebSocketHandlers(): void {
        this.ws.on('message', (data: Buffer) => {
            try {
                const message = JSON.parse(data.toString()) as TwilioStreamMessage;
                this.handleMessage(message);
            } catch (error) {
                this.log.error({ err: error }, 'Failed to parse Twilio message');
            }
        });

        this.ws.on('error', (error) => {
            this.log.error({ err: error }, 'Twilio WebSocket error');
        });

        this.ws.on('close', (code, reason) => {
            this.log.info({
                event: 'twilio_ws_closed',
                code,
                reason: reason.toString(),
                mediaMessages: this.mediaMessageCount,
            });
            this.callbacks.onStop();
        });
    }

    private handleMessage(message: TwilioStreamMessage): void {
        switch (message.event) {
            case 'connected':
                this.log.info({
                    event: 'twilio_connected',
                    protocol: message.protocol,
                    version: message.version,
                });
                break;

            case 'start':
                this.streamSid = message.start.streamSid;
                this.callSid = message.start.callSid;
                this.log.info({
                    event: 'twilio_stream_started',
                    streamSid: this.streamSid,
                    callSid: this.callSid,
                    encoding: message.start.mediaFormat.encoding,
                    sampleRate: message.start.mediaFormat.sampleRate,
                });
                this.callbacks.onStart(this.streamSid, message.start.callSid);
                break;

            case 'media': {
                this.mediaMessageCount++;
                // Decode base64 audio payload to raw bytes
                const audioBuffer = Buffer.from(message.media.payload, 'base64');
                this.callbacks.onAudio(audioBuffer);
                break;
            }

            case 'dtmf':
                this.log.info({
                    event: 'twilio_dtmf',
                    digit: message.dtmf.digit,
                });
                this.callbacks.onDTMF(message.dtmf.digit);
                break;

            case 'stop':
                this.log.info({
                    event: 'twilio_stream_stopped',
                    callSid: message.stop.callSid,
                    totalMediaMessages: this.mediaMessageCount,
                });
                this.callbacks.onStop();
                break;

            default:
                // Unknown event type — log and ignore
                this.log.debug({ event: 'twilio_unknown_event', message });
                break;
        }
    }
}
