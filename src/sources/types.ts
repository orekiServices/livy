/**
 * Source system types — modelled on NodeLink's source architecture.
 *
 * A `SourceInstance` is a provider that can resolve identifiers (URLs or
 * `source:query` strings) into tracks and load playable streams. The
 * `SourceManager` routes identifiers to sources by search-term prefix,
 * URL pattern, or priority.
 */

export interface TrackInfo {
	/** Track identifier (URL or source-specific id). */
	identifier: string;
	/** Whether the track is seekable (false for live radio). */
	isSeekable: boolean;
	/** Track author / artist / station name. */
	author: string;
	/** Track duration in milliseconds (0 for live streams). */
	length: number;
	/** Whether this is a live stream. */
	isStream: boolean;
	/** Track position in queue. */
	position: number;
	/** Track title. */
	title: string;
	/** Track source URI (direct stream URL). */
	uri: string;
	/** Artwork / thumbnail URL. */
	artworkUrl: string | null;
	/** ISRC, when known. */
	isrc: string | null;
	/** Source name (e.g. 'http', 'hls', 'icecast'). */
	sourceName: string;
}

export interface TrackData {
	/** Base64-encoded track (Lavalink-compatible). */
	encoded: string;
	/** Normalised track metadata. */
	info: TrackInfo;
	/** Source-specific metadata. */
	pluginInfo: Record<string, unknown>;
}

export type LoadType = "track" | "playlist" | "search" | "empty" | "error";

export interface SourceResult {
	loadType: LoadType;
	data: {
		tracks: TrackData[];
		playlistInfo?: { name: string; selectedTrack: number };
	};
	exception?: { message: string; severity: "common" | "suspicious" | "usage" };
}

export interface TrackUrlResult {
	url?: string;
	protocol?: string;
	format?: string;
	exception?: { message: string; severity: string };
}

export interface TrackStreamResult {
	stream?: ReadableStream<Uint8Array>;
	type?: string;
	exception?: { message: string; severity: string };
}

export interface SourceContext {
	userAgent: string;
	fetchTimeoutMs: number;
}

/**
 * A source provider. Implementations must be stateless across calls
 * (per-call state lives in the returned results).
 */
export interface SourceInstance {
	readonly name: string;
	/** Search-term prefixes this source claims, e.g. `['hls:']`. */
	readonly searchTerms: string[];
	/** Lower number = higher priority when multiple sources can handle an id. */
	readonly priority: number;
	/** Whether this source can handle the identifier (URL pattern match). */
	canHandle(identifier: string): boolean;
	/** Resolve an identifier into tracks. */
	resolve(identifier: string): Promise<SourceResult>;
	/** Search for tracks (delegates to resolve for URL-based sources). */
	search(query: string): Promise<SourceResult>;
	/** Resolve a track to a direct stream URL. */
	getTrackUrl(track: TrackInfo): Promise<TrackUrlResult>;
	/** Load a playable stream for a track. */
	loadStream(track: TrackInfo, url: string): Promise<TrackStreamResult>;
	/** Lightweight health probe (HEAD/GET against a known-good URL). */
	healthProbe?(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}

export interface SourceHealth {
	name: string;
	priority: number;
	enabled: boolean;
	lastProbe: { ok: boolean; latencyMs: number; at: string; error?: string } | null;
}
