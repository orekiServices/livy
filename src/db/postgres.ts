import type { DatabaseAdapter } from './adapter.js';
import type { Playlist, Station, StreamSource } from '../types/index.js';

/**
 * PostgreSQL adapter (optional driver).
 *
 * Requires the `pg` package: `npm install pg`. Loaded lazily by the
 * adapter factory so the core server runs without it.
 *
 * Schema (run once):
 *   CREATE TABLE stations (id TEXT PRIMARY KEY, name TEXT NOT NULL,
 *     slug TEXT NOT NULL UNIQUE, description TEXT, stream_url TEXT,
 *     default_format TEXT NOT NULL DEFAULT 'mp3', metadata_title TEXT,
 *     categories JSONB NOT NULL DEFAULT '[]', enabled BOOLEAN NOT NULL
 *     DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
 *   CREATE TABLE stream_sources (id TEXT PRIMARY KEY,
 *     station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
 *     name TEXT NOT NULL, url TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'http',
 *     format TEXT NOT NULL DEFAULT 'unknown', priority INT NOT NULL DEFAULT 100,
 *     enabled BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL,
 *     updated_at TIMESTAMPTZ NOT NULL);
 *   CREATE TABLE playlists (id TEXT PRIMARY KEY,
 *     station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
 *     name TEXT NOT NULL, entries JSONB NOT NULL DEFAULT '[]',
 *     created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
 */

interface PgClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
}

function stationFromRow(r: Record<string, unknown>): Station {
  return {
    id: String(r.id),
    name: String(r.name),
    slug: String(r.slug),
    description: r.description ? String(r.description) : undefined,
    streamUrl: r.stream_url ? String(r.stream_url) : undefined,
    defaultFormat: String(r.default_format) as Station['defaultFormat'],
    metadataTitle: r.metadata_title ? String(r.metadata_title) : undefined,
    categories: (r.categories as string[]) ?? [],
    enabled: Boolean(r.enabled),
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString(),
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
    enabled: Boolean(r.enabled),
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString(),
  };
}

function playlistFromRow(r: Record<string, unknown>): Playlist {
  return {
    id: String(r.id),
    stationId: String(r.station_id),
    name: String(r.name),
    entries: (r.entries as Playlist['entries']) ?? [],
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString(),
  };
}

export class PostgresAdapter implements DatabaseAdapter {
  readonly name = 'postgres';
  private client: PgClient | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly poolSize: number,
  ) {}

  async connect(): Promise<void> {
    let pg: { Pool: new (config: Record<string, unknown>) => PgClient };
    try {
      // @ts-expect-error — optional peer dependency, installed by the user
      pg = (await import('pg')) as never;
    } catch {
      throw new Error('PostgreSQL adapter requires the "pg" package: npm install pg');
    }
    this.client = new pg.Pool({ connectionString: this.connectionString, max: this.poolSize });
  }

  async close(): Promise<void> {
    await this.client?.end();
    this.client = null;
  }

  async ping(): Promise<boolean> {
    if (!this.client) return false;
    await this.client.query('SELECT 1');
    return true;
  }

  private get conn(): PgClient {
    if (!this.client) throw new Error('Postgres adapter not connected');
    return this.client;
  }

  async createStation(station: Station): Promise<Station> {
    await this.conn.query(
      `INSERT INTO stations (id,name,slug,description,stream_url,default_format,metadata_title,categories,enabled,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [station.id, station.name, station.slug, station.description ?? null, station.streamUrl ?? null,
       station.defaultFormat, station.metadataTitle ?? null, JSON.stringify(station.categories),
       station.enabled, station.createdAt, station.updatedAt],
    );
    return { ...station };
  }

  async getStation(id: string): Promise<Station | null> {
    const { rows } = await this.conn.query('SELECT * FROM stations WHERE id = $1', [id]);
    return rows[0] ? stationFromRow(rows[0]) : null;
  }

  async getStationBySlug(slug: string): Promise<Station | null> {
    const { rows } = await this.conn.query('SELECT * FROM stations WHERE slug = $1', [slug]);
    return rows[0] ? stationFromRow(rows[0]) : null;
  }

  async listStations(): Promise<Station[]> {
    const { rows } = await this.conn.query('SELECT * FROM stations ORDER BY created_at ASC');
    return rows.map(stationFromRow);
  }

  async updateStation(id: string, patch: Partial<Station>): Promise<Station | null> {
    const cur = await this.getStation(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id, updatedAt: new Date().toISOString() };
    await this.conn.query(
      `UPDATE stations SET name=$1,slug=$2,description=$3,stream_url=$4,default_format=$5,metadata_title=$6,categories=$7,enabled=$8,updated_at=$9 WHERE id=$10`,
      [next.name, next.slug, next.description ?? null, next.streamUrl ?? null, next.defaultFormat,
       next.metadataTitle ?? null, JSON.stringify(next.categories), next.enabled, next.updatedAt, id],
    );
    return next;
  }

  async deleteStation(id: string): Promise<boolean> {
    const { rowCount } = await this.conn.query('DELETE FROM stations WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  async createSource(source: StreamSource): Promise<StreamSource> {
    await this.conn.query(
      `INSERT INTO stream_sources (id,station_id,name,url,type,format,priority,enabled,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [source.id, source.stationId, source.name, source.url, source.type, source.format,
       source.priority, source.enabled, source.createdAt, source.updatedAt],
    );
    return { ...source };
  }

  async getSource(id: string): Promise<StreamSource | null> {
    const { rows } = await this.conn.query('SELECT * FROM stream_sources WHERE id = $1', [id]);
    return rows[0] ? sourceFromRow(rows[0]) : null;
  }

  async listSources(stationId: string): Promise<StreamSource[]> {
    const { rows } = await this.conn.query(
      'SELECT * FROM stream_sources WHERE station_id = $1 ORDER BY priority ASC',
      [stationId],
    );
    return rows.map(sourceFromRow);
  }

  async updateSource(id: string, patch: Partial<StreamSource>): Promise<StreamSource | null> {
    const cur = await this.getSource(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id, updatedAt: new Date().toISOString() };
    await this.conn.query(
      `UPDATE stream_sources SET name=$1,url=$2,type=$3,format=$4,priority=$5,enabled=$6,updated_at=$7 WHERE id=$8`,
      [next.name, next.url, next.type, next.format, next.priority, next.enabled, next.updatedAt, id],
    );
    return next;
  }

  async deleteSource(id: string): Promise<boolean> {
    const { rowCount } = await this.conn.query('DELETE FROM stream_sources WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  async createPlaylist(playlist: Playlist): Promise<Playlist> {
    await this.conn.query(
      `INSERT INTO playlists (id,station_id,name,entries,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [playlist.id, playlist.stationId, playlist.name, JSON.stringify(playlist.entries), playlist.createdAt, playlist.updatedAt],
    );
    return { ...playlist };
  }

  async getPlaylist(id: string): Promise<Playlist | null> {
    const { rows } = await this.conn.query('SELECT * FROM playlists WHERE id = $1', [id]);
    return rows[0] ? playlistFromRow(rows[0]) : null;
  }

  async listPlaylists(stationId: string): Promise<Playlist[]> {
    const { rows } = await this.conn.query(
      'SELECT * FROM playlists WHERE station_id = $1 ORDER BY created_at ASC',
      [stationId],
    );
    return rows.map(playlistFromRow);
  }

  async updatePlaylist(id: string, patch: Partial<Playlist>): Promise<Playlist | null> {
    const cur = await this.getPlaylist(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id, updatedAt: new Date().toISOString() };
    await this.conn.query(
      `UPDATE playlists SET name=$1,entries=$2,updated_at=$3 WHERE id=$4`,
      [next.name, JSON.stringify(next.entries), next.updatedAt, id],
    );
    return next;
  }

  async deletePlaylist(id: string): Promise<boolean> {
    const { rowCount } = await this.conn.query('DELETE FROM playlists WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }
}
