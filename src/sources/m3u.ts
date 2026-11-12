import { parseM3u } from "../audio/hls.js";
import type { Logger } from "../logger.js";
import { makeTrackInfo, toTrackData } from "./track.js";
import type {
	SourceContext,
	SourceInstance,
	SourceResult,
	TrackInfo,
	TrackStreamResult,
	TrackUrlResult,
} from "./types.js";

/**
 * M3U source — resolves `.m3u` / `.m3u8`-style playlists into track lists.
 * (`.m3u8` URLs are claimed by the HLS source first; this source handles
 * plain M3U playlists and `m3u:`-prefixed identifiers.)
 */
export class M3uSource implements SourceInstance {
	readonly name = "m3u";
	readonly searchTerms = ["m3u:"];
	readonly priority = 30;

	constructor(
		private readonly ctx: SourceContext,
		private readonly logger: Logger,
	) {}

	canHandle(identifier: string): boolean {
		return /\.m3u(\?|#|$)/i.test(identifier) && !/\.m3u8(\?|#|$)/i.test(identifier);
	}

	async resolve(url: string): Promise<SourceResult> {
		try {
			const res = await fetch(url, {
				headers: { "User-Agent": this.ctx.userAgent },
				signal: AbortSignal.timeout(this.ctx.fetchTimeoutMs),
			});
			if (!res.ok) {
				return {
					loadType: "error",
					data: { tracks: [] },
					exception: { message: `M3U fetch failed: ${res.status}`, severity: "common" },
				};
			}
			const text = await res.text();
			const entries = parseM3u(text);
			if (entries.length === 0) {
				return { loadType: "empty", data: { tracks: [] } };
			}
			const tracks = entries.map((e, i) =>
				toTrackData(
					makeTrackInfo({
						identifier: e.url,
						uri: e.url,
						title: e.title ?? e.url,
						author: "M3U",
						sourceName: "m3u",
						position: i,
						isStream: true,
					}),
				),
			);
			return {
				loadType: "playlist",
				data: { tracks, playlistInfo: { name: url, selectedTrack: 0 } },
			};
		} catch (err) {
			this.logger.debug("m3u resolve failed", { url, error: String(err) });
			return {
				loadType: "error",
				data: { tracks: [] },
				exception: { message: String(err), severity: "common" },
			};
		}
	}

	async search(query: string): Promise<SourceResult> {
		return this.resolve(query);
	}

	async getTrackUrl(track: TrackInfo): Promise<TrackUrlResult> {
		return { url: track.uri, protocol: "http" };
	}

	async loadStream(_track: TrackInfo, url: string): Promise<TrackStreamResult> {
		try {
			const res = await fetch(url, {
				headers: { "User-Agent": this.ctx.userAgent },
				signal: AbortSignal.timeout(this.ctx.fetchTimeoutMs),
			});
			if (!res.ok || !res.body) {
				return {
					exception: { message: `Upstream responded ${res.status}`, severity: "common" },
				};
			}
			return { stream: res.body, type: res.headers.get("content-type") ?? undefined };
		} catch (err) {
			return { exception: { message: String(err), severity: "common" } };
		}
	}
}
