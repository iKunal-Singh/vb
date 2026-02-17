/**
 * QuickRupee Voice Bot — Structured Logger (Pino)
 *
 * Pino is chosen for its low overhead (~5× faster than Winston),
 * which is critical in a latency-sensitive audio streaming pipeline.
 *
 * All log output is structured JSON for downstream parsing
 * (e.g. CloudWatch Insights, Grafana Loki).
 */

import pino from 'pino';

const LOG_LEVEL = process.env['LOG_LEVEL'] ?? 'info';
const NODE_ENV = process.env['NODE_ENV'] ?? 'development';

/**
 * Root logger instance.
 * In development, use pino-pretty transport for human-readable output.
 * In production, emit raw JSON (fastest path).
 */
export const logger = pino({
    level: LOG_LEVEL,
    // Base fields attached to every log line
    base: {
        service: 'quickrupee-voice-bot',
        env: NODE_ENV,
    },
    // Use ISO timestamps (Pino default is epoch ms; ISO is easier in log UIs)
    timestamp: pino.stdTimeFunctions.isoTime,
    // Redact sensitive fields automatically
    redact: {
        paths: [
            'twilio.authToken',
            'deepgram.apiKey',
            'elevenlabs.apiKey',
            'anthropic.apiKey',
        ],
        censor: '[REDACTED]',
    },
    // Pretty print in development only
    ...(NODE_ENV === 'development'
        ? {
            transport: {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    translateTime: 'SYS:HH:MM:ss.l',
                    ignore: 'pid,hostname',
                },
            },
        }
        : {}),
});

/**
 * Mask a phone number for logging (show only last 4 digits).
 * Example: "+919876543210" → "+91XXXXXX3210"
 */
export function maskPhoneNumber(phone: string): string {
    if (phone.length <= 4) return phone;
    const visible = phone.slice(-4);
    const masked = phone.slice(0, -4).replace(/\d/g, 'X');
    return `${masked}${visible}`;
}

/**
 * Create a child logger scoped to a specific call.
 * All log lines from this child will include the callId automatically.
 */
export function createCallLogger(callId: string, phoneNumber: string): pino.Logger {
    return logger.child({
        callId,
        phone: maskPhoneNumber(phoneNumber),
    });
}

/**
 * Convert high-resolution nanosecond bigint to milliseconds.
 * Used throughout the codebase for latency calculations.
 */
export function nsToMs(ns: bigint): number {
    return Number(ns) / 1_000_000;
}

/**
 * Compute the difference between two hrtime bigints in milliseconds.
 */
export function hrtimeDiffMs(startNs: bigint, endNs: bigint): number {
    return nsToMs(endNs - startNs);
}
