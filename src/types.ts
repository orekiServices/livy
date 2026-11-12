/**
 * Livy core domain types.
 *
 * Data model:
 *   Station 1───* StreamSource   (a station owns many upstream sources)
 *   Station 1───* Playlist       (named, ordered collections of URLs)
 *   Station 1───* PlaybackSession (ephemeral listener sessions)
 */

export type StreamProtocol = "http" | "https" | "hls" | "icecast" | "shoutcast";
export type AudioCodec = "mp3" | "aac" | "flac" | "opus" | "vorbis" | "unknown";
export type StationStatus = "idle" | "starting" | "playing" | "buffering" | "error" | "stopped";
export type SessionState = "connecting" | "playing" | "paused" | "stopped" | "error";
export type DatabaseType = "memory" | "sqlite" | "postgres";

export interface Station {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	/** Primary stream URL (convenience — mirrored into streams on create). */
	streamUrl: string | null;
	/** Fallback / additional upstream URLs. */
	fallbackUrls: string[];
	/** Optional cover art URL. */
	coverUrl: string | null;
	/** Free-form tags for organisation / filtering. */
	tags: string[];
	/** Whether the station is publicly listed. */
	isPublic: boolean;
	status: StationStatus;
	/** Current listener count (derived, kept in sync by StreamService). */
	listenerCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface CreateStationInput {
	name: string;
	slug?: string;
	description?: string;
	streamUrl?: string;
	fallbackUrls?: string[];
	coverUrl?: string;
	tags?: string[];
	isPublic?: boolean;
}

export interface UpdateStationInput {
	name?: string;
	slug?: string;
	description?: string | null;
	streamUrl?: string | null;
	fallbackUrls?: string[];
	coverUrl?: string | null;
	tags?: string[];
	isPublic?: boolean;
}

export interface StreamSource {
	id: string;
	stationId: string;
	name: string;
	url: string;
	protocol: StreamProtocol;
	codec: AudioCodec;
	/** Lower number = higher priority (failover order). */
	priority: number;
	enabled: boolean;
	/** Last known ICY metadata title, if any. */
	nowPlaying: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface CreateStreamSourceInput {
	name: string;
	url: string;
	protocol?: StreamProtocol;
	codec?: AudioCodec;
	priority?: number;
	enabled?: boolean;
}

export interface UpdateStreamSourceInput {
	name?: string;
	url?: string;
	protocol?: StreamProtocol;
	codec?: AudioCodec;
	priority?: number;
	enabled?: boolean;
}

export interface PlaylistEntry {
	url: string;
	title?: string;
	duration?: number;
}

export interface Playlist {
	id: string;
	stationId: string;
	name: string;
	entries: PlaylistEntry[];
	createdAt: string;
	updatedAt: string;
}

export interface CreatePlaylistInput {
	name: string;
	entries?: PlaylistEntry[];
}

export interface PlaybackSession {
	id: string;
	stationId: string;
	state: SessionState;
	/** Upstream URL currently being proxied, if any. */
	sourceUrl: string | null;
	bytesStreamed: number;
	startedAt: string;
	updatedAt: string;
	/** Last error message, if any. */
	error: string | null;
}

export interface StationStatusInfo {
	stationId: string;
	status: StationStatus;
	listenerCount: number;
	activeSource: StreamSource | null;
	nowPlaying: string | null;
	uptimeSeconds: number;
}

export interface ServerInfo {
	name: string;
	version: string;
	nativeAvailable: boolean;
	nativeVersion: string | null;
	database: DatabaseType;
	uptimeSeconds: number;
}

export interface ApiError {
	error: string;
	message: string;
	status: number;
	details?: unknown;
}

export interface Pagination {
	page: number;
	pageSize: number;
	total: number;
}

export interface StationExport {
	version: 1;
	station: Station;
	streams: StreamSource[];
	playlists: Playlist[];
}

/** Import payload — same shape as an export but without server-generated fields. */
export interface ImportStationInput {
	version: 1;
	station: {
		name: string;
		slug: string;
		description?: string | null;
		streamUrl?: string | null;
		fallbackUrls: string[];
		coverUrl?: string | null;
		tags: string[];
		isPublic: boolean;
	};
	streams: {
		name: string;
		url: string;
		protocol: StreamProtocol;
		codec: AudioCodec;
		priority: number;
		enabled: boolean;
	}[];
	playlists: {
		name: string;
		entries: PlaylistEntry[];
	}[];
}

export interface LivyConfig {
	host: string;
	port: number;
	nodeEnv: string;
	logLevel: "debug" | "info" | "warn" | "error";
	apiKey: string | null;
	databaseType: DatabaseType;
	databasePath: string;
	databaseUrl: string | null;
	maxListenersPerStation: number;
	streamTimeoutMs: number;
	useNativeAudio: boolean;
	corsOrigins: string[];
	rateLimitMax: number;
	rateLimitWindowMs: number;
	defaultSearchSource: string;
}
