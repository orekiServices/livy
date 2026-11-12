import { z } from 'zod';
import type { AppConfig } from './types/index.js';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.string().default('development'),
  API_KEY: z.string().optional(),
  DB_TYPE: z.enum(['memory', 'json', 'sqlite', 'postgres', 'mysql']).default('memory'),
  DB_URL: z.string().default('./data/livy.db'),
  DB_POOL_SIZE: z.coerce.number().int().min(1).default(10),
  STREAM_DEFAULT_FORMAT: z.enum(['mp3', 'flac', 'ogg', 'aac', 'hls', 'unknown']).default('mp3'),
  STREAM_MAX_LISTENERS_PER_STATION: z.coerce.number().int().min(1).default(1000),
  STREAM_BUFFER_SIZE: z.coerce.number().int().min(1024).default(65536),
  STREAM_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),
  LAVALINK_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  LAVALINK_PASSWORD: z.string().default('livy'),
  LOG_LEVEL: z.string().default('info'),
});

/** Load and validate configuration from environment variables. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  return {
    port: parsed.PORT,
    host: parsed.HOST,
    nodeEnv: parsed.NODE_ENV,
    apiKey: parsed.API_KEY || undefined,
    dbType: parsed.DB_TYPE,
    dbUrl: parsed.DB_URL,
    dbPoolSize: parsed.DB_POOL_SIZE,
    streamDefaultFormat: parsed.STREAM_DEFAULT_FORMAT,
    streamMaxListenersPerStation: parsed.STREAM_MAX_LISTENERS_PER_STATION,
    streamBufferSize: parsed.STREAM_BUFFER_SIZE,
    streamConnectTimeoutMs: parsed.STREAM_CONNECT_TIMEOUT_MS,
    lavalinkEnabled: parsed.LAVALINK_ENABLED,
    lavalinkPassword: parsed.LAVALINK_PASSWORD,
    logLevel: parsed.LOG_LEVEL,
  };
}
