import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PlaylistService } from '../services/playlistService.js';
import { apiKeyAuth } from '../middleware/auth.js';
import { ValidationError } from '../utils/errors.js';

const entrySchema = z.object({
  title: z.string().min(1).max(500),
  url: z.string().url(),
  duration: z.number().int().min(0).optional(),
  artist: z.string().max(300).optional(),
});

const createPlaylistSchema = z.object({
  name: z.string().min(1).max(120),
  entries: z.array(entrySchema).max(10000).optional(),
});

const importM3uSchema = z.object({
  name: z.string().min(1).max(120),
  content: z.string().min(1).max(5_000_000),
  baseUrl: z.string().url().default('https://example.com/'),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ValidationError(result.error.issues.map((i) => i.message).join('; '));
  return result.data;
}

export async function registerPlaylistRoutes(
  app: FastifyInstance,
  playlists: PlaylistService,
  apiKey: string | undefined,
): Promise<void> {
  const auth = { preHandler: apiKeyAuth(apiKey) };

  app.post('/api/v1/stations/:stationId/playlists', auth, async (req, reply) => {
    const playlist = await playlists.create(
      (req.params as { stationId: string }).stationId,
      parse(createPlaylistSchema, req.body),
    );
    return reply.status(201).send(playlist);
  });

  app.get('/api/v1/stations/:stationId/playlists', async (req) => playlists.list((req.params as { stationId: string }).stationId));

  app.get('/api/v1/playlists/:id', async (req) => playlists.get((req.params as { id: string }).id));

  app.patch('/api/v1/playlists/:id', auth, async (req) =>
    playlists.update((req.params as { id: string }).id, parse(createPlaylistSchema.partial(), req.body)),
  );

  app.delete('/api/v1/playlists/:id', auth, async (req, reply) => {
    await playlists.delete((req.params as { id: string }).id);
    return reply.status(204).send();
  });

  app.post('/api/v1/stations/:stationId/playlists/import-m3u', auth, async (req, reply) => {
    const body = parse(importM3uSchema, req.body);
    const playlist = await playlists.importM3u((req.params as { stationId: string }).stationId, body.name, body.content, body.baseUrl ?? 'https://example.com/');
    return reply.status(201).send(playlist);
  });

  app.get('/api/v1/playlists/:id/export-m3u', async (req, reply) => {
    const m3u = await playlists.exportM3u((req.params as { id: string }).id);
    return reply.type('audio/x-mpegurl').send(m3u);
  });
}
