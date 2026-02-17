/**
 * QuickRupee Voice Bot — Centralized Configuration
 */

import dotenv from 'dotenv';
import type { AppConfig, TransportMode, VoiceProfile } from '../types/index.js';

dotenv.config();

const VOICE_PROFILES: Readonly<Record<string, VoiceProfile>> = {
    indian_warm: {
        voiceId: 'pNInz6obpgDQGcFmaJgB',
        accent: 'indian-english',
        gender: 'male',
        stability: 0.7,
        similarityBoost: 0.8,
    },
    indian_female: {
        voiceId: 'EXAVITQu4vr4xnSDxMaL',
        accent: 'indian-english',
        gender: 'female',
        stability: 0.8,
        similarityBoost: 0.75,
    },
    us_professional: {
        voiceId: '21m00Tcm4TlvDq8ikWAM',
        accent: 'neutral-english',
        gender: 'female',
        stability: 0.75,
        similarityBoost: 0.8,
    },
} as const;

function requireEnv(key: string): string {
    const value = process.env[key];
    if (!value) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
}

function optionalEnv(key: string, fallback: string): string {
    return process.env[key] ?? fallback;
}

function optionalInt(key: string, fallback: number): number {
    const raw = process.env[key];
    if (!raw) return fallback;
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed)) {
        throw new Error(`Environment variable ${key} must be an integer, got: ${raw}`);
    }
    return parsed;
}

function optionalFloat(key: string, fallback: number): number {
    const raw = process.env[key];
    if (!raw) return fallback;
    const parsed = parseFloat(raw);
    if (isNaN(parsed)) {
        throw new Error(`Environment variable ${key} must be a number, got: ${raw}`);
    }
    return parsed;
}

function optionalBool(key: string, fallback: boolean): boolean {
    const raw = process.env[key];
    if (!raw) return fallback;
    return raw === 'true' || raw === '1';
}

function optionalTransportMode(): TransportMode {
    const raw = optionalEnv('TRANSPORT_MODE', 'local');
    if (raw !== 'local' && raw !== 'twilio') {
        throw new Error(`TRANSPORT_MODE must be "local" or "twilio", got: ${raw}`);
    }
    return raw;
}

function buildAnthropicConfig(): AppConfig['anthropic'] {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey || apiKey.startsWith('sk-ant-xxxx')) {
        return undefined;
    }
    return Object.freeze({
        apiKey,
        model: optionalEnv('CLAUDE_MODEL', 'claude-sonnet-4-20250514'),
    });
}

function buildConfig(): AppConfig {
    const transportMode = optionalTransportMode();

    return Object.freeze({
        port: optionalInt('PORT', 3000),
        host: optionalEnv('HOST', '0.0.0.0'),
        nodeEnv: optionalEnv('NODE_ENV', 'development'),
        logLevel: optionalEnv('LOG_LEVEL', 'info'),
        transportMode,
        publicUrl: transportMode === 'twilio' ? requireEnv('PUBLIC_URL') : optionalEnv('PUBLIC_URL', ''),

        twilio: transportMode === 'twilio'
            ? Object.freeze({
                accountSid: requireEnv('TWILIO_ACCOUNT_SID'),
                authToken: requireEnv('TWILIO_AUTH_TOKEN'),
                phoneNumber: requireEnv('TWILIO_PHONE_NUMBER'),
            })
            : null,

        deepgram: Object.freeze({
            apiKey: requireEnv('DEEPGRAM_API_KEY'),
            model: optionalEnv('DEEPGRAM_MODEL', 'nova-2'),
            language: optionalEnv('DEEPGRAM_LANGUAGE', 'en-IN'),
            endpointingMs: optionalInt('DEEPGRAM_ENDPOINTING_MS', 200),
        }),

        elevenlabs: Object.freeze({
            apiKey: requireEnv('ELEVENLABS_API_KEY'),
            model: optionalEnv('ELEVENLABS_MODEL', 'eleven_turbo_v2_5'),
        }),

        voiceProfile: optionalEnv('VOICE_PROFILE', 'indian_warm'),
        sttConfidenceThreshold: optionalFloat('STT_CONFIDENCE_THRESHOLD', 0.7),

        anthropic: buildAnthropicConfig(),

        metricsEnabled: optionalBool('METRICS_ENABLED', true),
    });
}

export const config: AppConfig = buildConfig();

export function getActiveVoiceProfile(): VoiceProfile {
    const profile = VOICE_PROFILES[config.voiceProfile];
    if (!profile) {
        const fallback = VOICE_PROFILES.indian_warm;
        if (!fallback) {
            throw new Error('Default voice profile "indian_warm" is missing from registry');
        }
        return fallback;
    }
    return profile;
}

export function getAvailableProfiles(): string[] {
    return Object.keys(VOICE_PROFILES);
}

export function isLlmEnabled(): boolean {
    return config.anthropic !== undefined;
}
