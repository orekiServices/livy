import type { DatabaseAdapter } from './adapter.js';
import type { Playlist, Station, StreamSource } from '../types/index.js';

/**
 * MySQL adapter (optional driver).
 *
 * Requires the `mysql2` package: `npm install mysql2`. Loaded lazily
 * by the adapter factory so the core server runs without it.
 *
 * Schema (run once):
 *   CREATE TABLE stations (id VARCHAR(64) PRIMARY KEY, name VARCHAR(255) NOT NULL,
 *     slug VARCHAR(128) NOT NULL UNIQUE, description TEXT, stream_url VARCHAR(2048),
 *     default_format VARCHAR(16) NOT NULL DEFAULT 'mp3', metadata_title VARCHAR(512),
 *     categories JSON NOT NULL, enabled TINYINT(1) NOT NULL DEFAULT 1,
 *     created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL);
 *   CREATE TABLE stream_sources (id VARCHAR(64) PRIMARY KEY,
 *     station_id VARCHAR(64) NOT NULL, name VARCHAR(255) NOT NULL,
 *     url VARCHAR(2048) NOT NULL, type VARCHAR(16) NOT NULL DEFAULT 'http',
 *     format VARCHAR(16) NOT NULL DEFAULT 'unknown', priority INT NOT NULL DEFAULT 100,
 *     enabled TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL,
 *     updated_at DATETIME NOT NULL,
 *     FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE);
 *   CREATE TABLE playlists (id VARCHAR(64) PRIMARY KEY,
 *     station_id VARCHAR(64) NOT NULL, name VARCHAR(255) NOT NULL,
 *     entries JSON NOT NULL, created_at DATETIME NOT NULL,
 *     updated_at DATETIME NOT NULL,
 *     FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE);
 */

interface MysqlPool {
  query(sql: string, params?: unknown[]): Promise<[Record<string, unknown>[], unknown]>;
  end(): Promise<void>;
}

function stationFromRow(r: Record<string, unknown>): Station {
  const categories = typeof r.categories === 'string' ? JSON.parse(r.categories) : (r.categories as string[]);
  return {
    id: String(r.id),
    name: String(r.name),
    slug: String(r.slug),
    description: r.description ? String(r.description) : undefined,
    streamUrl: r.stream_url ? String(r.stream_url) : undefined,
    defaultFormat: String(r.default_format) as Station['defaultFormat'],
    metadataTitle: r.metadata_title ? String(r.metadata_title) : undefined,
    categories: categories ?? [],
    enabled: Number(r.enabled) === 1,
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
    enabled: Number(r.enabled) === 1,
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString(),
  };
}

function playlistFromRow(r: Record<string, unknown>): Playlist {
  const entries = typeof r.entries === 'string' ? JSON.parse(r.entries) : (r.entries as Playlist['entries']);
  return {
    id: String(r.id),
    stationId: String(r.station_id),
    name: String(r.name),
    entries: entries ?? [],
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString(),
  };
}

export class MysqlAdapter implements DatabaseAdapter {
  readonly name = 'mysql';
  private pool: MysqlPool | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly poolSize: number,
  ) {}

  async connect(): Promise<void> {
    let mysql2: { createPool: (config: Record<string, unknown>) => MysqlPool };
    try {
      // @ts-expect-error — optional peer dependency, installed by the user
      mysql2 = (await import('mysql2/promise')) as never;
    } catch {
      throw new Error('MySQL adapter requires the "mysql2" package: npm install mysql2');
    }
    this.pool = mysql2.createPool({ uri: this.connectionString, connectionLimit: this.poolSize });
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  async ping(): Promise<boolean> {
    if (!this.pool) return false;
    await this.pool.query('SELECT 1');
    return true;
  }

  private get conn(): MysqlPool {
    if (!this.pool) throw new Error('MySQL adapter not connected');
    return this.pool;
  }

  async createStation(station: Station): Promise<Station> {
    await this.conn.query(
      `INSERT INTO stations (id,name,slug,description,stream_url,default_format,metadata_title,categories,enabled,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [station.id, station.name, station.slug, station.description ?? null, station.streamUrl ?? null,
       station.defaultFormat, station.metadataTitle ?? null, JSON.stringify(station.categories),
       station.enabled ? 1 : 0, station.createdAt, station.updatedAt],
    );
    return { ...station };
  }

  async getStation(id: string): Promise<Station | null> {
    const [rows] = await this.conn.query('SELECT * FROM stations WHERE id = ?', [id]);
    return rows[0] ? stationFromRow(rows[0]) : null;
  }

  async getStationBySlug(slug: string): Promise<Station | null> {
    const [rows] = await this.conn.query('SELECT * FROM stations WHERE slug = ?', [slug]);
    return rows[0] ? stationFromRow(rows[0]) : null;
  }

  async listStations(): Promise<Station[]> {
    const [rows] = await this.conn.query('SELECT * FROM stations ORDER BY created_at ASC');
    return rows.map(stationFromRow);
  }

  async updateStation(id: string, patch: Partial<Station>): Promise<Station | null> {
    const cur = await this.getStation(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id, updatedAt: new Date().toISOString() };
    await this.conn.query(
      `UPDATE stations SET name=?,slug=?,description=?,stream_url=?,default_format=?,metadata_title=?,categories=?,enabled=?,updated_at=? WHERE id=?`,
      [next.name, next.slug, next.description ?? null, next.streamUrl ?? null, next.defaultFormat,
       next.metadataTitle ?? null, JSON.stringify(next.categories), next.enabled ? 1 : 0, next.updatedAt, id],
    );
    return next;
  }

  async deleteStation(id: string): Promise<boolean> {
    const [result] = await this.conn.query('DELETE FROM stations WHERE id = ?', [id]) as unknown as [
      Record<string, unknown>[],
      unknown,
    ];
    return Number((result as unknown as { affectedRows?: number }).affectedRows ?? 0) > 0;
  }

  async createSource(source: StreamSource): Promise<StreamSource> {
    await this.conn.query(
      `INSERT INTO stream_sources (id,station_id,name,url,type,format,priority,enabled,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [source.id, source.stationId, source.name, source.url, source.type, source.format,
       source.priority, source.enabled ? 1 : 0, source.createdAt, source.updatedAt],
    );
    return { ...source };
  }

  async getSource(id: string): Promise<StreamSource | null> {
    const [rows] = await this.conn.query('SELECT * FROM stream_sources WHERE id = ?', [id]);
    return rows[0] ? sourceFromRow(rows[0]) : null;
  }

  async listSources(stationId: string): Promise<StreamSource[]> {
    const [rows] = await this.conn.query(
      'SELECT * FROM stream_sources WHERE station_id = ? ORDER BY priority ASC',
      [stationId],
    );
    return rows.map(sourceFromRow);
  }

  async updateSource(id: string, patch: Partial<StreamSource>): Promise<StreamSource | null> {
    const cur = await this.getSource(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id, updatedAt: new Date().toISOString() };
    await this.conn.query(
      `UPDATE stream_sources SET name=?,url=?,type=?,format=?,priority=?,enabled=?,updated_at=? WHERE id=?`,
      [next.name, next.url, next.type, next.format, next.priority, next.enabled ? 1 : 0, next.updatedAt, id],
    );
    return next;
  }

  async deleteSource(id: string): Promise<boolean> {
    const [result] = (await this.conn.query('DELETE FROM stream_sources WHERE id = ?', [id])) as unknown as [
      Record<string, unknown>[],
      unknown,
    ];
    return Number((result as unknown as { affectedRows?: number }).affectedRows ?? 0) > 0;
  }

  async createPlaylist(playlist: Playlist): Promise<Playlist> {
    await this.conn.query(
      `INSERT INTO playlists (id,station_id,name,entries,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
      [playlist.id, playlist.stationId, playlist.name, JSON.stringify(playlist.entries), playlist.createdAt, playlist.updatedAt],
    );
    return { ...playlist };
  }

  async getPlaylist(id: string): Promise<Playlist | null> {
    const [rows] = await this.conn.query('SELECT * FROM playlists WHERE id = ?', [id]);
    return rows[0] ? playlistFromRow(rows[0]) : null;
  }

  async listPlaylists(stationId: string): Promise<Playlist[]> {
    const [rows] = await this.conn.query(
      'SELECT * FROM playlists WHERE station_id = ? ORDER BY created_at ASC',
      [stationId],
    );
    return rows.map(playlistFromRow);
  }

  async updatePlaylist(id: string, patch: Partial<Playlist>): Promise<Playlist | null> {
    const cur = await this.getPlaylist(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id, updatedAt: new Date().toISOString() };
    await this.conn.query(
      `UPDATE playlists SET name=?,entries=?,updated_at=? WHERE id=?`,
      [next.name, JSON.stringify(next.entries), next.updatedAt, id],
    );
    return next;
  }

  async deletePlaylist(id: string): Promise<boolean> {
    const [result] = (await this.conn.query('DELETE FROM playlists WHERE id = ?', [id])) as unknown as [
      Record<string, unknown>[],
      unknown,
    ];
    return Number((result as unknown as { affectedRows?: number }).affectedRows ?? 0) > 0;
  }
}
