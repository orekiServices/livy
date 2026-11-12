import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig } from './config.js';
import { createAdapter } from './db/index.js';
import type { DatabaseAdapter } from './db/index.js';
import { PlaylistService } from './services/playlistService.js';
import { PlaybackService } from './services/playbackService.js';
import { StationService } from './services/stationService.js';
import { StreamService } from './services/streamService.js';
import { registerErrorHandler } from './middleware/errorHandler.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerLavalinkRoutes } from './routes/lavalink.js';
import { registerPlaybackRoutes } from './routes/playback.js';
import { registerPlaylistRoutes } from './routes/playlists.js';
import { registerStationRoutes } from './routes/stations.js';
import { registerStreamRoutes } from './routes/streams.js';
import type { AppConfig } from './types/index.js';

export interface LivyApp {
  app: FastifyInstance;
  db: DatabaseAdapter;
  config: AppConfig;
  playback: PlaybackService;
  shutdown: () => Promise<void>;
}

/** Build a fully-wired Livy application (used by server and serverless). */
export async function buildApp(config: AppConfig = loadConfig()): Promise<LivyApp> {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
  });

  const db = await createAdapter(config);
  await db.connect();

  const stations = new StationService(db, undefined);
  const streams = new StreamService(db);
  const playlists = new PlaylistService(db);
  const playback = new PlaybackService(db, config, undefined);

  registerErrorHandler(app);

  await registerHealthRoutes(app, db, playback);
  await registerStationRoutes(app, stations, config.apiKey);
  await registerStreamRoutes(app, streams, config.apiKey);
  await registerPlaylistRoutes(app, playlists, config.apiKey);
  await registerPlaybackRoutes(app, playback, stations);
  if (config.lavalinkEnabled) {
    await registerLavalinkRoutes(app, db, config.lavalinkPassword);
  }

  app.get('/', async () => ({
    name: 'Livy',
    version: '1.0.0',
    docs: '/api/v1/stations',
    health: '/health',
  }));

  const shutdown = async (): Promise<void> => {
    playback.shutdown();
    await db.close();
    await app.close();
  };

  return { app, db, config, playback, shutdown };
}
