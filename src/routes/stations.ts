import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StationService } from '../services/stationService.js';
import { apiKeyAuth } from '../middleware/auth.js';
import { ValidationError } from '../utils/errors.js';

const createStationSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(64).optional(),
  description: z.string().max(2000).optional(),
  streamUrl: z.string().url().optional(),
  defaultFormat: z.enum(['mp3', 'flac', 'ogg', 'aac', 'hls', 'unknown']).optional(),
  metadataTitle: z.string().max(200).optional(),
  categories: z.array(z.string().max(64)).max(32).optional(),
  enabled: z.boolean().optional(),
});

const updateStationSchema = createStationSchema.partial();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ValidationError(result.error.issues.map((i) => i.message).join('; '));
  return result.data;
}

export async function registerStationRoutes(
  app: FastifyInstance,
  stations: StationService,
  apiKey: string | undefined,
): Promise<void> {
  const auth = { preHandler: apiKeyAuth(apiKey) };

  app.post('/api/v1/stations', auth, async (req, reply) => {
    const station = await stations.create(parse(createStationSchema, req.body));
    return reply.status(201).send(station);
  });

  app.get('/api/v1/stations', async () => stations.list());

  app.get('/api/v1/stations/:id', async (req) => stations.get((req.params as { id: string }).id));

  app.patch('/api/v1/stations/:id', auth, async (req) =>
    stations.update((req.params as { id: string }).id, parse(updateStationSchema, req.body)),
  );

  app.delete('/api/v1/stations/:id', auth, async (req, reply) => {
    await stations.delete((req.params as { id: string }).id);
    return reply.status(204).send();
  });

  app.get('/api/v1/stations/:id/export', async (req) => stations.exportStation((req.params as { id: string }).id));

  app.post('/api/v1/stations/import', auth, async (req, reply) => {
    const result = await stations.importStation(req.body as never);
    return reply.status(201).send(result);
  });
}
