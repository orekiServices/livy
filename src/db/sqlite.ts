import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ConflictError, NotFoundError } from "../errors.js";
import type {
	CreatePlaylistInput,
	CreateStationInput,
	CreateStreamSourceInput,
	Playlist,
	Station,
	StreamSource,
	UpdateStationInput,
	UpdateStreamSourceInput,
} from "../types.js";
import { newId, nowIso } from "./adapter.js";
import type { DatabaseAdapter } from "./adapter.js";

/**
 * SQLite adapter using Bun's built-in `bun:sqlite` (zero dependencies,
 * synchronous API wrapped in async methods). For Node.js runtime use the
 * memory adapter or postgres adapter instead.
 *
 * Schema is created idempotently on init. All queries are parameterised.
 */

type BunDatabase = {
	query(sql: string): {
		all(...params: unknown[]): Record<string, unknown>[];
		get(...params: unknown[]): Record<string, unknown> | null;
		run(...params: unknown[]): { changes: number };
	};
	run(sql: string, ...params: unknown[]): { changes: number };
	close(): void;
	transaction<T>(fn: () => T): () => T;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  stream_url TEXT,
  fallback_urls TEXT NOT NULL DEFAULT '[]',
  cover_url TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  is_public INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'idle',
  listener_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stream_sources (
  id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'http',
  codec TEXT NOT NULL DEFAULT 'unknown',
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  now_playing TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stream_sources_station ON stream_sources(station_id);
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  entries TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_playlists_station ON playlists(station_id);
`;

function parseJson<T>(value: unknown, fallback: T): T {
	if (typeof value !== "string") return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function rowToStation(row: Record<string, unknown>): Station {
	return {
		id: String(row.id),
		name: String(row.name),
		slug: String(row.slug),
		description: (row.description as string | null) ?? null,
		streamUrl: (row.stream_url as string | null) ?? null,
		fallbackUrls: parseJson(row.fallback_urls, []),
		coverUrl: (row.cover_url as string | null) ?? null,
		tags: parseJson(row.tags, []),
		isPublic: Number(row.is_public) === 1,
		status: (row.status as Station["status"]) ?? "idle",
		listenerCount: Number(row.listener_count) ?? 0,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

function rowToStream(row: Record<string, unknown>): StreamSource {
	return {
		id: String(row.id),
		stationId: String(row.station_id),
		name: String(row.name),
		url: String(row.url),
		protocol: (row.protocol as StreamSource["protocol"]) ?? "http",
		codec: (row.codec as StreamSource["codec"]) ?? "unknown",
		priority: Number(row.priority) ?? 100,
		enabled: Number(row.enabled) === 1,
		nowPlaying: (row.now_playing as string | null) ?? null,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

function rowToPlaylist(row: Record<string, unknown>): Playlist {
	return {
		id: String(row.id),
		stationId: String(row.station_id),
		name: String(row.name),
		entries: parseJson(row.entries, []),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

export class SqliteAdapter implements DatabaseAdapter {
	readonly type = "sqlite" as const;
	ready = false;

	private db: BunDatabase | null = null;
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	async init(): Promise<void> {
		// Dynamic import keeps this module loadable under Node (where
		// bun:sqlite does not exist) — init() will throw a clear error.
		const mod = (await import("bun:sqlite")) as {
			Database: new (path: string) => BunDatabase;
		};
		const dir = dirname(this.path);
		if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
		this.db = new mod.Database(this.path);
		this.db.run("PRAGMA journal_mode = WAL");
		this.db.run("PRAGMA foreign_keys = ON");
		this.db.run(SCHEMA);
		this.ready = true;
	}

	async close(): Promise<void> {
		this.db?.close();
		this.db = null;
		this.ready = false;
	}

	async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
		const start = performance.now();
		try {
			this.requireDb().query("SELECT 1 AS one").get();
			return { ok: true, latencyMs: performance.now() - start };
		} catch {
			return { ok: false, latencyMs: performance.now() - start };
		}
	}

	private requireDb(): BunDatabase {
		if (!this.db) throw new Error("SQLite adapter not initialised — call init() first");
		return this.db;
	}

	private requireStation(stationId: string): void {
		const row = this.requireDb().query("SELECT id FROM stations WHERE id = ?").get(stationId);
		if (!row) throw new NotFoundError("Station", stationId);
	}

	// ── Stations ──────────────────────────────────────────────────────────

	async listStations(opts?: {
		page?: number;
		pageSize?: number;
		search?: string;
	}): Promise<{ items: Station[]; total: number }> {
		const db = this.requireDb();
		const page = opts?.page ?? 1;
		const pageSize = opts?.pageSize ?? 50;
		const offset = (page - 1) * pageSize;
		if (opts?.search) {
			const like = `%${opts.search}%`;
			const totalRow = db
				.query("SELECT COUNT(*) AS c FROM stations WHERE name LIKE ? OR slug LIKE ?")
				.get(like, like) as { c: number };
			const rows = db
				.query(
					"SELECT * FROM stations WHERE name LIKE ? OR slug LIKE ? ORDER BY created_at ASC LIMIT ? OFFSET ?",
				)
				.all(like, like, pageSize, offset);
			return { items: rows.map(rowToStation), total: Number(totalRow.c) };
		}
		const totalRow = db.query("SELECT COUNT(*) AS c FROM stations").get() as { c: number };
		const rows = db
			.query("SELECT * FROM stations ORDER BY created_at ASC LIMIT ? OFFSET ?")
			.all(pageSize, offset);
		return { items: rows.map(rowToStation), total: Number(totalRow.c) };
	}

	async getStation(id: string): Promise<Station | null> {
		const row = this.requireDb().query("SELECT * FROM stations WHERE id = ?").get(id);
		return row ? rowToStation(row) : null;
	}

	async getStationBySlug(slug: string): Promise<Station | null> {
		const row = this.requireDb().query("SELECT * FROM stations WHERE slug = ?").get(slug);
		return row ? rowToStation(row) : null;
	}

	async createStation(input: CreateStationInput): Promise<Station> {
		const db = this.requireDb();
		const station: Station = {
			id: newId("stn"),
			name: input.name,
			slug:
				input.slug ??
				input.name
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-+|-+$/g, "")
					.slice(0, 64),
			description: input.description ?? null,
			streamUrl: input.streamUrl ?? null,
			fallbackUrls: input.fallbackUrls ?? [],
			coverUrl: input.coverUrl ?? null,
			tags: input.tags ?? [],
			isPublic: input.isPublic ?? true,
			status: "idle",
			listenerCount: 0,
			createdAt: nowIso(),
			updatedAt: nowIso(),
		};
		if (!station.slug) throw new ConflictError("Invalid station name: cannot derive slug");
		try {
			db.run(
				`INSERT INTO stations (id, name, slug, description, stream_url, fallback_urls, cover_url, tags, is_public, status, listener_count, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				station.id,
				station.name,
				station.slug,
				station.description,
				station.streamUrl,
				JSON.stringify(station.fallbackUrls),
				station.coverUrl,
				JSON.stringify(station.tags),
				station.isPublic ? 1 : 0,
				station.status,
				station.listenerCount,
				station.createdAt,
				station.updatedAt,
			);
		} catch (err) {
			if (String(err).includes("UNIQUE")) {
				throw new ConflictError(`Station slug already exists: ${station.slug}`);
			}
			throw err;
		}
		return station;
	}

	async updateStation(id: string, patch: UpdateStationInput): Promise<Station | null> {
		const db = this.requireDb();
		const existing = await this.getStation(id);
		if (!existing) return null;
		const updated: Station = {
			...existing,
			...(patch.name !== undefined ? { name: patch.name } : {}),
			...(patch.slug !== undefined ? { slug: patch.slug } : {}),
			...(patch.description !== undefined ? { description: patch.description } : {}),
			...(patch.streamUrl !== undefined ? { streamUrl: patch.streamUrl } : {}),
			...(patch.fallbackUrls !== undefined ? { fallbackUrls: patch.fallbackUrls } : {}),
			...(patch.coverUrl !== undefined ? { coverUrl: patch.coverUrl } : {}),
			...(patch.tags !== undefined ? { tags: patch.tags } : {}),
			...(patch.isPublic !== undefined ? { isPublic: patch.isPublic } : {}),
			updatedAt: nowIso(),
		};
		try {
			db.run(
				"UPDATE stations SET name = ?, slug = ?, description = ?, stream_url = ?, fallback_urls = ?, cover_url = ?, tags = ?, is_public = ?, updated_at = ? WHERE id = ?",
				updated.name,
				updated.slug,
				updated.description,
				updated.streamUrl,
				JSON.stringify(updated.fallbackUrls),
				updated.coverUrl,
				JSON.stringify(updated.tags),
				updated.isPublic ? 1 : 0,
				updated.updatedAt,
				id,
			);
		} catch (err) {
			if (String(err).includes("UNIQUE")) {
				throw new ConflictError(`Station slug already exists: ${updated.slug}`);
			}
			throw err;
		}
		return updated;
	}

	async deleteStation(id: string): Promise<boolean> {
		const result = this.requireDb().run("DELETE FROM stations WHERE id = ?", id);
		return result.changes > 0;
	}

	// ── Stream sources ────────────────────────────────────────────────────

	async listStreams(stationId: string): Promise<StreamSource[]> {
		this.requireStation(stationId);
		const rows = this.requireDb()
			.query("SELECT * FROM stream_sources WHERE station_id = ? ORDER BY priority ASC")
			.all(stationId);
		return rows.map(rowToStream);
	}

	async getStream(stationId: string, streamId: string): Promise<StreamSource | null> {
		const row = this.requireDb()
			.query("SELECT * FROM stream_sources WHERE station_id = ? AND id = ?")
			.get(stationId, streamId);
		return row ? rowToStream(row) : null;
	}

	async createStream(stationId: string, input: CreateStreamSourceInput): Promise<StreamSource> {
		this.requireStation(stationId);
		const source: StreamSource = {
			id: newId("src"),
			stationId,
			name: input.name,
			url: input.url,
			protocol: input.protocol ?? "http",
			codec: input.codec ?? "unknown",
			priority: input.priority ?? 100,
			enabled: input.enabled ?? true,
			nowPlaying: null,
			createdAt: nowIso(),
			updatedAt: nowIso(),
		};
		this.requireDb().run(
			`INSERT INTO stream_sources (id, station_id, name, url, protocol, codec, priority, enabled, now_playing, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			source.id,
			source.stationId,
			source.name,
			source.url,
			source.protocol,
			source.codec,
			source.priority,
			source.enabled ? 1 : 0,
			source.nowPlaying,
			source.createdAt,
			source.updatedAt,
		);
		return source;
	}

	async updateStream(
		stationId: string,
		streamId: string,
		patch: UpdateStreamSourceInput,
	): Promise<StreamSource | null> {
		const existing = await this.getStream(stationId, streamId);
		if (!existing) return null;
		const updated: StreamSource = {
			...existing,
			...(patch.name !== undefined ? { name: patch.name } : {}),
			...(patch.url !== undefined ? { url: patch.url } : {}),
			...(patch.protocol !== undefined ? { protocol: patch.protocol } : {}),
			...(patch.codec !== undefined ? { codec: patch.codec } : {}),
			...(patch.priority !== undefined ? { priority: patch.priority } : {}),
			...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
			updatedAt: nowIso(),
		};
		this.requireDb().run(
			"UPDATE stream_sources SET name = ?, url = ?, protocol = ?, codec = ?, priority = ?, enabled = ?, updated_at = ? WHERE station_id = ? AND id = ?",
			updated.name,
			updated.url,
			updated.protocol,
			updated.codec,
			updated.priority,
			updated.enabled ? 1 : 0,
			updated.updatedAt,
			stationId,
			streamId,
		);
		return updated;
	}

	async deleteStream(stationId: string, streamId: string): Promise<boolean> {
		const result = this.requireDb().run(
			"DELETE FROM stream_sources WHERE station_id = ? AND id = ?",
			stationId,
			streamId,
		);
		return result.changes > 0;
	}

	// ── Playlists ─────────────────────────────────────────────────────────

	async listPlaylists(stationId: string): Promise<Playlist[]> {
		this.requireStation(stationId);
		const rows = this.requireDb()
			.query("SELECT * FROM playlists WHERE station_id = ? ORDER BY created_at ASC")
			.all(stationId);
		return rows.map(rowToPlaylist);
	}

	async getPlaylist(stationId: string, playlistId: string): Promise<Playlist | null> {
		const row = this.requireDb()
			.query("SELECT * FROM playlists WHERE station_id = ? AND id = ?")
			.get(stationId, playlistId);
		return row ? rowToPlaylist(row) : null;
	}

	async createPlaylist(stationId: string, input: CreatePlaylistInput): Promise<Playlist> {
		this.requireStation(stationId);
		const playlist: Playlist = {
			id: newId("pl"),
			stationId,
			name: input.name,
			entries: input.entries ?? [],
			createdAt: nowIso(),
			updatedAt: nowIso(),
		};
		this.requireDb().run(
			"INSERT INTO playlists (id, station_id, name, entries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			playlist.id,
			playlist.stationId,
			playlist.name,
			JSON.stringify(playlist.entries),
			playlist.createdAt,
			playlist.updatedAt,
		);
		return playlist;
	}

	async deletePlaylist(stationId: string, playlistId: string): Promise<boolean> {
		const result = this.requireDb().run(
			"DELETE FROM playlists WHERE station_id = ? AND id = ?",
			stationId,
			playlistId,
		);
		return result.changes > 0;
	}
}
