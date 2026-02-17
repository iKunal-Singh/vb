/**
 * QuickRupee Voice Bot — Prometheus Metrics Collector
 *
 * Provides histogram, counter, and gauge metrics for the entire
 * voice pipeline. Exposes a /metrics endpoint for Prometheus scraping.
 *
 * Uses process.hrtime.bigint() for nanosecond-precision timing.
 * Histogram buckets are tuned to the latency targets in the dev plan:
 *   - STT first token: <400ms target
 *   - TTS first byte:  <600ms target
 *   - Total turn:      <1200ms target
 */

import client from 'prom-client';
import type { TurnDurations } from '../types/index.js';

/** Singleton metrics collector — instantiate once at startup */
export class MetricsCollector {
    // ── Histograms (latency percentiles) ──────────────────────────

    /** STT first-token latency in milliseconds */
    public readonly sttLatency = new client.Histogram({
        name: 'voice_bot_stt_latency_ms',
        help: 'STT first token latency in milliseconds',
        buckets: [50, 100, 150, 200, 300, 400, 500, 800],
    });

    /** TTS first-byte latency in milliseconds */
    public readonly ttsLatency = new client.Histogram({
        name: 'voice_bot_tts_latency_ms',
        help: 'TTS first byte latency in milliseconds',
        buckets: [100, 200, 300, 400, 500, 600, 800, 1000],
    });

    /** End-to-end turn latency (user stops speaking → bot starts speaking) */
    public readonly turnLatency = new client.Histogram({
        name: 'voice_bot_turn_latency_ms',
        help: 'End-to-end conversational turn latency in milliseconds',
        buckets: [100, 200, 300, 500, 800, 1000, 1200, 1500, 2000, 3000],
    });

    /** Logic evaluation latency (should be <10ms) */
    public readonly logicLatency = new client.Histogram({
        name: 'voice_bot_logic_latency_ms',
        help: 'Deterministic logic evaluation latency in milliseconds',
        buckets: [1, 2, 5, 10, 15, 25, 50],
    });

    // ── Counters ──────────────────────────────────────────────────

    /** Total calls by outcome */
    public readonly callsTotal = new client.Counter({
        name: 'voice_bot_calls_total',
        help: 'Total calls handled by outcome',
        labelNames: ['status'] as const,
    });

    /** Total conversational turns processed */
    public readonly turnsTotal = new client.Counter({
        name: 'voice_bot_turns_total',
        help: 'Total conversational turns processed',
    });

    /** Total barge-in interrupts detected */
    public readonly bargeInsTotal = new client.Counter({
        name: 'voice_bot_barge_ins_total',
        help: 'Total barge-in interrupts detected',
    });

    /** DTMF fallback activations */
    public readonly dtmfFallbacksTotal = new client.Counter({
        name: 'voice_bot_dtmf_fallbacks_total',
        help: 'Total DTMF fallback activations',
    });

    /** Error counter by domain */
    public readonly errorsTotal = new client.Counter({
        name: 'voice_bot_errors_total',
        help: 'Total errors by domain',
        labelNames: ['domain'] as const,
    });

    // ── Gauges ────────────────────────────────────────────────────

    /** Currently active WebSocket connections (calls) */
    public readonly activeCalls = new client.Gauge({
        name: 'voice_bot_active_calls',
        help: 'Number of currently active calls',
    });

    // ── Recording Methods ─────────────────────────────────────────

    /** Record all latencies for a completed conversational turn */
    recordTurnLatency(durations: TurnDurations): void {
        this.sttLatency.observe(durations.sttLatencyMs);
        this.ttsLatency.observe(durations.ttsLatencyMs);
        this.logicLatency.observe(durations.logicLatencyMs);
        this.turnLatency.observe(durations.totalTurnLatencyMs);
        this.turnsTotal.inc();
    }

    /** Record a completed call by status */
    recordCallComplete(status: 'eligible' | 'rejected' | 'error' | 'abandoned'): void {
        this.callsTotal.inc({ status });
    }

    /** Record a barge-in event */
    recordBargeIn(): void {
        this.bargeInsTotal.inc();
    }

    /** Record a DTMF fallback activation */
    recordDtmfFallback(): void {
        this.dtmfFallbacksTotal.inc();
    }

    /** Record an error by domain */
    recordError(domain: 'stt' | 'tts' | 'telephony' | 'engine' | 'llm'): void {
        this.errorsTotal.inc({ domain });
    }

    /** Increment active call gauge */
    callStarted(): void {
        this.activeCalls.inc();
    }

    /** Decrement active call gauge */
    callEnded(): void {
        this.activeCalls.dec();
    }

    // ── Metrics Endpoint ──────────────────────────────────────────

    /** Serialize all metrics in Prometheus exposition format */
    async getMetrics(): Promise<string> {
        return client.register.metrics();
    }

    /** Content-Type header for Prometheus */
    getContentType(): string {
        return client.register.contentType;
    }
}

/** Shared singleton instance */
export const metrics = new MetricsCollector();

/**
 * High-resolution nanosecond timestamp.
 * Used as the standard timing primitive throughout the pipeline.
 */
export function hrtimeNs(): bigint {
    return process.hrtime.bigint();
}
