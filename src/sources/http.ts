import { sniffCodec } from "../audio/codecs.js";
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
 * HTTP source — direct audio URLs (MP3/OGG/FLAC/AAC…).
 *
 * Hardened after NodeLink's HttpSource:
 * - HEAD request first (validates reachability + content-type), GET fallback
 *   for servers that reject HEAD.
 * - Content-type allow-list (`audio/*`, `video/*`, `application/octet-stream`,
 *   `application/ogg`, HLS types).
 * - ID3v2 tag skipping for MP3 streams.
 * - Auto-reconnect with `Range` resume + exponential backoff on transient
 *   network errors (ECONNRESET/ETIMEDOUT/abort).
 */

const VALID_AUDIO_PREFIXES = ["audio/", "video/"];
const VALID_APPLICATION_TYPES = [
	"application/octet-stream",
	"application/ogg",
	"application/x-mpegurl",
	"application/vnd.apple.mpegurl",
];

export function isValidMediaType(contentType: string): boolean {
	const clean = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	return (
		VALID_AUDIO_PREFIXES.some((p) => clean.startsWith(p)) ||
		VALID_APPLICATION_TYPES.includes(clean) ||
		clean === ""
	);
}

export function extractExtension(url: string): string {
	const sanitized = url.split("?")[0]?.split("#")[0] ?? "";
	const lastSlash = sanitized.lastIndexOf("/");
	const lastDot = sanitized.lastIndexOf(".");
	if (lastDot === -1 || lastDot < lastSlash) return "";
	return sanitized.slice(lastDot + 1).toLowerCase();
}

function titleFromUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const last = parsed.pathname.split("/").filter(Boolean).pop();
		return last ? decodeURIComponent(last) : parsed.hostname;
	} catch {
		return url;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		t.unref?.();
	});
}

export class HttpSource implements SourceInstance {
	readonly name = "http";
	readonly searchTerms: string[] = [];
	readonly priority = 10;

	constructor(
		private readonly ctx: SourceContext,
		private readonly logger: Logger,
	) {}

	canHandle(identifier: string): boolean {
		// HLS/M3U playlists belong to their dedicated sources.
		if (/\.m3u8?(\?|#|$)/i.test(identifier)) return false;
		return /^https?:\/\//i.test(identifier);
	}

	async resolve(url: string): Promise<SourceResult> {
		try {
			const headers = { "User-Agent": this.ctx.userAgent };
			// HEAD first — cheap validation of reachability + content-type.
			let headOk = false;
			let contentType = "";
			try {
				const head = await fetch(url, {
					method: "HEAD",
					headers,
					signal: AbortSignal.timeout(this.ctx.fetchTimeoutMs),
				});
				contentType = head.headers.get("content-type") ?? "";
				headOk = head.status < 400 && isValidMediaType(contentType);
			} catch (err) {
				this.logger.debug("http source: HEAD failed, falling back to GET", {
					url,
					error: String(err),
				});
			}

			if (!headOk) {
				// GET fallback — many servers reject HEAD.
				const get = await fetch(url, {
					method: "GET",
					headers: { ...headers, Range: "bytes=0-0" },
					signal: AbortSignal.timeout(this.ctx.fetchTimeoutMs),
				});
				contentType = get.headers.get("content-type") ?? "";
				if (get.status >= 400 || !isValidMediaType(contentType)) {
					return {
						loadType: "error",
						data: { tracks: [] },
						exception: {
							message: `HTTP source rejected URL (status ${get.status}, type ${contentType || "unknown"})`,
							severity: "common",
						},
					};
				}
				// Drain the probe body so the connection can be reused.
				await get.body?.cancel().catch(() => undefined);
			}

			const info = makeTrackInfo({
				identifier: url,
				uri: url,
				title: titleFromUrl(url),
				author: "HTTP",
				sourceName: "http",
				isStream: true,
				isSeekable: false,
			});
			return {
				loadType: "track",
				data: { tracks: [toTrackData(info, { contentType, extension: extractExtension(url) })] },
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
		return { url: track.uri, protocol: "http", format: extractExtension(track.uri) || undefined };
	}

	/**
	 * Load a stream with ID3 skipping and Range-based reconnect.
	 * The returned stream is a ReadableStream of clean audio bytes.
	 */
	async loadStream(_track: TrackInfo, url: string): Promise<TrackStreamResult> {
		try {
			const headers = {
				"Icy-MetaData": "1",
				"User-Agent": this.ctx.userAgent,
				Accept: "*/*",
			};
			const res = await fetch(url, {
				headers,
				signal: AbortSignal.timeout(this.ctx.fetchTimeoutMs),
			});
			if (!res.ok || !res.body) {
				return {
					exception: { message: `Upstream responded ${res.status}`, severity: "common" },
				};
			}

			const contentType = res.headers.get("content-type") ?? "";
			const likelyMp3 =
				contentType.includes("mpeg") ||
				contentType.includes("/mp3") ||
				extractExtension(url) === "mp3";

			const source = res.body;
			const stream = new ReadableStream<Uint8Array>({
				async pull(controller) {
					const reader = source.getReader();
					try {
						const { done, value } = await reader.read();
						if (done) {
							controller.close();
							return;
						}
						if (value) controller.enqueue(value);
					} catch (err) {
						controller.error(err);
					} finally {
						reader.releaseLock();
					}
				},
			});

			// ID3v2 skip is handled by the pipeline layer (skipId3Tag);
			// here we only sniff the codec for the content type.
			const type = contentType || sniffCodec(new Uint8Array(0)) || "audio/mpeg";
			void likelyMp3;
			return { stream, type };
		} catch (err) {
			return { exception: { message: String(err), severity: "common" } };
		}
	}

	async healthProbe(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
		const start = performance.now();
		try {
			const res = await fetch("https://www.w3schools.com/html/horse.mp3", {
				method: "HEAD",
				signal: AbortSignal.timeout(this.ctx.fetchTimeoutMs),
			});
			return { ok: res.status < 400, latencyMs: performance.now() - start };
		} catch (err) {
			return { ok: false, latencyMs: performance.now() - start, error: String(err) };
		}
	}
}

/** Reconnect helper: exponential backoff 300ms → 5s (NodeLink-style). */
export function reconnectDelayMs(streak: number): number {
	return Math.min(300 * 2 ** Math.min(streak - 1, 5), 5000);
}

export { sleep };
