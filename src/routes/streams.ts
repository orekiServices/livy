import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StreamService } from '../services/streamService.js';
import { apiKeyAuth } from '../middleware/auth.js';
import { ValidationError } from '../utils/errors.js';

const createSourceSchema = z.object({
  name: z.string().min(1).max(120),
  url: z.string().url(),
  type: z.enum(['http', 'hls', 'file', 'rtmp']).optional(),
  format: z.enum(['mp3', 'flac', 'ogg', 'aac', 'hls', 'unknown']).optional(),
  priority: z.number().int().min(0).max(10000).optional(),
  enabled: z.boolean().optional(),
});

const updateSourceSchema = createSourceSchema.partial();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ValidationError(result.error.issues.map((i) => i.message).join('; '));
  return result.data;
}

export async function registerStreamRoutes(
  app: FastifyInstance,
  streams: StreamService,
  apiKey: string | undefined,
): Promise<void> {
  const auth = { preHandler: apiKeyAuth(apiKey) };

  app.post('/api/v1/stations/:stationId/sources', auth, async (req, reply) => {
    const source = await streams.create(
      (req.params as { stationId: string }).stationId,
      parse(createSourceSchema, req.body),
    );
    return reply.status(201).send(source);
  });

  app.get('/api/v1/stations/:stationId/sources', async (req) => streams.list((req.params as { stationId: string }).stationId));

  app.get('/api/v1/sources/:id', async (req) => streams.get((req.params as { id: string }).id));

  app.patch('/api/v1/sources/:id', auth, async (req) =>
    streams.update((req.params as { id: string }).id, parse(updateSourceSchema, req.body)),
  );

  app.delete('/api/v1/sources/:id', auth, async (req, reply) => {
    await streams.delete((req.params as { id: string }).id);
    return reply.status(204).send();
  });
}
