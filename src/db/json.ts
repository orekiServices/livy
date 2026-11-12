import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MemoryAdapter } from './memory.js';
import type { Playlist, Station, StreamSource } from '../types/index.js';

/**
 * JSON-file adapter. Persists the in-memory state to a single JSON file.
 * Suitable for small self-hosted deployments; use SQLite for larger ones.
 */
export class JsonAdapter extends MemoryAdapter {
  override readonly name = 'json';
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
  }

  override async connect(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw) as {
        stations: Station[];
        sources: StreamSource[];
        playlists: Playlist[];
      };
      for (const s of data.stations ?? []) await super.createStation(s);
      for (const s of data.sources ?? []) await super.createSource(s);
      for (const p of data.playlists ?? []) await super.createPlaylist(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  private async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const payload = {
        stations: await super.listStations(),
        sources: await this.collectSources(),
        playlists: await this.collectPlaylists(),
      };
      await writeFile(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
    });
    await this.writeChain;
  }

  private async collectSources(): Promise<StreamSource[]> {
    const stations = await super.listStations();
    const all: StreamSource[] = [];
    for (const st of stations) all.push(...(await super.listSources(st.id)));
    return all;
  }

  private async collectPlaylists(): Promise<Playlist[]> {
    const stations = await super.listStations();
    const all: Playlist[] = [];
    for (const st of stations) all.push(...(await super.listPlaylists(st.id)));
    return all;
  }

  override async createStation(s: Station): Promise<Station> {
    const out = await super.createStation(s);
    await this.persist();
    return out;
  }
  override async updateStation(id: string, patch: Partial<Station>): Promise<Station | null> {
    const out = await super.updateStation(id, patch);
    if (out) await this.persist();
    return out;
  }
  override async deleteStation(id: string): Promise<boolean> {
    const out = await super.deleteStation(id);
    if (out) await this.persist();
    return out;
  }
  override async createSource(s: StreamSource): Promise<StreamSource> {
    const out = await super.createSource(s);
    await this.persist();
    return out;
  }
  override async updateSource(id: string, patch: Partial<StreamSource>): Promise<StreamSource | null> {
    const out = await super.updateSource(id, patch);
    if (out) await this.persist();
    return out;
  }
  override async deleteSource(id: string): Promise<boolean> {
    const out = await super.deleteSource(id);
    if (out) await this.persist();
    return out;
  }
  override async createPlaylist(p: Playlist): Promise<Playlist> {
    const out = await super.createPlaylist(p);
    await this.persist();
    return out;
  }
  override async updatePlaylist(id: string, patch: Partial<Playlist>): Promise<Playlist | null> {
    const out = await super.updatePlaylist(id, patch);
    if (out) await this.persist();
    return out;
  }
  override async deletePlaylist(id: string): Promise<boolean> {
    const out = await super.deletePlaylist(id);
    if (out) await this.persist();
    return out;
  }
}
