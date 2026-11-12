import { createDecipheriv } from "node:crypto";
import { parseHlsPlaylist } from "../audio/hls.js";
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
 * HLS source — M3U8 playlists (master + media).
 *
 * Modelled on NodeLink's HLS pipeline (PlaylistParser + SegmentFetcher +
 * AESDecryptor):
 * - Master playlists: pick the highest-bandwidth variant.
 * - Media playlists: expose segments; live windows are supported via
 *   `mediaSequence` + `isEndList`.
 * - AES-128-CBC segment decryption (`#EXT-X-KEY`) is applied on the fly
 *   when proxying segments.
 */

export class HlsSource implements SourceInstance {
	readonly name = "hls";
	readonly searchTerms = ["hls:"];
	readonly priority = 20;

	constructor(
		private readonly ctx: SourceContext,
		private readonly logger: Logger,
	) {}

	canHandle(identifier: string): boolean {
		return /\.m3u8(\?|#|$)/i.test(identifier);
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
					exception: { message: `HLS playlist fetch failed: ${res.status}`, severity: "common" },
				};
			}
			const text = await res.text();
			const playlist = parseHlsPlaylist(text, url);

			if (playlist.isMaster) {
				// Pick highest-bandwidth variant.
				const best = [...playlist.variants].sort(
					(a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0),
				)[0];
				if (!best) {
					return {
						loadType: "error",
						data: { tracks: [] },
						exception: { message: "HLS master playlist has no variants", severity: "common" },
					};
				}
				const info = makeTrackInfo({
					identifier: url,
					uri: best.url,
					title: `HLS stream (${best.resolution ?? "unknown"})`,
					author: "HLS",
					sourceName: "hls",
					isStream: true,
				});
				return {
					loadType: "track",
					data: {
						tracks: [toTrackData(info, { playlistUrl: url, variantUrl: best.url })],
					},
				};
			}

			const info = makeTrackInfo({
				identifier: url,
				uri: url,
				title: "HLS media playlist",
				author: "HLS",
				sourceName: "hls",
				isStream: !playlist.isEndList,
			});
			return {
				loadType: "track",
				data: {
					tracks: [
						toTrackData(info, {
							playlistUrl: url,
							segments: playlist.segments.length,
							isLive: !playlist.isEndList,
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
		return { url: track.uri, protocol: "hls", format: "m3u8" };
	}

	/**
	 * Load the media playlist's segments as a concatenated stream.
	 * For live playlists only the current window is streamed (one-shot);
	 * continuous live following is handled by the HLS proxy endpoint.
	 */
	async loadStream(track: TrackInfo, url: string): Promise<TrackStreamResult> {
		try {
			const res = await fetch(url, {
				headers: { "User-Agent": this.ctx.userAgent },
				signal: AbortSignal.timeout(this.ctx.fetchTimeoutMs),
			});
			if (!res.ok) {
				return {
					exception: { message: `HLS playlist fetch failed: ${res.status}`, severity: "common" },
				};
			}
			const text = await res.text();
			const playlist = parseHlsPlaylist(text, url);
			if (playlist.isMaster) {
				// Resolve to the best variant and recurse once.
				const best = [...playlist.variants].sort(
					(a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0),
				)[0];
				if (!best) {
					return {
						exception: { message: "HLS master playlist has no variants", severity: "common" },
					};
				}
				return this.loadStream(track, best.url);
			}

			const segments = playlist.segments;
			if (segments.length === 0) {
				return {
					exception: { message: "HLS media playlist has no segments", severity: "common" },
				};
			}

			const ctx = this.ctx;
			const logger = this.logger;
			const stream = new ReadableStream<Uint8Array>({
				async pull(controller) {
					for (const seg of segments) {
						try {
							const segRes = await fetch(seg.url, {
								headers: { "User-Agent": ctx.userAgent },
								signal: AbortSignal.timeout(ctx.fetchTimeoutMs),
							});
							if (!segRes.ok || !segRes.body) continue;
							const reader = segRes.body.getReader();
							while (true) {
								const { done, value } = await reader.read();
								if (done) break;
								if (value) controller.enqueue(value);
							}
							reader.releaseLock();
						} catch (err) {
							logger.debug("hls segment failed", { url: seg.url, error: String(err) });
						}
					}
					controller.close();
				},
			});
			return { stream, type: "video/mp2t" };
		} catch (err) {
			return { exception: { message: String(err), severity: "common" } };
		}
	}

	async healthProbe(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
		const start = performance.now();
		try {
			const res = await fetch("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8", {
				headers: { "User-Agent": this.ctx.userAgent },
				signal: AbortSignal.timeout(this.ctx.fetchTimeoutMs),
			});
			return { ok: res.ok, latencyMs: performance.now() - start };
		} catch (err) {
			return { ok: false, latencyMs: performance.now() - start, error: String(err) };
		}
	}
}

/**
 * Decrypt an AES-128-CBC HLS segment (NodeLink AESDecryptor equivalent).
 * Returns the input unchanged when key/iv are missing.
 */
export function decryptAes128(
	data: Uint8Array,
	key: Uint8Array | null,
	iv: Uint8Array | null,
): Uint8Array {
	if (!key || !iv) return data;
	try {
		const decipher = createDecipheriv("aes-128-cbc", Buffer.from(key), Buffer.from(iv));
		decipher.setAutoPadding(false);
		return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(data)), decipher.final()]));
	} catch {
		return data;
	}
}
