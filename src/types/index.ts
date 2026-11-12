/**
 * Livy domain types.
 *
 * A Station is an independent radio channel. Each station owns its own
 * stream sources, playlists and playback state, so stations never
 * interfere with each other.
 */

export type StreamFormat = 'mp3' | 'flac' | 'ogg' | 'aac' | 'hls' | 'unknown';
export type StreamSourceType = 'http' | 'hls' | 'file' | 'rtmp';

export interface StreamSource {
  id: string;
  stationId: string;
  /** Display name, e.g. "Primary encoder". */
  name: string;
  /** Source URL (http/https/file). */
  url: string;
  type: StreamSourceType;
  format: StreamFormat;
  /** Lower number = higher priority. */
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Station {
  id: string;
  name: string;
  slug: string;
  description?: string;
  /** Public stream URL exposed to listeners (derived if omitted). */
  streamUrl?: string;
  /** Default output format for listeners. */
  defaultFormat: StreamFormat;
  /** ICY metadata title shown to players. */
  metadataTitle?: string;
  /** Categories for future extensions (permissions, schedules, analytics). */
  categories: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlaylistEntry {
  id: string;
  title: string;
  url: string;
  duration?: number;
  artist?: string;
}

export interface Playlist {
  id: string;
  stationId: string;
  name: string;
  entries: PlaylistEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface StationStatus {
  stationId: string;
  online: boolean;
  listeners: number;
  currentSourceId?: string;
  currentSourceUrl?: string;
  bitrate?: number;
  format?: StreamFormat;
  uptimeMs: number;
  lastError?: string;
}

export interface CreateStationInput {
  name: string;
  slug?: string;
  description?: string;
  streamUrl?: string;
  defaultFormat?: StreamFormat;
  metadataTitle?: string;
  categories?: string[];
  enabled?: boolean;
}

export interface UpdateStationInput extends Partial<CreateStationInput> {}

export interface CreateStreamSourceInput {
  name: string;
  url: string;
  type?: StreamSourceType;
  format?: StreamFormat;
  priority?: number;
  enabled?: boolean;
}

export interface UpdateStreamSourceInput extends Partial<CreateStreamSourceInput> {}

export interface CreatePlaylistInput {
  name: string;
  entries?: Array<{ title: string; url: string; duration?: number; artist?: string }>;
}

export interface StationExport {
  version: 1;
  exportedAt: string;
  station: Station;
  sources: StreamSource[];
  playlists: Playlist[];
}

export interface ImportResult {
  stationId: string;
  sourcesImported: number;
  playlistsImported: number;
}

/** Lavalink v4 compatible track shape (subset used by Livy). */
export interface LavalinkTrackInfo {
  identifier: string;
  isSeekable: boolean;
  author: string;
  length: number;
  isStream: boolean;
  position: number;
  title: string;
  uri?: string;
  artworkUrl?: string;
  isrc?: string;
  sourceName: string;
}

export interface LavalinkTrack {
  encoded: string;
  info: LavalinkTrackInfo;
  pluginInfo: Record<string, unknown>;
  userData: Record<string, unknown>;
}

export type LoadType = 'track' | 'playlist' | 'search' | 'empty' | 'error';

export interface LoadResult {
  loadType: LoadType;
  data: LavalinkTrack | LavalinkTrack[] | { info: { name: string; selectedTrack: number }; tracks: LavalinkTrack[] } | { message: string; severity: string };
}

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: string;
  apiKey?: string;
  dbType: 'memory' | 'json' | 'sqlite' | 'postgres' | 'mysql';
  dbUrl: string;
  dbPoolSize: number;
  streamDefaultFormat: StreamFormat;
  streamMaxListenersPerStation: number;
  streamBufferSize: number;
  streamConnectTimeoutMs: number;
  lavalinkEnabled: boolean;
  lavalinkPassword: string;
  logLevel: string;
}
