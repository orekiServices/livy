import type { DatabaseAdapter } from './adapter.js';
import type { Playlist, Station, StreamSource } from '../types/index.js';

/**
 * In-memory adapter. Used for development, tests and serverless
 * (Vercel) deployments where the filesystem is read-only.
 */
export class MemoryAdapter implements DatabaseAdapter {
  readonly name: string = 'memory';
  private stations = new Map<string, Station>();
  private sources = new Map<string, StreamSource>();
  private playlists = new Map<string, Playlist>();

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async ping(): Promise<boolean> {
    return true;
  }

  async createStation(station: Station): Promise<Station> {
    this.stations.set(station.id, { ...station });
    return { ...station };
  }
  async getStation(id: string): Promise<Station | null> {
    return this.stations.get(id) ?? null;
  }
  async getStationBySlug(slug: string): Promise<Station | null> {
    for (const s of this.stations.values()) if (s.slug === slug) return { ...s };
    return null;
  }
  async listStations(): Promise<Station[]> {
    return [...this.stations.values()].map((s) => ({ ...s }));
  }
  async updateStation(id: string, patch: Partial<Station>): Promise<Station | null> {
    const cur = this.stations.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id, updatedAt: new Date().toISOString() };
    this.stations.set(id, next);
    return { ...next };
  }
  async deleteStation(id: string): Promise<boolean> {
    if (!this.stations.delete(id)) return false;
    for (const [sid, src] of this.sources) if (src.stationId === id) this.sources.delete(sid);
    for (const [pid, pl] of this.playlists) if (pl.stationId === id) this.playlists.delete(pid);
    return true;
  }

  async createSource(source: StreamSource): Promise<StreamSource> {
    this.sources.set(source.id, { ...source });
    return { ...source };
  }
  async getSource(id: string): Promise<StreamSource | null> {
    return this.sources.get(id) ?? null;
  }
  async listSources(stationId: string): Promise<StreamSource[]> {
    return [...this.sources.values()]
      .filter((s) => s.stationId === stationId)
      .map((s) => ({ ...s }))
      .sort((a, b) => a.priority - b.priority);
  }
  async updateSource(id: string, patch: Partial<StreamSource>): Promise<StreamSource | null> {
    const cur = this.sources.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id, updatedAt: new Date().toISOString() };
    this.sources.set(id, next);
    return { ...next };
  }
  async deleteSource(id: string): Promise<boolean> {
    return this.sources.delete(id);
  }

  async createPlaylist(playlist: Playlist): Promise<Playlist> {
    this.playlists.set(playlist.id, { ...playlist });
    return { ...playlist };
  }
  async getPlaylist(id: string): Promise<Playlist | null> {
    return this.playlists.get(id) ?? null;
  }
  async listPlaylists(stationId: string): Promise<Playlist[]> {
    return [...this.playlists.values()]
      .filter((p) => p.stationId === stationId)
      .map((p) => ({ ...p }));
  }
  async updatePlaylist(id: string, patch: Partial<Playlist>): Promise<Playlist | null> {
    const cur = this.playlists.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id, updatedAt: new Date().toISOString() };
    this.playlists.set(id, next);
    return { ...next };
  }
  async deletePlaylist(id: string): Promise<boolean> {
    return this.playlists.delete(id);
  }
}
