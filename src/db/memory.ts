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
import { newId, nowIso, slugify } from "./adapter.js";
import type { DatabaseAdapter } from "./adapter.js";

/**
 * In-memory adapter — zero dependencies, ideal for development and tests.
 * Data is lost on restart. Not suitable for multi-process deployments.
 */
export class MemoryAdapter implements DatabaseAdapter {
	readonly type = "memory" as const;
	ready = false;

	private stations = new Map<string, Station>();
	private streams = new Map<string, Map<string, StreamSource>>();
	private playlists = new Map<string, Map<string, Playlist>>();

	async init(): Promise<void> {
		this.ready = true;
	}

	async close(): Promise<void> {
		this.ready = false;
	}

	async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
		const start = performance.now();
		const ok = this.ready;
		return { ok, latencyMs: Math.max(0, performance.now() - start) };
	}

	// ── Stations ──────────────────────────────────────────────────────────

	async listStations(opts?: {
		page?: number;
		pageSize?: number;
		search?: string;
	}): Promise<{ items: Station[]; total: number }> {
		let all = [...this.stations.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		if (opts?.search) {
			const q = opts.search.toLowerCase();
			all = all.filter(
				(s) =>
					s.name.toLowerCase().includes(q) ||
					s.slug.includes(q) ||
					s.tags.some((t) => t.toLowerCase().includes(q)),
			);
		}
		const total = all.length;
		const page = opts?.page ?? 1;
		const pageSize = opts?.pageSize ?? 50;
		const start = (page - 1) * pageSize;
		return { items: all.slice(start, start + pageSize), total };
	}

	async getStation(id: string): Promise<Station | null> {
		return this.stations.get(id) ?? null;
	}

	async getStationBySlug(slug: string): Promise<Station | null> {
		for (const s of this.stations.values()) {
			if (s.slug === slug) return s;
		}
		return null;
	}

	async createStation(input: CreateStationInput): Promise<Station> {
		const slug = input.slug ?? slugify(input.name);
		if (!slug) throw new ConflictError("Invalid station name: cannot derive slug");
		for (const s of this.stations.values()) {
			if (s.slug === slug) throw new ConflictError(`Station slug already exists: ${slug}`);
		}
		const ts = nowIso();
		const station: Station = {
			id: newId("stn"),
			name: input.name,
			slug,
			description: input.description ?? null,
			streamUrl: input.streamUrl ?? null,
			fallbackUrls: input.fallbackUrls ?? [],
			coverUrl: input.coverUrl ?? null,
			tags: input.tags ?? [],
			isPublic: input.isPublic ?? true,
			status: "idle",
			listenerCount: 0,
			createdAt: ts,
			updatedAt: ts,
		};
		this.stations.set(station.id, station);
		this.streams.set(station.id, new Map());
		this.playlists.set(station.id, new Map());
		return station;
	}

	async updateStation(id: string, patch: UpdateStationInput): Promise<Station | null> {
		const existing = this.stations.get(id);
		if (!existing) return null;
		if (patch.slug && patch.slug !== existing.slug) {
			for (const s of this.stations.values()) {
				if (s.id !== id && s.slug === patch.slug) {
					throw new ConflictError(`Station slug already exists: ${patch.slug}`);
				}
			}
		}
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
		this.stations.set(id, updated);
		return updated;
	}

	async deleteStation(id: string): Promise<boolean> {
		const existed = this.stations.delete(id);
		this.streams.delete(id);
		this.playlists.delete(id);
		return existed;
	}

	// ── Stream sources ────────────────────────────────────────────────────

	private stationStreams(stationId: string): Map<string, StreamSource> {
		const map = this.streams.get(stationId);
		if (!map) throw new NotFoundError("Station", stationId);
		return map;
	}

	async listStreams(stationId: string): Promise<StreamSource[]> {
		return [...this.stationStreams(stationId).values()].sort((a, b) => a.priority - b.priority);
	}

	async getStream(stationId: string, streamId: string): Promise<StreamSource | null> {
		return this.stationStreams(stationId).get(streamId) ?? null;
	}

	async createStream(stationId: string, input: CreateStreamSourceInput): Promise<StreamSource> {
		const map = this.stationStreams(stationId);
		const ts = nowIso();
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
			createdAt: ts,
			updatedAt: ts,
		};
		map.set(source.id, source);
		return source;
	}

	async updateStream(
		stationId: string,
		streamId: string,
		patch: UpdateStreamSourceInput,
	): Promise<StreamSource | null> {
		const map = this.stationStreams(stationId);
		const existing = map.get(streamId);
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
		map.set(streamId, updated);
		return updated;
	}

	async deleteStream(stationId: string, streamId: string): Promise<boolean> {
		return this.stationStreams(stationId).delete(streamId);
	}

	// ── Playlists ─────────────────────────────────────────────────────────

	private stationPlaylists(stationId: string): Map<string, Playlist> {
		const map = this.playlists.get(stationId);
		if (!map) throw new NotFoundError("Station", stationId);
		return map;
	}

	async listPlaylists(stationId: string): Promise<Playlist[]> {
		return [...this.stationPlaylists(stationId).values()].sort((a, b) =>
			a.createdAt.localeCompare(b.createdAt),
		);
	}

	async getPlaylist(stationId: string, playlistId: string): Promise<Playlist | null> {
		return this.stationPlaylists(stationId).get(playlistId) ?? null;
	}

	async createPlaylist(stationId: string, input: CreatePlaylistInput): Promise<Playlist> {
		const map = this.stationPlaylists(stationId);
		const ts = nowIso();
		const playlist: Playlist = {
			id: newId("pl"),
			stationId,
			name: input.name,
			entries: input.entries ?? [],
			createdAt: ts,
			updatedAt: ts,
		};
		map.set(playlist.id, playlist);
		return playlist;
	}

	async deletePlaylist(stationId: string, playlistId: string): Promise<boolean> {
		return this.stationPlaylists(stationId).delete(playlistId);
	}
}
