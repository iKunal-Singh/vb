import type WebSocket from 'ws';
import { TwilioStreamHandler } from '../telephony/twilio-handler.js';
import type { AudioTransport } from './audio-transport.js';

export class TwilioTransport implements AudioTransport {
    private readonly handler: TwilioStreamHandler;

    private onAudioCallback: (chunk: Buffer) => void = () => { /* noop */ };
    private onStartCallback: (meta: { streamId: string; callId: string }) => void = () => { /* noop */ };
    private onDtmfCallback: (digit: string) => void = () => { /* noop */ };
    private onCloseCallback: () => void = () => { /* noop */ };

    constructor(ws: WebSocket, callId: string) {
        this.handler = new TwilioStreamHandler(ws, {
            onStart: (streamSid, twilioCallSid) => {
                this.onStartCallback({ streamId: streamSid, callId: twilioCallSid });
            },
            onAudio: (audioBuffer) => {
                this.onAudioCallback(audioBuffer);
            },
            onDTMF: (digit) => {
                this.onDtmfCallback(digit);
            },
            onStop: () => {
                this.onCloseCallback();
            },
        }, callId);
    }

    sendAudio(chunk: Buffer): void {
        this.handler.sendAudio(chunk.toString('base64'));
    }

    onAudio(callback: (chunk: Buffer) => void): void {
        this.onAudioCallback = callback;
    }

    onStart(callback: (meta: { streamId: string; callId: string }) => void): void {
        this.onStartCallback = callback;
    }

    onDTMF(callback: (digit: string) => void): void {
        this.onDtmfCallback = callback;
    }

    onClose(callback: () => void): void {
        this.onCloseCallback = callback;
    }

    clearPlaybackQueue(): void {
        this.handler.clearAudioQueue();
    }

    close(): void {
        // Lifecycle owned by underlying websocket close; no-op here.
    }
}
