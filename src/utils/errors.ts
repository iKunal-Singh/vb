/**
 * QuickRupee Voice Bot — Structured Error Classes
 *
 * Each error class maps to a specific failure domain, enabling
 * targeted catch blocks and structured log output.
 * All errors carry a machine-readable `code` for metrics/alerting.
 */

/** Base error with a machine-readable code and optional cause chaining */
export class VoiceBotError extends Error {
    public readonly code: string;
    public readonly timestamp: number;

    constructor(message: string, code: string, options?: ErrorOptions) {
        super(message, options);
        this.name = this.constructor.name;
        this.code = code;
        this.timestamp = Date.now();

        // Maintain proper prototype chain for instanceof checks
        Object.setPrototypeOf(this, new.target.prototype);
    }

    /** Structured representation for Pino logging */
    toJSON(): Record<string, unknown> {
        return {
            name: this.name,
            message: this.message,
            code: this.code,
            timestamp: this.timestamp,
            stack: this.stack,
            cause: this.cause,
        };
    }
}

// ─── Domain-Specific Errors ────────────────────────────────────

/** Speech-to-Text failures (Deepgram WebSocket, confidence, timeout) */
export class STTError extends VoiceBotError {
    constructor(message: string, code: string = 'STT_ERROR', options?: ErrorOptions) {
        super(message, code, options);
    }
}

/** Text-to-Speech failures (ElevenLabs WebSocket, encoding, timeout) */
export class TTSError extends VoiceBotError {
    constructor(message: string, code: string = 'TTS_ERROR', options?: ErrorOptions) {
        super(message, code, options);
    }
}

/** Telephony layer failures (Twilio stream, DTMF, connection) */
export class TelephonyError extends VoiceBotError {
    constructor(message: string, code: string = 'TELEPHONY_ERROR', options?: ErrorOptions) {
        super(message, code, options);
    }
}

/** Conversation engine failures (state transitions, invalid input) */
export class EngineError extends VoiceBotError {
    constructor(message: string, code: string = 'ENGINE_ERROR', options?: ErrorOptions) {
        super(message, code, options);
    }
}

/** Post-call LLM worker failures (Claude API, parsing) */
export class LLMError extends VoiceBotError {
    constructor(message: string, code: string = 'LLM_ERROR', options?: ErrorOptions) {
        super(message, code, options);
    }
}

/** Configuration errors (missing env vars, invalid values) */
export class ConfigError extends VoiceBotError {
    constructor(message: string, code: string = 'CONFIG_ERROR', options?: ErrorOptions) {
        super(message, code, options);
    }
}
