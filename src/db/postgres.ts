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
 * PostgreSQL adapter using the `postgres` npm package (optional dependency).
 *
 * Install with: bun add postgres
 * Configure with: DATABASE_TYPE=postgres DATABASE_URL=postgres://…
 *
 * The schema mirrors the SQLite adapter. All queries are parameterised.
 * Connection pooling is handled by the `postgres` driver (default pool).
 */

type Sql = {
	<T = Record<string, unknown>[]>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
	end(): Promise<void>;
};

const SCHEMA_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS stations (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		slug TEXT NOT NULL UNIQUE,
		description TEXT,
		stream_url TEXT,
		fallback_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
		cover_url TEXT,
		tags JSONB NOT NULL DEFAULT '[]'::jsonb,
		is_public BOOLEAN NOT NULL DEFAULT TRUE,
		status TEXT NOT NULL DEFAULT 'idle',
		listener_count INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS stream_sources (
		id TEXT PRIMARY KEY,
		station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		url TEXT NOT NULL,
		protocol TEXT NOT NULL DEFAULT 'http',
		codec TEXT NOT NULL DEFAULT 'unknown',
		priority INTEGER NOT NULL DEFAULT 100,
		enabled BOOLEAN NOT NULL DEFAULT TRUE,
		now_playing TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	"CREATE INDEX IF NOT EXISTS idx_stream_sources_station ON stream_sources(station_id)",
	`CREATE TABLE IF NOT EXISTS playlists (
		id TEXT PRIMARY KEY,
		station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		entries JSONB NOT NULL DEFAULT '[]'::jsonb,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	"CREATE INDEX IF NOT EXISTS idx_playlists_station ON playlists(station_id)",
];

function rowToStation(row: Record<string, unknown>): Station {
	return {
		id: String(row.id),
		name: String(row.name),
		slug: String(row.slug),
		description: (row.description as string | null) ?? null,
		streamUrl: (row.stream_url as string | null) ?? null,
		fallbackUrls: (row.fallback_urls as string[]) ?? [],
		coverUrl: (row.cover_url as string | null) ?? null,
		tags: (row.tags as string[]) ?? [],
		isPublic: Boolean(row.is_public),
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
		enabled: Boolean(row.enabled),
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
		entries: (row.entries as Playlist["entries"]) ?? [],
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

export class PostgresAdapter implements DatabaseAdapter {
	readonly type = "postgres" as const;
	ready = false;

	private sql: Sql | null = null;
	private readonly url: string;

	constructor(url: string) {
		this.url = url;
	}

	async init(): Promise<void> {
		let postgres: (url: string, opts?: Record<string, unknown>) => Sql;
		try {
			const mod = (await import("postgres")) as {
				default: (url: string, opts?: Record<string, unknown>) => Sql;
			};
			postgres = mod.default;
		} catch {
			throw new Error(
				"PostgreSQL adapter requires the `postgres` package. Install it with: bun add postgres",
			);
		}
		this.sql = postgres(this.url, { max: 10, idle_timeout: 20, connect_timeout: 10 });
		for (const stmt of SCHEMA_STATEMENTS) {
			await this.sql([stmt] as unknown as TemplateStringsArray);
		}
		this.ready = true;
	}

	async close(): Promise<void> {
		await this.sql?.end();
		this.sql = null;
		this.ready = false;
	}

	async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
		const start = performance.now();
		try {
			await this.requireSql()`SELECT 1 AS one`;
			return { ok: true, latencyMs: performance.now() - start };
		} catch {
			return { ok: false, latencyMs: performance.now() - start };
		}
	}

	private requireSql(): Sql {
		if (!this.sql) throw new Error("Postgres adapter not initialised — call init() first");
		return this.sql;
	}

	private async requireStation(stationId: string): Promise<void> {
		const rows = await this.requireSql()`SELECT id FROM stations WHERE id = ${stationId}`;
		if (rows.length === 0) throw new NotFoundError("Station", stationId);
	}

	// ── Stations ──────────────────────────────────────────────────────────

	async listStations(opts?: {
		page?: number;
		pageSize?: number;
		search?: string;
	}): Promise<{ items: Station[]; total: number }> {
		const sql = this.requireSql();
		const page = opts?.page ?? 1;
		const pageSize = opts?.pageSize ?? 50;
		const offset = (page - 1) * pageSize;
		if (opts?.search) {
			const like = `%${opts.search}%`;
			const countRows = await sql<{ c: string }[]>`
				SELECT COUNT(*)::text AS c FROM stations WHERE name ILIKE ${like} OR slug ILIKE ${like}`;
			const rows = await sql<Record<string, unknown>[]>`
				SELECT * FROM stations WHERE name ILIKE ${like} OR slug ILIKE ${like}
				ORDER BY created_at ASC LIMIT ${pageSize} OFFSET ${offset}`;
			return { items: rows.map(rowToStation), total: Number(countRows[0]?.c ?? 0) };
		}
		const countRows = await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM stations`;
		const rows = await sql<Record<string, unknown>[]>`
			SELECT * FROM stations ORDER BY created_at ASC LIMIT ${pageSize} OFFSET ${offset}`;
		return { items: rows.map(rowToStation), total: Number(countRows[0]?.c ?? 0) };
	}

	async getStation(id: string): Promise<Station | null> {
		const rows = await this.requireSql()`SELECT * FROM stations WHERE id = ${id}`;
		return rows[0] ? rowToStation(rows[0]) : null;
	}

	async getStationBySlug(slug: string): Promise<Station | null> {
		const rows = await this.requireSql()`SELECT * FROM stations WHERE slug = ${slug}`;
		return rows[0] ? rowToStation(rows[0]) : null;
	}

	async createStation(input: CreateStationInput): Promise<Station> {
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
			await this.requireSql()`
				INSERT INTO stations (id, name, slug, description, stream_url, fallback_urls, cover_url, tags, is_public, status, listener_count, created_at, updated_at)
				VALUES (${station.id}, ${station.name}, ${station.slug}, ${station.description}, ${station.streamUrl}, ${station.fallbackUrls}, ${station.coverUrl}, ${station.tags}, ${station.isPublic}, ${station.status}, ${station.listenerCount}, ${station.createdAt}, ${station.updatedAt})`;
		} catch (err) {
			if (String(err).includes("unique") || String(err).includes("duplicate")) {
				throw new ConflictError(`Station slug already exists: ${station.slug}`);
			}
			throw err;
		}
		return station;
	}

	async updateStation(id: string, patch: UpdateStationInput): Promise<Station | null> {
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
			await this.requireSql()`
				UPDATE stations SET name = ${updated.name}, slug = ${updated.slug}, description = ${updated.description},
				stream_url = ${updated.streamUrl}, fallback_urls = ${updated.fallbackUrls}, cover_url = ${updated.coverUrl},
				tags = ${updated.tags}, is_public = ${updated.isPublic}, updated_at = ${updated.updatedAt} WHERE id = ${id}`;
		} catch (err) {
			if (String(err).includes("unique") || String(err).includes("duplicate")) {
				throw new ConflictError(`Station slug already exists: ${updated.slug}`);
			}
			throw err;
		}
		return updated;
	}

	async deleteStation(id: string): Promise<boolean> {
		const rows = await this.requireSql()`DELETE FROM stations WHERE id = ${id} RETURNING id`;
		return rows.length > 0;
	}

	// ── Stream sources ────────────────────────────────────────────────────

	async listStreams(stationId: string): Promise<StreamSource[]> {
		await this.requireStation(stationId);
		const rows = await this.requireSql()`
			SELECT * FROM stream_sources WHERE station_id = ${stationId} ORDER BY priority ASC`;
		return rows.map(rowToStream);
	}

	async getStream(stationId: string, streamId: string): Promise<StreamSource | null> {
		const rows = await this.requireSql()`
			SELECT * FROM stream_sources WHERE station_id = ${stationId} AND id = ${streamId}`;
		return rows[0] ? rowToStream(rows[0]) : null;
	}

	async createStream(stationId: string, input: CreateStreamSourceInput): Promise<StreamSource> {
		await this.requireStation(stationId);
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
		await this.requireSql()`
			INSERT INTO stream_sources (id, station_id, name, url, protocol, codec, priority, enabled, now_playing, created_at, updated_at)
			VALUES (${source.id}, ${source.stationId}, ${source.name}, ${source.url}, ${source.protocol}, ${source.codec}, ${source.priority}, ${source.enabled}, ${source.nowPlaying}, ${source.createdAt}, ${source.updatedAt})`;
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
		await this.requireSql()`
			UPDATE stream_sources SET name = ${updated.name}, url = ${updated.url}, protocol = ${updated.protocol},
			codec = ${updated.codec}, priority = ${updated.priority}, enabled = ${updated.enabled}, updated_at = ${updated.updatedAt}
			WHERE station_id = ${stationId} AND id = ${streamId}`;
		return updated;
	}

	async deleteStream(stationId: string, streamId: string): Promise<boolean> {
		const rows = await this.requireSql()`
			DELETE FROM stream_sources WHERE station_id = ${stationId} AND id = ${streamId} RETURNING id`;
		return rows.length > 0;
	}

	// ── Playlists ─────────────────────────────────────────────────────────

	async listPlaylists(stationId: string): Promise<Playlist[]> {
		await this.requireStation(stationId);
		const rows = await this.requireSql()`
			SELECT * FROM playlists WHERE station_id = ${stationId} ORDER BY created_at ASC`;
		return rows.map(rowToPlaylist);
	}

	async getPlaylist(stationId: string, playlistId: string): Promise<Playlist | null> {
		const rows = await this.requireSql()`
			SELECT * FROM playlists WHERE station_id = ${stationId} AND id = ${playlistId}`;
		return rows[0] ? rowToPlaylist(rows[0]) : null;
	}

	async createPlaylist(stationId: string, input: CreatePlaylistInput): Promise<Playlist> {
		await this.requireStation(stationId);
		const playlist: Playlist = {
			id: newId("pl"),
			stationId,
			name: input.name,
			entries: input.entries ?? [],
			createdAt: nowIso(),
			updatedAt: nowIso(),
		};
		await this.requireSql()`
			INSERT INTO playlists (id, station_id, name, entries, created_at, updated_at)
			VALUES (${playlist.id}, ${playlist.stationId}, ${playlist.name}, ${playlist.entries}, ${playlist.createdAt}, ${playlist.updatedAt})`;
		return playlist;
	}

	async deletePlaylist(stationId: string, playlistId: string): Promise<boolean> {
		const rows = await this.requireSql()`
			DELETE FROM playlists WHERE station_id = ${stationId} AND id = ${playlistId} RETURNING id`;
		return rows.length > 0;
	}
}
