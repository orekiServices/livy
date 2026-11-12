import type { FastifyInstance } from 'fastify';
import type { DatabaseAdapter } from '../db/adapter.js';
import type { PlaybackService } from '../services/playbackService.js';

export async function registerHealthRoutes(
  app: FastifyInstance,
  db: DatabaseAdapter,
  playback: PlaybackService,
): Promise<void> {
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  app.get('/ready', async (_req, reply) => {
    const dbOk = await db.ping().catch(() => false);
    if (!dbOk) return reply.status(503).send({ status: 'not_ready', db: 'down' });
    return { status: 'ready', db: db.name };
  });

  app.get('/api/v1/status', async () => ({
    stations: await playback.allStatuses(),
    timestamp: new Date().toISOString(),
  }));
}
