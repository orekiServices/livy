import { createServer, get as httpGet, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp, type LivyApp } from '../src/server.js';

/**
 * End-to-end streaming test: a local upstream HTTP server serves fake
 * MP3 bytes; Livy proxies them to listeners with ICY metadata.
 */
let upstream: Server;
let upstreamUrl: string;
let ctx: LivyApp;

beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.end(Buffer.alloc(4096, 0xff));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const addr = upstream.address();
  upstreamUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/stream.mp3`;

  ctx = await buildApp(loadConfig({ DB_TYPE: 'memory', LOG_LEVEL: 'silent' }));
});

afterAll(async () => {
  await ctx.shutdown();
  upstream.close();
});

describe('live streaming', () => {
  it('proxies upstream audio to listeners', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/stations',
      payload: { name: 'Live Station' },
    });
    const stationId = created.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/stations/${stationId}/sources`,
      payload: { name: 'Upstream', url: upstreamUrl },
    });

    await new Promise<void>((resolve, reject) => {
      const req = ctx.app.server.listen(0, '127.0.0.1', () => {
        const port = (ctx.app.server.address() as { port: number }).port;
        const http = require('node:http') as typeof import('node:http');
        http
          .get(`http://127.0.0.1:${port}/stream/${stationId}`, (res) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('audio/mpeg');
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
              resolve();
            });
          })
          .on('error', reject);
      });
      req.on('error', reject);
    });
  });
});
