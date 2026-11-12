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

/**
 * Database adapter interface.
 *
 * All persistence goes through this interface so drivers (memory, sqlite,
 * postgres, …) stay isolated. Implementations must be safe for concurrent
 * use within a single process.
 */
export interface DatabaseAdapter {
	readonly type: "memory" | "sqlite" | "postgres";
	readonly ready: boolean;

	init(): Promise<void>;
	close(): Promise<void>;
	healthCheck(): Promise<{ ok: boolean; latencyMs: number }>;

	// ── Stations ──────────────────────────────────────────────────────────
	listStations(opts?: { page?: number; pageSize?: number; search?: string }): Promise<{
		items: Station[];
		total: number;
	}>;
	getStation(id: string): Promise<Station | null>;
	getStationBySlug(slug: string): Promise<Station | null>;
	createStation(input: CreateStationInput): Promise<Station>;
	updateStation(id: string, patch: UpdateStationInput): Promise<Station | null>;
	deleteStation(id: string): Promise<boolean>;

	// ── Stream sources (scoped to a station) ──────────────────────────────
	listStreams(stationId: string): Promise<StreamSource[]>;
	getStream(stationId: string, streamId: string): Promise<StreamSource | null>;
	createStream(stationId: string, input: CreateStreamSourceInput): Promise<StreamSource>;
	updateStream(
		stationId: string,
		streamId: string,
		patch: UpdateStreamSourceInput,
	): Promise<StreamSource | null>;
	deleteStream(stationId: string, streamId: string): Promise<boolean>;

	// ── Playlists (scoped to a station) ───────────────────────────────────
	listPlaylists(stationId: string): Promise<Playlist[]>;
	getPlaylist(stationId: string, playlistId: string): Promise<Playlist | null>;
	createPlaylist(stationId: string, input: CreatePlaylistInput): Promise<Playlist>;
	deletePlaylist(stationId: string, playlistId: string): Promise<boolean>;
}

/** Helpers shared by adapters. */
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
