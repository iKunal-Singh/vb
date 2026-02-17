import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { randomUUID } from 'crypto';
import { config, isLlmEnabled } from './config/index.js';
import { generateStreamTwiML } from './telephony/twilio-handler.js';
import { CallSession } from './session/call-session.js';
import { metrics } from './metrics/collector.js';
import { logger } from './utils/logger.js';
import { TwilioTransport } from './transport/twilio-transport.js';
import { registerDevRoutes } from './dev/dev-routes.js';

const activeSessions: Map<string, CallSession> = new Map();

async function buildServer() {
    const server = Fastify({
        logger: false,
        trustProxy: true,
    });

    await server.register(fastifyWebsocket);

    server.get('/health', async (_request, reply) => {
        return reply.code(200).send({
            status: 'ok',
            uptime: process.uptime(),
            activeCalls: activeSessions.size,
            timestamp: new Date().toISOString(),
            transportMode: config.transportMode,
        });
    });

    server.get('/metrics', async (_request, reply) => {
        const metricsOutput = await metrics.getMetrics();
        return reply.type(metrics.getContentType()).code(200).send(metricsOutput);
    });

    if (config.transportMode === 'twilio') {
        server.post('/twiml', async (_request, reply) => {
            logger.info({ event: 'twiml_webhook_hit' });
            const twiml = generateStreamTwiML(config.publicUrl);
            return reply.type('text/xml').code(200).send(twiml);
        });

        server.get('/media-stream', { websocket: true }, (socket) => {
            const callId = randomUUID();

            logger.info({ event: 'websocket_connection_opened', callId });

            const session = new CallSession(callId, 'unknown');
            const transport = new TwilioTransport(socket, callId);
            activeSessions.set(callId, session);

            void session.initialize(transport).catch((error) => {
                logger.error({ err: error, callId }, 'Failed to initialize call session');
                activeSessions.delete(callId);
            });

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
    }

    if (config.transportMode === 'local') {
        await registerDevRoutes(server, activeSessions);
    }

    return server;
}

async function main(): Promise<void> {
    logger.info({
        event: 'server_starting',
        port: config.port,
        host: config.host,
        nodeEnv: config.nodeEnv,
        voiceProfile: config.voiceProfile,
        metricsEnabled: config.metricsEnabled,
        transportMode: config.transportMode,
    });

    const server = await buildServer();

    const shutdown = async (signal: string) => {
        logger.info({ event: 'shutdown_initiated', signal });

        for (const [callId, session] of activeSessions) {
            logger.info({ event: 'destroying_session', callId });
            session.destroy();
            activeSessions.delete(callId);
        }

        try {
            await server.close();
            logger.info({ event: 'server_shutdown_complete' });
            process.exit(0);
        } catch (error) {
            logger.error({ err: error }, 'Error during server shutdown');
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => {
        void shutdown('SIGTERM');
    });

    process.on('SIGINT', () => {
        void shutdown('SIGINT');
    });

    try {
        await server.listen({
            port: config.port,
            host: config.host,
        });

        logger.info({
            event: 'server_started',
            address: `http://${config.host}:${config.port}`,
            metrics: `http://${config.host}:${config.port}/metrics`,
            health: `http://${config.host}:${config.port}/health`,
            llmEnabled: isLlmEnabled(),
            transportMode: config.transportMode,
            devClient: config.transportMode === 'local' ? `http://${config.host}:${config.port}/dev` : undefined,
        });
    } catch (error) {
        logger.error({ err: error }, 'Failed to start server');
        process.exit(1);
    }
}

void main();
