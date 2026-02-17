import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { CallSession } from '../session/call-session.js';
import { LocalWebTransport } from '../transport/local-web-transport.js';
import { logger } from '../utils/logger.js';

export async function registerDevRoutes(server: FastifyInstance, activeSessions: Map<string, CallSession>): Promise<void> {
    server.get('/dev', async (_request, reply) => {
        const devPath = path.resolve(process.cwd(), 'public', 'dev.html');
        const html = await fs.readFile(devPath, 'utf-8');
        return reply.type('text/html').code(200).send(html);
    });

    server.get('/dev-audio', { websocket: true }, (socket) => {
        const callId = `local-${randomUUID()}`;

        logger.info({ event: 'local_websocket_connection_opened', callId });

        const session = new CallSession(callId, 'local-dev');
        const transport = new LocalWebTransport(socket, callId);
        activeSessions.set(callId, session);

        void session.initialize(transport).catch((error) => {
            logger.error({ err: error, callId }, 'Failed to initialize local call session');
            activeSessions.delete(callId);
        });

        socket.on('close', () => {
            logger.info({ event: 'local_websocket_connection_closed', callId });
            const existingSession = activeSessions.get(callId);
            if (existingSession) {
                existingSession.destroy();
                activeSessions.delete(callId);
            }
        });

        socket.on('error', (error) => {
            logger.error({ err: error, callId }, 'Local WebSocket error');
            const existingSession = activeSessions.get(callId);
            if (existingSession) {
                existingSession.destroy();
                activeSessions.delete(callId);
            }
        });
    });
}
