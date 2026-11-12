/**
 * Vercel Serverless entry point.
 *
 * IMPORTANT: Vercel functions are stateless with a 60s max duration and
 * a read-only filesystem. Continuous radio streaming CANNOT run here.
 * This handler exposes only the stateless API surface (stations,
 * sources, playlists, Lavalink compat, health) backed by the in-memory
 * adapter. For live streaming (/stream/*), deploy the persistent
 * server (Deplexo / self-hosted Docker) and point listeners there.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

let cached: Awaited<ReturnType<typeof buildApp>> | null = null;

async function getApp(): Promise<Awaited<ReturnType<typeof buildApp>>> {
  if (!cached) {
    const config = loadConfig({ ...process.env, DB_TYPE: 'memory' });
    cached = await buildApp(config);
  }
  return cached;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Streaming endpoints are not supported in serverless — fail fast
  // with a clear message instead of timing out mid-stream.
  const url = req.url ?? '';
  if (url.startsWith('/stream/') || url.startsWith('/hls/')) {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'NOT_SUPPORTED_IN_SERVERLESS',
        message:
          'Live streaming requires a persistent server. Deploy Livy via Deplexo or Docker for /stream/* endpoints.',
      }),
    );
    return;
  }

  const { app } = await getApp();
  await app.routing(req, res);
}
