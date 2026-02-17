/**
 * QuickRupee Voice Bot — Shared Type Definitions
 *
 * Central type registry for the entire application.
 * All interfaces and enums used across modules are defined here
 * to enforce strong typing and clean module boundaries.
 */

// ─── Conversation State Machine ─────────────────────────────────

/** All possible states in the screening conversation flow */
export enum ConversationState {
    GREETING = 'GREETING',
    ASK_EMPLOYMENT = 'ASK_EMPLOYMENT',
    ASK_SALARY = 'ASK_SALARY',
    ASK_LOCATION = 'ASK_LOCATION',
    ELIGIBLE_CONFIRMATION = 'ELIGIBLE_CONFIRMATION',
    REJECTION = 'REJECTION',
    CLARIFICATION = 'CLARIFICATION',
    DTMF_FALLBACK = 'DTMF_FALLBACK',
    ENDED = 'ENDED',
}

/** Tracks which eligibility criteria have been evaluated */
export interface EligibilityData {
    isSalaried: boolean | null;
    salary: number | null;
    location: string | null;
}

/** A single turn in the conversation transcript */
export interface TranscriptTurn {
    turnId: string;
    speaker: 'user' | 'bot';
    text: string;
    confidence: number;
    timestamp: number;
    state: ConversationState;
}

/** Full per-call conversation context — one instance per active call */
export interface ConversationContext {
    readonly callId: string;
    readonly phoneNumber: string;
    currentState: ConversationState;
    /** State to return to after DTMF fallback resolves */
    previousState: ConversationState | null;
    eligibility: EligibilityData;
    turnCount: number;
    clarificationAttempts: number;
    transcript: TranscriptTurn[];
    /** Whether TTS is currently playing audio to the caller */
    isBotSpeaking: boolean;
    /** High-resolution start time of the current turn (ns) */
    currentTurnStartNs: bigint;
    /** Rejection reason if applicable */
    rejectionReason: string | null;
}

// ─── Latency Metrics ────────────────────────────────────────────

/** High-resolution timestamps for a single conversational turn */
export interface TurnTimestamps {
    userSpeechEnd: bigint;
    sttFirstToken: bigint;
    sttFinalTranscript: bigint;
    logicEvaluationStart: bigint;
    logicEvaluationEnd: bigint;
    ttsRequestSent: bigint;
    ttsFirstByte: bigint;
    audioPlaybackStart: bigint;
}

/** Computed durations (in milliseconds) for a single turn */
export interface TurnDurations {
    sttLatencyMs: number;
    logicLatencyMs: number;
    ttsLatencyMs: number;
    totalTurnLatencyMs: number;
}

/** Complete latency snapshot for one conversational turn */
export interface TurnLatencyMetrics {
    callId: string;
    turnId: string;
    timestamps: TurnTimestamps;
    durations: TurnDurations;
}

// ─── Voice Profiles ─────────────────────────────────────────────

export type VoiceAccent = 'indian-english' | 'neutral-english';
export type VoiceGender = 'male' | 'female';

/** Configuration for a single TTS voice */
export interface VoiceProfile {
    voiceId: string;
    accent: VoiceAccent;
    gender: VoiceGender;
    /** ElevenLabs stability parameter (0–1). Higher = less variation */
    stability: number;
    /** ElevenLabs similarity_boost parameter (0–1) */
    similarityBoost: number;
}

// ─── STT Events ─────────────────────────────────────────────────

/** Emitted by the STT client when a transcript is available */
export interface STTTranscriptEvent {
    transcript: string;
    confidence: number;
    isFinal: boolean;
    /** Nanosecond timestamp when the first token arrived */
    firstTokenNs: bigint;
    /** Nanosecond timestamp when the final transcript arrived (only set if isFinal) */
    finalTranscriptNs: bigint;
}

// ─── TTS Events ─────────────────────────────────────────────────

/** Emitted when TTS produces an audio chunk */
export interface TTSAudioChunk {
    /** Base64-encoded μ-law PCM audio at 8kHz */
    audioBase64: string;
    /** Whether this is the last chunk in the current synthesis */
    isLast: boolean;
}

// ─── Twilio Media Stream Messages ───────────────────────────────

export interface TwilioConnectedMessage {
    event: 'connected';
    protocol: string;
    version: string;
}

export interface TwilioStartMessage {
    event: 'start';
    sequenceNumber: string;
    start: {
        streamSid: string;
        accountSid: string;
        callSid: string;
        tracks: string[];
        customParameters: Record<string, string>;
        mediaFormat: {
            encoding: string;
            sampleRate: number;
            channels: number;
        };
    };
}

export interface TwilioMediaMessage {
    event: 'media';
    sequenceNumber: string;
    media: {
        track: string;
        chunk: string;
        timestamp: string;
        payload: string;
    };
}

export interface TwilioDtmfMessage {
    event: 'dtmf';
    sequenceNumber: string;
    dtmf: {
        digit: string;
        track: string;
    };
}

export interface TwilioStopMessage {
    event: 'stop';
    sequenceNumber: string;
    stop: {
        accountSid: string;
        callSid: string;
    };
}

export type TwilioStreamMessage =
    | TwilioConnectedMessage
    | TwilioStartMessage
    | TwilioMediaMessage
    | TwilioDtmfMessage
    | TwilioStopMessage;

// ─── Post-Call (Claude) ─────────────────────────────────────────

/** Job payload for the post-call Claude worker */
export interface CallbackNoteJob {
    callId: string;
    transcript: TranscriptTurn[];
    eligibilityResult: {
        eligible: boolean;
        isSalaried: boolean;
        salary: number | null;
        location: string | null;
    };
    phoneNumber: string;
}

/** Structured output from Claude callback note generation */
export interface CallbackNote {
    summary: string;
    urgency: 'high' | 'medium' | 'low';
    recommendedAction: string;
    customerSentiment: 'positive' | 'neutral' | 'negative';
    notes: string;
}

// ─── Application Config ─────────────────────────────────────────


export type TransportMode = 'local' | 'twilio';

export interface AppConfig {
    readonly port: number;
    readonly host: string;
    readonly nodeEnv: string;
    readonly logLevel: string;
    readonly transportMode: TransportMode;
    readonly publicUrl: string;

    readonly twilio: {
        readonly accountSid: string;
        readonly authToken: string;
        readonly phoneNumber: string;
    } | null;

    readonly deepgram: {
        readonly apiKey: string;
        readonly model: string;
        readonly language: string;
        readonly endpointingMs: number;
    };

    readonly elevenlabs: {
        readonly apiKey: string;
        readonly model: string;
    };

    readonly voiceProfile: string;
    readonly sttConfidenceThreshold: number;

    readonly anthropic?: {
        readonly apiKey: string;
        readonly model: string;
    };

    readonly metricsEnabled: boolean;
}
