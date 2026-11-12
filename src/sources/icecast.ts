import { icyMetaInt } from "../audio/codecs.js";
import { stripIcyMetadata } from "../audio/pipeline.js";
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
 * Icecast/Shoutcast source — ICY-protocol radio streams.
 *
 * Sends `Icy-MetaData: 1`, surfaces `icy-*` response headers (name,
 * description, genre, bitrate) as track metadata, and strips metadata
 * blocks from the audio stream while reporting `StreamTitle` changes.
 */
export class IcecastSource implements SourceInstance {
	readonly name = "icecast";
	readonly searchTerms = ["icecast:", "shoutcast:"];
	// Mount points (extensionless URLs) route here before the generic
	// HTTP source, which handles direct file URLs.
	readonly priority = 5;

	constructor(
		private readonly ctx: SourceContext,
		private readonly logger: Logger,
	) {}

	canHandle(identifier: string): boolean {
		// Icecast/Shoutcast URLs are plain http(s) audio URLs; this source
		// claims them when the URL has no file extension (typical mount
		// points like /stream, /live, /radio).
		if (!/^https?:\/\//i.test(identifier)) return false;
		const path = identifier.split("?")[0] ?? "";
		return !/\.[a-z0-9]{2,5}$/i.test(path);
	}

	async resolve(url: string): Promise<SourceResult> {
		try {
			const res = await fetch(url, {
				method: "HEAD",
				headers: { "User-Agent": this.ctx.userAgent, "Icy-MetaData": "1" },
				signal: AbortSignal.timeout(this.ctx.fetchTimeoutMs),
			});
			if (res.status >= 400) {
				return {
					loadType: "error",
					data: { tracks: [] },
					exception: { message: `Icecast mount unreachable: ${res.status}`, severity: "common" },
				};
			}
			const icyName = res.headers.get("icy-name") ?? "";
			const icyGenre = res.headers.get("icy-genre") ?? "";
			const icyBr = res.headers.get("icy-br") ?? "";
			const info = makeTrackInfo({
				identifier: url,
				uri: url,
				title: icyName || url,
				author: icyGenre || "Icecast",
				sourceName: "icecast",
				isStream: true,
			});
			return {
				loadType: "track",
				data: {
					tracks: [
						toTrackData(info, {
							icyName: icyName || null,
							icyGenre: icyGenre || null,
							icyBitrate: icyBr || null,
							icyMetaInt: icyMetaInt(res.headers),
						}),
					],
				},
			};
		} catch (err) {
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
		return { url: track.uri, protocol: "icecast" };
	}

	async loadStream(_track: TrackInfo, url: string): Promise<TrackStreamResult> {
		try {
			const res = await fetch(url, {
				headers: { "User-Agent": this.ctx.userAgent, "Icy-MetaData": "1" },
				signal: AbortSignal.timeout(this.ctx.fetchTimeoutMs),
			});
			if (!res.ok || !res.body) {
				return {
					exception: { message: `Upstream responded ${res.status}`, severity: "common" },
				};
			}
			const metaint = icyMetaInt(res.headers);
			let stream: ReadableStream<Uint8Array> = res.body;
			if (metaint) {
				stream = stripIcyMetadata(stream, metaint, (title) => {
					this.logger.debug("icecast metadata", { title });
				});
			}
			return { stream, type: res.headers.get("content-type") ?? undefined };
		} catch (err) {
			return { exception: { message: String(err), severity: "common" } };
		}
	}
}
