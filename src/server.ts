/**
 * QuickRupee Voice Bot — Fastify Server
 *
 * Entry point for the voice bot backend.
 *
 * Routes:
 *   POST /twiml        — Twilio webhook, returns TwiML with <Connect><Stream>
 *   GET  /health       — Health check for load balancer / container orchestrator
 *   GET  /metrics      — Prometheus metrics endpoint
 *   WS   /media-stream — Twilio bidirectional WebSocket media stream
 *
 * Design:
 *   - Fastify chosen over Express for ~3x lower overhead per request
 *   - WebSocket plugin for native WS support alongside HTTP
 *   - Graceful shutdown drains active calls before process exit
 *   - Active call sessions managed in a Map keyed by unique call ID
 */

import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { config, isLlmEnabled } from './config/index.js';
import { generateStreamTwiML } from './telephony/twilio-handler.js';
import { CallSession } from './session/call-session.js';
import { metrics } from './metrics/collector.js';
import { logger } from './utils/logger.js';
import { randomUUID } from 'crypto';

// ── Active Sessions ─────────────────────────────────────────────

/** Map of callId → active CallSession */
const activeSessions: Map<string, CallSession> = new Map();

// ── Server Setup ────────────────────────────────────────────────

async function buildServer() {
    const server = Fastify({
        logger: false, // We use our own Pino logger
        trustProxy: true, // Running behind ALB
    });

    // Register WebSocket plugin
    await server.register(fastifyWebsocket);

    // ── POST /twiml ─────────────────────────────────────────────
    // Twilio calls this when an inbound call connects.
    // We return TwiML that tells Twilio to open a bidirectional
    // WebSocket media stream to our /media-stream endpoint.
    server.post('/twiml', async (_request, reply) => {
        logger.info({ event: 'twiml_webhook_hit' });

        const twiml = generateStreamTwiML(config.publicUrl);

        return reply
            .type('text/xml')
            .code(200)
            .send(twiml);
    });

    // ── GET /health ─────────────────────────────────────────────
    // Used by ALB health checks and container orchestrators.
    server.get('/health', async (_request, reply) => {
        return reply.code(200).send({
            status: 'ok',
            uptime: process.uptime(),
            activeCalls: activeSessions.size,
            timestamp: new Date().toISOString(),
        });
    });

    // ── GET /metrics ────────────────────────────────────────────
    // Prometheus scrape endpoint.
    server.get('/metrics', async (_request, reply) => {
        const metricsOutput = await metrics.getMetrics();
        return reply
            .type(metrics.getContentType())
            .code(200)
            .send(metricsOutput);
    });

    // ── WS /media-stream ───────────────────────────────────────
    // Twilio connects here after receiving the TwiML response.
    // Each connection = one active phone call.
    server.get('/media-stream', { websocket: true }, (socket, _request) => {
        const callId = randomUUID();

        logger.info({
            event: 'websocket_connection_opened',
            callId,
        });

        // Create a new call session
        // Phone number will be populated from Twilio's start message
        const session = new CallSession(callId, 'unknown');
        activeSessions.set(callId, session);

        // Initialize the session with the WebSocket
        void session.initialize(socket).catch((error) => {
            logger.error({ err: error, callId }, 'Failed to initialize call session');
            activeSessions.delete(callId);
        });

        // Clean up when connection closes
        socket.on('close', () => {
            logger.info({ event: 'websocket_connection_closed', callId });
            const existingSession = activeSessions.get(callId);
            if (existingSession) {
                existingSession.destroy();
                activeSessions.delete(callId);
            }
        });

        socket.on('error', (error) => {
            logger.error({ err: error, callId }, 'WebSocket error');
            const existingSession = activeSessions.get(callId);
            if (existingSession) {
                existingSession.destroy();
                activeSessions.delete(callId);
            }
        });
    });

    return server;
}

// ── Startup ─────────────────────────────────────────────────────

async function main(): Promise<void> {
    logger.info({
        event: 'server_starting',
        port: config.port,
        host: config.host,
        nodeEnv: config.nodeEnv,
        voiceProfile: config.voiceProfile,
        metricsEnabled: config.metricsEnabled,
    });

    const server = await buildServer();

    // Graceful shutdown
    const shutdown = async (signal: string) => {
        logger.info({ event: 'shutdown_initiated', signal });

        // Destroy all active sessions
        for (const [callId, session] of activeSessions) {
            logger.info({ event: 'destroying_session', callId });
            session.destroy();
            activeSessions.delete(callId);
        }

        try {
            await server.close();
            logger.info({ event: 'server_closed' });
            process.exit(0);
        } catch (error) {
            logger.error({ err: error }, 'Error during shutdown');
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));

    // Start listening
    try {
        await server.listen({ port: config.port, host: config.host });

        logger.info({
            event: 'server_started',
            address: `http://${config.host}:${config.port}`,
            publicUrl: config.publicUrl,
            voiceProfile: config.voiceProfile,
            llmEnabled: isLlmEnabled(),
            environment: config.nodeEnv,
            twimlEndpoint: `POST http://${config.host}:${config.port}/twiml`,
            healthEndpoint: `GET http://${config.host}:${config.port}/health`,
            metricsEndpoint: `GET http://${config.host}:${config.port}/metrics`,
            wsEndpoint: `ws://${config.host}:${config.port}/media-stream`,
        });

        // ── Local Testing Guide (dev mode only) ─────────────────
        if (config.nodeEnv === 'development') {
            const guide = [
                '',
                '╔══════════════════════════════════════════════════════════╗',
                '║             QuickRupee Voice Bot — Local Dev            ║',
                '╠══════════════════════════════════════════════════════════╣',
                `║  Server:    http://${config.host}:${config.port}`,
                `║  PUBLIC_URL: ${config.publicUrl}`,
                `║  Voice:     ${config.voiceProfile}`,
                `║  LLM:       ${isLlmEnabled() ? 'ENABLED (Claude)' : 'DISABLED — set ANTHROPIC_API_KEY to enable'}`,
                '╠══════════════════════════════════════════════════════════╣',
                '║  Local Testing Instructions:                            ║',
                '║                                                         ║',
                '║  1. Run: ngrok http 3000                                ║',
                '║  2. Copy the HTTPS forwarding URL                       ║',
                '║  3. Update PUBLIC_URL in .env to that URL               ║',
                '║  4. Restart this server                                 ║',
                '║  5. Set Twilio webhook to:                              ║',
                '║     https://your-ngrok-url/twiml                        ║',
                '║  6. Call your Twilio number                             ║',
                '║  7. Complete the 3-question screening flow              ║',
                '║  8. Check logs for latency data and metrics at /metrics ║',
                '╚══════════════════════════════════════════════════════════╝',
                '',
            ];
            console.log(guide.join('\n'));
        }
    } catch (error) {
        logger.error({ err: error }, 'Failed to start server');
        process.exit(1);
    }
}

// ── Run ─────────────────────────────────────────────────────────

void main();
