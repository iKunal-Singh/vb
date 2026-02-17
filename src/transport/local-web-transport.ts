import type WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';
import type { AudioTransport } from './audio-transport.js';
import {
    downsamplePcm16Mono,
    float32ToPcm16,
    interleavedToMonoPcm16,
    pcm16ToMulaw,
} from './audio-convert.js';

interface BrowserAudioMessage {
    type: 'audio';
    encoding: 'float32' | 'pcm16';
    sampleRate: number;
    channels?: number;
    data: string;
}

interface BrowserControlMessage {
    type: 'start' | 'stop' | 'ping' | 'dtmf';
    digit?: string;
}

type BrowserInboundMessage = BrowserAudioMessage | BrowserControlMessage;

export class LocalWebTransport implements AudioTransport {
    private readonly ws: WebSocket;
    private readonly streamId: string;
    private readonly localCallId: string;

    private onAudioCallback: (chunk: Buffer) => void = () => { /* noop */ };
    private onStartCallback: (meta: { streamId: string; callId: string }) => void = () => { /* noop */ };
    private onDtmfCallback: (digit: string) => void = () => { /* noop */ };
    private onCloseCallback: () => void = () => { /* noop */ };

    constructor(ws: WebSocket, callId: string) {
        this.ws = ws;
        this.streamId = randomUUID();
        this.localCallId = callId;

        const log = logger.child({ component: 'local-transport', callId });

        this.ws.on('message', (raw: WebSocket.RawData) => {
            try {
                const parsed = JSON.parse(raw.toString()) as BrowserInboundMessage;
                if (parsed.type === 'audio') {
                    const channels = parsed.channels ?? 1;
                    const mulaw = this.normalizeBrowserAudioToMulaw(parsed, channels);
                    this.onAudioCallback(mulaw);
                    return;
                }

                if (parsed.type === 'start') {
                    this.onStartCallback({ streamId: this.streamId, callId: this.localCallId });
                    return;
                }

                if (parsed.type === 'stop') {
                    this.onCloseCallback();
                    return;
                }

                if (parsed.type === 'dtmf' && parsed.digit) {
                    this.onDtmfCallback(parsed.digit);
                    return;
                }

                if (parsed.type === 'ping') {
                    this.ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
                }
            } catch (error) {
                log.error({ err: error }, 'Failed to process local browser websocket message');
            }
        });

        this.ws.on('close', () => {
            this.onCloseCallback();
        });

        this.ws.on('error', (error: Error) => {
            log.error({ err: error }, 'Local browser websocket error');
            this.onCloseCallback();
        });

        // Auto-start to mimic Twilio transport start lifecycle.
        setImmediate(() => {
            this.onStartCallback({ streamId: this.streamId, callId: this.localCallId });
            this.ws.send(JSON.stringify({ type: 'ready', streamId: this.streamId, callId: this.localCallId }));
        });
    }

    sendAudio(chunk: Buffer): void {
        if (this.ws.readyState !== 1) {
            return;
        }

        this.ws.send(JSON.stringify({
            type: 'audio',
            encoding: 'mulaw',
            sampleRate: 8000,
            data: chunk.toString('base64'),
        }));
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
        if (this.ws.readyState !== 1) {
            return;
        }

        this.ws.send(JSON.stringify({ type: 'clear' }));
    }

    close(): void {
        if (this.ws.readyState === 1 || this.ws.readyState === 0) {
            this.ws.close();
        }
    }

    private normalizeBrowserAudioToMulaw(message: BrowserAudioMessage, channels: number): Buffer {
        const sampleRate = message.sampleRate;
        const raw = Buffer.from(message.data, 'base64');

        let pcm16: Int16Array;

        if (message.encoding === 'float32') {
            const floats = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
            pcm16 = float32ToPcm16(floats);
        } else {
            pcm16 = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
        }

        const mono = interleavedToMonoPcm16(pcm16, channels);
        const downsampled = downsamplePcm16Mono(mono, sampleRate, 8000);

        return pcm16ToMulaw(downsampled);
    }
}
