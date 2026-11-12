import type { Playlist, Station, StreamSource } from '../types/index.js';

/**
 * Unified database adapter interface.
 *
 * All persistence in Livy goes through this interface. Database-specific
 * behaviour (connection strings, pooling, SQL dialect) stays inside the
 * concrete drivers, never leaking into services or routes.
 */
export interface DatabaseAdapter {
  /** Driver name, e.g. "memory", "sqlite". */
  readonly name: string;

  /** Open the connection / load persisted state. */
  connect(): Promise<void>;
  /** Flush and close resources. */
  close(): Promise<void>;
  /** Liveness check used by /ready. */
  ping(): Promise<boolean>;

  // --- Stations ---
  createStation(station: Station): Promise<Station>;
  getStation(id: string): Promise<Station | null>;
  getStationBySlug(slug: string): Promise<Station | null>;
  listStations(): Promise<Station[]>;
  updateStation(id: string, patch: Partial<Station>): Promise<Station | null>;
  deleteStation(id: string): Promise<boolean>;

  // --- Stream sources (scoped to a station) ---
  createSource(source: StreamSource): Promise<StreamSource>;
  getSource(id: string): Promise<StreamSource | null>;
  listSources(stationId: string): Promise<StreamSource[]>;
  updateSource(id: string, patch: Partial<StreamSource>): Promise<StreamSource | null>;
  deleteSource(id: string): Promise<boolean>;

  // --- Playlists (scoped to a station) ---
  createPlaylist(playlist: Playlist): Promise<Playlist>;
  getPlaylist(id: string): Promise<Playlist | null>;
  listPlaylists(stationId: string): Promise<Playlist[]>;
  updatePlaylist(id: string, patch: Partial<Playlist>): Promise<Playlist | null>;
  deletePlaylist(id: string): Promise<boolean>;
}
