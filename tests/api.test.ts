import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp, type LivyApp } from '../src/server.js';

let ctx: LivyApp;
let stationId: string;

beforeAll(async () => {
  ctx = await buildApp(loadConfig({ DB_TYPE: 'memory', LOG_LEVEL: 'silent' }));
});

afterAll(async () => {
  await ctx.shutdown();
});

describe('Livy HTTP API', () => {
  it('serves health and root', async () => {
    const health = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok' });

    const root = await ctx.app.inject({ method: 'GET', url: '/' });
    expect(root.json()).toMatchObject({ name: 'Livy' });
  });

  it('creates and lists stations', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/stations',
      payload: { name: 'API Station', defaultFormat: 'mp3' },
    });
    expect(res.statusCode).toBe(201);
    stationId = res.json().id;

    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/stations' });
    expect(list.json()).toHaveLength(1);
  });

  it('rejects invalid station payloads', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/stations', payload: { name: '' } });
    expect(res.statusCode).toBe(400);
  });

  it('manages stream sources per station', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/stations/${stationId}/sources`,
      payload: { name: 'Main', url: 'https://example.com/main.mp3', priority: 10 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ format: 'mp3', priority: 10 });

    const list = await ctx.app.inject({ method: 'GET', url: `/api/v1/stations/${stationId}/sources` });
    expect(list.json()).toHaveLength(1);
  });

  it('manages playlists and M3U import/export', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/stations/${stationId}/playlists`,
      payload: { name: 'Evening', entries: [{ title: 'Song', url: 'https://example.com/s.mp3' }] },
    });
    expect(created.statusCode).toBe(201);
    const playlistId = created.json().id;

    const exported = await ctx.app.inject({ method: 'GET', url: `/api/v1/playlists/${playlistId}/export-m3u` });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).toContain('#EXTM3U');
  });

  it('exports and imports station configuration', async () => {
    const exported = await ctx.app.inject({ method: 'GET', url: `/api/v1/stations/${stationId}/export` });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().sources).toHaveLength(1);

    const imported = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/stations/import',
      payload: exported.json(),
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({ sourcesImported: 1 });
  });

  it('returns 404 for unknown stations', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/stations/does-not-exist' });
    expect(res.statusCode).toBe(404);
  });

  it('serves Lavalink v4 compatibility endpoints', async () => {
    const info = await ctx.app.inject({ method: 'GET', url: '/v4/info' });
    expect(info.json()).toMatchObject({ isLivy: true });

    const loaded = await ctx.app.inject({
      method: 'GET',
      url: `/v4/loadtracks?identifier=${stationId}`,
      headers: { authorization: 'livy' },
    });
    expect(loaded.json()).toMatchObject({ loadType: 'track' });

    const search = await ctx.app.inject({
      method: 'GET',
      url: '/v4/loadtracks?identifier=livysearch:API',
      headers: { authorization: 'livy' },
    });
    expect(search.json().loadType).toBe('search');

    const unauthorized = await ctx.app.inject({ method: 'GET', url: `/v4/loadtracks?identifier=${stationId}` });
    expect(unauthorized.statusCode).toBe(401);
  });

  it('reports station status', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/stream/${stationId}/status` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stationId, online: false, listeners: 0 });
  });
});
