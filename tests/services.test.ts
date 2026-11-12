import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/db/memory.js';
import { PlaylistService } from '../src/services/playlistService.js';
import { StationService } from '../src/services/stationService.js';
import { StreamService } from '../src/services/streamService.js';

describe('StationService', () => {
  it('creates, reads, updates and deletes stations', async () => {
    const svc = new StationService(new MemoryAdapter());
    const station = await svc.create({ name: 'My Radio' });
    expect(station.slug).toBe('my-radio');
    expect(await svc.get(station.id)).toMatchObject({ name: 'My Radio' });
    expect(await svc.get('my-radio')).toMatchObject({ id: station.id });

    const updated = await svc.update(station.id, { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');

    await svc.delete(station.id);
    await expect(svc.get(station.id)).rejects.toThrow(/not found/i);
  });

  it('rejects duplicate slugs', async () => {
    const svc = new StationService(new MemoryAdapter());
    await svc.create({ name: 'Same Name' });
    await expect(svc.create({ name: 'Same Name' })).rejects.toThrow(/already exists/i);
  });

  it('exports and imports a station with sources and playlists', async () => {
    const db = new MemoryAdapter();
    const stations = new StationService(db);
    const streams = new StreamService(db);
    const playlists = new PlaylistService(db);

    const station = await stations.create({ name: 'Export Me' });
    await streams.create(station.id, { name: 'Main', url: 'https://example.com/main.mp3' });
    await playlists.create(station.id, { name: 'List', entries: [{ title: 'T', url: 'https://example.com/t.mp3' }] });

    const exported = await stations.exportStation(station.id);
    expect(exported.sources).toHaveLength(1);
    expect(exported.playlists).toHaveLength(1);

    const result = await stations.importStation(exported);
    expect(result.sourcesImported).toBe(1);
    expect(result.playlistsImported).toBe(1);
    expect(result.stationId).not.toBe(station.id);
  });
});

describe('StreamService', () => {
  it('validates URLs and picks the primary source by priority', async () => {
    const db = new MemoryAdapter();
    const stations = new StationService(db);
    const streams = new StreamService(db);
    const station = await stations.create({ name: 'S' });

    await expect(streams.create(station.id, { name: 'Bad', url: 'not-a-url' })).rejects.toThrow(/Invalid stream URL/);

    await streams.create(station.id, { name: 'Low', url: 'https://example.com/low.mp3', priority: 200 });
    await streams.create(station.id, { name: 'High', url: 'https://example.com/high.mp3', priority: 10 });
    const primary = await streams.primarySource(station.id);
    expect(primary?.name).toBe('High');
  });
});

describe('PlaylistService', () => {
  it('imports and exports M3U', async () => {
    const db = new MemoryAdapter();
    const stations = new StationService(db);
    const playlists = new PlaylistService(db);
    const station = await stations.create({ name: 'S' });

    const imported = await playlists.importM3u(
      station.id,
      'Imported',
      '#EXTM3U\n#EXTINF:120,Artist - Song\nhttps://example.com/song.mp3\n',
      'https://example.com/',
    );
    expect(imported.entries).toHaveLength(1);
    expect(imported.entries[0].artist).toBe('Artist');

    const exported = await playlists.exportM3u(imported.id);
    expect(exported).toContain('Artist - Song');
  });
});
