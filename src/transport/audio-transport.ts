export interface AudioTransport {
    /** Send an outbound μ-law 8kHz chunk to the remote peer. */
    sendAudio(chunk: Buffer): void;

    /** Register callback for inbound μ-law 8kHz caller audio chunks. */
    onAudio(callback: (chunk: Buffer) => void): void;

    /** Register callback for transport start/metadata event. */
    onStart(callback: (meta: { streamId: string; callId: string }) => void): void;

    /** Register callback for DTMF digits when available (Twilio only). */
    onDTMF(callback: (digit: string) => void): void;

    /** Register callback when stream closes. */
    onClose(callback: () => void): void;

    /** Optional queue clear for barge-in. */
    clearPlaybackQueue(): void;

    /** Close transport and cleanup sockets/resources. */
    close(): void;
}
