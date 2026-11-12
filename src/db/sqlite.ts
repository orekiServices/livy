import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
// node:sqlite is built into Node.js >= 22 — no extra dependency required.
import { DatabaseSync } from 'node:sqlite';
import type { DatabaseAdapter } from './adapter.js';
import type { Playlist, Station, StreamSource } from '../types/index.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  stream_url TEXT,
  default_format TEXT NOT NULL DEFAULT 'mp3',
  metadata_title TEXT,
  categories TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stream_sources (
  id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'http',
  format TEXT NOT NULL DEFAULT 'unknown',
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  entries TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function stationFromRow(r: Record<string, unknown>): Station {
  return {
    id: String(r.id),
    name: String(r.name),
    slug: String(r.slug),
    description: r.description ? String(r.description) : undefined,
    streamUrl: r.stream_url ? String(r.stream_url) : undefined,
    defaultFormat: String(r.default_format) as Station['defaultFormat'],
    metadataTitle: r.metadata_title ? String(r.metadata_title) : undefined,
    categories: JSON.parse(String(r.categories ?? '[]')) as string[],
    enabled: Number(r.enabled) === 1,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function sourceFromRow(r: Record<string, unknown>): StreamSource {
  return {
    id: String(r.id),
    stationId: String(r.station_id),
    name: String(r.name),
    url: String(r.url),
    type: String(r.type) as StreamSource['type'],
    format: String(r.format) as StreamSource['format'],
    priority: Number(r.priority),
    enabled: Number(r.enabled) === 1,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function playlistFromRow(r: Record<string, unknown>): Playlist {
  return {
    id: String(r.id),
    stationId: String(r.station_id),
    name: String(r.name),
    entries: JSON.parse(String(r.entries ?? '[]')),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/**
 * SQLite adapter using Node's built-in node:sqlite (synchronous API
 * wrapped in async methods). WAL mode + foreign keys for safe concurrent
 * access from the single Node process.
 */
export class SqliteAdapter implements DatabaseAdapter {
  readonly name = 'sqlite';
  private db: DatabaseSync | null = null;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async connect(): Promise<void> {
    if (this.filePath !== ':memory:') {
      mkdirSync(dirname(this.filePath), { recursive: true });
    }
    this.db = new DatabaseSync(this.filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  async ping(): Promise<boolean> {
    if (!this.db) return false;
    this.db.prepare('SELECT 1').get();
    return true;
  }

  private get conn(): DatabaseSync {
    if (!this.db) throw new Error('SQLite adapter not connected');
    return this.db;
  }

  async createStation(station: Station): Promise<Station> {
    this.conn
      .prepare(
        `INSERT INTO stations (id,name,slug,description,stream_url,default_format,metadata_title,categories,enabled,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        station.id,
        station.name,
        station.slug,
        station.description ?? null,
        station.streamUrl ?? null,
        station.defaultFormat,
        station.metadataTitle ?? null,
        JSON.stringify(station.categories),
        station.enabled ? 1 : 0,
        station.createdAt,
        station.updatedAt,
      );
    return { ...station };
  }

  async getStation(id: string): Promise<Station | null> {
    const row = this.conn.prepare('SELECT * FROM stations WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? stationFromRow(row) : null;
  }

  async getStationBySlug(slug: string): Promise<Station | null> {
    const row = this.conn.prepare('SELECT * FROM stations WHERE slug = ?').get(slug) as
      | Record<string, unknown>
      | undefined;
    return row ? stationFromRow(row) : null;
  }

  async listStations(): Promise<Station[]> {
    const rows = this.conn.prepare('SELECT * FROM stations ORDER BY created_at ASC').all() as Record<string, unknown>[];
    return rows.map(stationFromRow);
  }

  async updateStation(id: string, patch: Partial<Station>): Promise<Station | null> {
    const cur = await this.getStation(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id, updatedAt: new Date().toISOString() };
    this.conn
      .prepare(
        `UPDATE stations SET name=?,slug=?,description=?,stream_url=?,default_format=?,metadata_title=?,categories=?,enabled=?,updated_at=? WHERE id=?`,
      )
      .run(
        next.name,
        next.slug,
        next.description ?? null,
        next.streamUrl ?? null,
        next.defaultFormat,
        next.metadataTitle ?? null,
        JSON.stringify(next.categories),
        next.enabled ? 1 : 0,
        next.updatedAt,
        id,
      );
    return next;
  }

  async deleteStation(id: string): Promise<boolean> {
    const res = this.conn.prepare('DELETE FROM stations WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  async createSource(source: StreamSource): Promise<StreamSource> {
    this.conn
      .prepare(
        `INSERT INTO stream_sources (id,station_id,name,url,type,format,priority,enabled,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        source.id,
        source.stationId,
        source.name,
        source.url,
        source.type,
        source.format,
        source.priority,
        source.enabled ? 1 : 0,
        source.createdAt,
        source.updatedAt,
      );
    return { ...source };
  }

  async getSource(id: string): Promise<StreamSource | null> {
    const row = this.conn.prepare('SELECT * FROM stream_sources WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? sourceFromRow(row) : null;
  }

  async listSources(stationId: string): Promise<StreamSource[]> {
    const rows = this.conn
      .prepare('SELECT * FROM stream_sources WHERE station_id = ? ORDER BY priority ASC')
      .all(stationId) as Record<string, unknown>[];
    return rows.map(sourceFromRow);
  }

  async updateSource(id: string, patch: Partial<StreamSource>): Promise<StreamSource | null> {
    const cur = await this.getSource(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id, updatedAt: new Date().toISOString() };
    this.conn
      .prepare(
        `UPDATE stream_sources SET name=?,url=?,type=?,format=?,priority=?,enabled=?,updated_at=? WHERE id=?`,
      )
      .run(next.name, next.url, next.type, next.format, next.priority, next.enabled ? 1 : 0, next.updatedAt, id);
    return next;
  }

  async deleteSource(id: string): Promise<boolean> {
    const res = this.conn.prepare('DELETE FROM stream_sources WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  async createPlaylist(playlist: Playlist): Promise<Playlist> {
    this.conn
      .prepare(`INSERT INTO playlists (id,station_id,name,entries,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .run(playlist.id, playlist.stationId, playlist.name, JSON.stringify(playlist.entries), playlist.createdAt, playlist.updatedAt);
    return { ...playlist };
  }

  async getPlaylist(id: string): Promise<Playlist | null> {
    const row = this.conn.prepare('SELECT * FROM playlists WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? playlistFromRow(row) : null;
  }

  async listPlaylists(stationId: string): Promise<Playlist[]> {
    const rows = this.conn
      .prepare('SELECT * FROM playlists WHERE station_id = ? ORDER BY created_at ASC')
      .all(stationId) as Record<string, unknown>[];
    return rows.map(playlistFromRow);
  }

  async updatePlaylist(id: string, patch: Partial<Playlist>): Promise<Playlist | null> {
    const cur = await this.getPlaylist(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id, updatedAt: new Date().toISOString() };
    this.conn
      .prepare(`UPDATE playlists SET name=?,entries=?,updated_at=? WHERE id=?`)
      .run(next.name, JSON.stringify(next.entries), next.updatedAt, id);
    return next;
  }

  async deletePlaylist(id: string): Promise<boolean> {
    const res = this.conn.prepare('DELETE FROM playlists WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }
}
