import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonAdapter } from '../src/db/json.js';
import { MemoryAdapter } from '../src/db/memory.js';
import { SqliteAdapter } from '../src/db/sqlite.js';
import type { DatabaseAdapter } from '../src/db/adapter.js';
import type { Station } from '../src/types/index.js';

function sampleStation(id = 'st-1'): Station {
  return {
    id,
    name: 'Test Station',
    slug: 'test-station',
    defaultFormat: 'mp3',
    categories: [],
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function runAdapterContract(make: () => DatabaseAdapter): Promise<void> {
  const db = make();
  await db.connect();
  const station = await db.createStation(sampleStation());
  expect(await db.getStation(station.id)).toMatchObject({ slug: 'test-station' });
  expect(await db.getStationBySlug('test-station')).not.toBeNull();

  const source = await db.createSource({
    id: 'src-1',
    stationId: station.id,
    name: 'Primary',
    url: 'https://example.com/stream.mp3',
    type: 'http',
    format: 'mp3',
    priority: 100,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  expect(await db.listSources(station.id)).toHaveLength(1);
  expect((await db.updateSource(source.id, { priority: 1 }))?.priority).toBe(1);

  const playlist = await db.createPlaylist({
    id: 'pl-1',
    stationId: station.id,
    name: 'Morning',
    entries: [{ id: 'e-1', title: 'Song', url: 'https://example.com/s.mp3' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  expect((await db.getPlaylist(playlist.id))?.entries).toHaveLength(1);

  expect(await db.ping()).toBe(true);
  expect(await db.deletePlaylist(playlist.id)).toBe(true);
  expect(await db.deleteSource(source.id)).toBe(true);
  expect(await db.deleteStation(station.id)).toBe(true);
  expect(await db.getStation(station.id)).toBeNull();
  await db.close();
}

describe('database adapters', () => {
  it('memory adapter satisfies the contract', async () => {
    await runAdapterContract(() => new MemoryAdapter());
  });

  it('sqlite adapter satisfies the contract', async () => {
    await runAdapterContract(() => new SqliteAdapter(':memory:'));
  });

  it('json adapter persists across reconnects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'livy-'));
    const file = join(dir, 'livy.json');
    const db = new JsonAdapter(file);
    await db.connect();
    await db.createStation(sampleStation());
    await db.close();

    const reopened = new JsonAdapter(file);
    await reopened.connect();
    expect(await reopened.getStationBySlug('test-station')).not.toBeNull();
    const raw = JSON.parse(await readFile(file, 'utf8')) as { stations: Station[] };
    expect(raw.stations).toHaveLength(1);
    await reopened.close();
  });

  it('sqlite cascades station deletion to sources', async () => {
    const db = new SqliteAdapter(':memory:');
    await db.connect();
    const station = await db.createStation(sampleStation());
    await db.createSource({
      id: 'src-1',
      stationId: station.id,
      name: 'Primary',
      url: 'https://example.com/stream.mp3',
      type: 'http',
      format: 'mp3',
      priority: 100,
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await db.deleteStation(station.id);
    expect(await db.listSources(station.id)).toHaveLength(0);
    await db.close();
  });
});
