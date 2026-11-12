import type { Logger } from "../logger.js";
import { HlsSource } from "./hls.js";
import { HttpSource } from "./http.js";
import { IcecastSource } from "./icecast.js";
import { LocalSource } from "./local.js";
import { M3uSource } from "./m3u.js";
import { decodeTrack } from "./track.js";
import type {
	SourceContext,
	SourceHealth,
	SourceInstance,
	SourceResult,
	TrackInfo,
	TrackStreamResult,
	TrackUrlResult,
} from "./types.js";

/**
 * Source manager — routes identifiers to source providers.
 *
 * Modelled on NodeLink's SourcesManager:
 * - `source:query` identifiers are routed by search-term prefix
 *   (e.g. `hls:https://…`, `local:/music/a.mp3`).
 * - Bare URLs are routed by `canHandle` URL patterns, lowest priority first.
 * - `search` (no prefix) falls back to the default search source.
 * - Health probes run per-source on demand (`GET /api/v1/sources/health`).
 */

const URL_PROTOCOL_RE = /^(?:https?|ftts):\/\//i;
const PREFIX_RE = /^([A-Za-z0-9]+):(.+)$/;

export class SourceManager {
	readonly sources = new Map<string, SourceInstance>();
	private readonly searchAliasMap = new Map<string, SourceInstance>();
	private readonly health = new Map<string, SourceHealth["lastProbe"]>();

	constructor(
		private readonly logger: Logger,
		private readonly ctx: SourceContext,
		private readonly defaultSearchSource = "http",
	) {
		this.register(new HttpSource(ctx, logger));
		this.register(new IcecastSource(ctx, logger));
		this.register(new HlsSource(ctx, logger));
		this.register(new M3uSource(ctx, logger));
		this.register(new LocalSource(ctx, logger));
	}

	register(source: SourceInstance): void {
		this.sources.set(source.name, source);
		for (const term of source.searchTerms) {
			this.searchAliasMap.set(term.replace(/:$/, ""), source);
		}
		this.logger.debug("source registered", { name: source.name, priority: source.priority });
	}

	getSource(name: string): SourceInstance | null {
		return this.sources.get(name) ?? null;
	}

	getEnabledSourceNames(): string[] {
		return [...this.sources.keys()];
	}

	listHealth(): SourceHealth[] {
		return [...this.sources.values()]
			.sort((a, b) => a.priority - b.priority)
			.map((s) => ({
				name: s.name,
				priority: s.priority,
				enabled: true,
				lastProbe: this.health.get(s.name) ?? null,
			}));
	}

	/** Run health probes for all sources that support them. */
	async probeAll(): Promise<SourceHealth[]> {
		for (const source of this.sources.values()) {
			if (!source.healthProbe) continue;
			try {
				const result = await source.healthProbe();
				this.health.set(source.name, {
					ok: result.ok,
					latencyMs: result.latencyMs,
					at: new Date().toISOString(),
					...(result.error ? { error: result.error } : {}),
				});
			} catch (err) {
				this.health.set(source.name, {
					ok: false,
					latencyMs: 0,
					at: new Date().toISOString(),
					error: String(err),
				});
			}
		}
		return this.listHealth();
	}

	/** Find the source that claims an identifier (prefix first, then patterns). */
	findSource(identifier: string): SourceInstance | null {
		const prefixMatch = PREFIX_RE.exec(identifier);
		if (prefixMatch?.[1] && !URL_PROTOCOL_RE.test(identifier)) {
			const byPrefix = this.searchAliasMap.get(prefixMatch[1].toLowerCase());
			if (byPrefix) return byPrefix;
		}
		const candidates = [...this.sources.values()]
			.sort((a, b) => a.priority - b.priority)
			.filter((s) => s.canHandle(identifier));
		return candidates[0] ?? null;
	}

	/** Resolve an identifier (URL or `source:query`) into tracks. */
	async resolve(identifier: string): Promise<SourceResult> {
		const source = this.findSource(identifier);
		if (!source) {
			return {
				loadType: "error",
				data: { tracks: [] },
				exception: { message: `No source can handle: ${identifier}`, severity: "usage" },
			};
		}
		// Strip the `source:` prefix when present.
		const prefixMatch = PREFIX_RE.exec(identifier);
		const query =
			prefixMatch?.[1] &&
			!URL_PROTOCOL_RE.test(identifier) &&
			this.searchAliasMap.has(prefixMatch[1].toLowerCase())
				? (prefixMatch[2] ?? identifier)
				: identifier;
		this.logger.debug("resolving identifier", { identifier, source: source.name });
		return source.resolve(query);
	}

	/** Search using a named source (or the default search source). */
	async search(sourceName: string, query: string): Promise<SourceResult> {
		const source = this.getSource(sourceName) ?? this.getSource(this.defaultSearchSource);
		if (!source) {
			return {
				loadType: "error",
				data: { tracks: [] },
				exception: { message: `Unknown source: ${sourceName}`, severity: "usage" },
			};
		}
		return source.search(query);
	}

	/** Resolve an encoded track back to a direct stream URL. */
	async getTrackUrl(encoded: string): Promise<TrackUrlResult> {
		const track = decodeTrack(encoded);
		const source = this.getSource(track.info.sourceName) ?? this.findSource(track.info.uri);
		if (!source) {
			return {
				exception: { message: `No source for track: ${track.info.uri}`, severity: "common" },
			};
		}
		return source.getTrackUrl(track.info);
	}

	/** Load a playable stream for an encoded track. */
	async getTrackStream(encoded: string): Promise<TrackStreamResult> {
		const track = decodeTrack(encoded);
		const source = this.getSource(track.info.sourceName) ?? this.findSource(track.info.uri);
		if (!source) {
			return {
				exception: { message: `No source for track: ${track.info.uri}`, severity: "common" },
			};
		}
		const urlResult = await source.getTrackUrl(track.info);
		if (!urlResult.url) {
			return {
				exception: {
					message: urlResult.exception?.message ?? "Could not resolve track URL",
					severity: "common",
				},
			};
		}
		return source.loadStream(track.info, urlResult.url);
	}

	/** Convenience: resolve + first track URL in one call. */
	async resolveToUrl(identifier: string): Promise<{ track: TrackInfo; url: string }> {
		const result = await this.resolve(identifier);
		const first = result.data.tracks[0];
		if (!first) {
			throw new Error(result.exception?.message ?? `Could not resolve: ${identifier}`);
		}
		const urlResult = await this.getTrackUrl(first.encoded);
		if (!urlResult.url) {
			throw new Error(urlResult.exception?.message ?? "Could not resolve track URL");
		}
		return { track: first.info, url: urlResult.url };
	}
}

export function createSourceManager(
	logger: Logger,
	ctx: SourceContext,
	defaultSearchSource = "http",
): SourceManager {
	return new SourceManager(logger, ctx, defaultSearchSource);
}
