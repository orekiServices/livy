import { mimeForCodec } from "../audio/codecs.js";
import { skipId3Tag } from "../audio/pipeline.js";
import type { DatabaseAdapter } from "../db/adapter.js";
import { CapacityError, NotFoundError, StreamError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { SourceManager } from "../sources/manager.js";
import type { PlaybackSession, StationStatusInfo } from "../types.js";

/**
 * Streaming service — manages playback sessions and proxies upstream
 * radio streams (Icecast/Shoutcast/HLS/direct) to listeners.
 *
 * Each station has an independent session registry, so stations never
 * interfere with each other. Upstream failover walks enabled sources in
 * priority order.
 */
export class StreamService {
	private sessions = new Map<string, PlaybackSession>();
	private stationSessions = new Map<string, Set<string>>();
	private stationStartedAt = new Map<string, number>();
	private activeControllers = new Map<string, AbortController>();

	constructor(
		private readonly db: DatabaseAdapter,
		private readonly logger: Logger,
		private readonly opts: { maxListenersPerStation: number; streamTimeoutMs: number },
		private readonly sources?: SourceManager,
	) {}

	// ── Session lifecycle ─────────────────────────────────────────────────

	async startSession(stationId: string): Promise<PlaybackSession> {
		const station = await this.db.getStation(stationId);
		if (!station) throw new NotFoundError("Station", stationId);

		const existing = this.stationSessions.get(stationId) ?? new Set<string>();
		if (existing.size >= this.opts.maxListenersPerStation) {
			throw new CapacityError(
				`Station ${stationId} has reached the listener limit (${this.opts.maxListenersPerStation})`,
			);
		}

		const session: PlaybackSession = {
			id: `ses_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
			stationId,
			state: "connecting",
			sourceUrl: null,
			bytesStreamed: 0,
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			error: null,
		};
		this.sessions.set(session.id, session);
		existing.add(session.id);
		this.stationSessions.set(stationId, existing);
		if (!this.stationStartedAt.has(stationId)) {
			this.stationStartedAt.set(stationId, Date.now());
		}
		this.logger.info("session started", { sessionId: session.id, stationId });
		return session;
	}

	getSession(sessionId: string): PlaybackSession | null {
		return this.sessions.get(sessionId) ?? null;
	}

	listSessions(stationId?: string): PlaybackSession[] {
		const all = [...this.sessions.values()];
		return stationId ? all.filter((s) => s.stationId === stationId) : all;
	}

	async stopSession(sessionId: string): Promise<boolean> {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		this.activeControllers.get(sessionId)?.abort();
		this.activeControllers.delete(sessionId);
		this.sessions.delete(sessionId);
		const set = this.stationSessions.get(session.stationId);
		set?.delete(sessionId);
		if (set && set.size === 0) {
			this.stationSessions.delete(session.stationId);
			this.stationStartedAt.delete(session.stationId);
		}
		this.logger.info("session stopped", { sessionId });
		return true;
	}

	async stopStationSessions(stationId: string): Promise<number> {
		const ids = [...(this.stationSessions.get(stationId) ?? [])];
		let stopped = 0;
		for (const id of ids) {
			if (await this.stopSession(id)) stopped++;
		}
		return stopped;
	}

	// ── Status ────────────────────────────────────────────────────────────

	async getStatus(stationId: string): Promise<StationStatusInfo> {
		const station = await this.db.getStation(stationId);
		if (!station) throw new NotFoundError("Station", stationId);
		const sessions = this.listSessions(stationId);
		const playing = sessions.filter((s) => s.state === "playing");
		const sources = await this.db.listStreams(stationId);
		const activeSource =
			playing.length > 0 ? (sources.find((s) => s.url === playing[0]?.sourceUrl) ?? null) : null;
		const startedAt = this.stationStartedAt.get(stationId);
		return {
			stationId,
			status: playing.length > 0 ? "playing" : sessions.length > 0 ? "buffering" : "idle",
			listenerCount: sessions.length,
			activeSource,
			nowPlaying: activeSource?.nowPlaying ?? null,
			uptimeSeconds: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
		};
	}

	// ── Proxy ─────────────────────────────────────────────────────────────

	/**
	 * Proxy the best available upstream source to a listener.
	 * Returns a Response whose body streams audio bytes.
	 * Throws StreamError when no source is reachable.
	 */
	async proxyStation(stationId: string, sessionId: string): Promise<Response> {
		const session = this.sessions.get(sessionId);
		if (!session || session.stationId !== stationId) {
			throw new NotFoundError("Session", sessionId);
		}

		const sources = (await this.db.listStreams(stationId)).filter((s) => s.enabled);
		if (sources.length === 0) {
			throw new StreamError(`Station ${stationId} has no enabled stream sources`);
		}

		const controller = new AbortController();
		this.activeControllers.set(sessionId, controller);
		const timeout = setTimeout(() => controller.abort(), this.opts.streamTimeoutMs);

		let lastError: unknown = null;
		for (const source of sources) {
			try {
				// Route through the source manager (http/icecast/hls/m3u/local)
				// so station sources get the same hardening as loadtracks:
				// HEAD validation, ICY handling, HLS segment following.
				let body: ReadableStream<Uint8Array> | null = null;
				let contentType = mimeForCodec(source.codec);

				if (this.sources) {
					const resolved = await this.sources.resolve(source.url);
					const first = resolved.data.tracks[0];
					if (first) {
						const loaded = await this.sources.getTrackStream(first.encoded);
						if (loaded.stream) {
							body = loaded.stream;
							contentType = loaded.type ?? contentType;
						} else {
							lastError = new Error(loaded.exception?.message ?? "Source stream failed");
						}
					} else {
						lastError = new Error(resolved.exception?.message ?? "Source resolve failed");
					}
				} else {
					const upstream = await fetch(source.url, {
						signal: controller.signal,
						headers: {
							"Icy-MetaData": "1",
							"User-Agent": "Livy/0.1",
							Accept: "*/*",
						},
					});
					if (!upstream.ok || !upstream.body) {
						lastError = new Error(`Upstream responded ${upstream.status}`);
						continue;
					}
					body = upstream.body;
				}

				if (!body) continue;
				clearTimeout(timeout);

				session.state = "playing";
				session.sourceUrl = source.url;
				session.updatedAt = new Date().toISOString();
				this.logger.info("proxying stream", {
					sessionId,
					stationId,
					source: source.name,
					url: source.url,
				});

				// Strip ID3v2 tags for clean MP3 output (NodeLink behaviour).
				body = skipId3Tag(body);

				// Track bytes streamed without buffering the whole body.
				const tracked = new ReadableStream<Uint8Array>({
					async pull(ctrl) {
						const reader = body.getReader();
						try {
							const { done, value } = await reader.read();
							if (done) {
								ctrl.close();
								return;
							}
							if (value) {
								session.bytesStreamed += value.length;
								ctrl.enqueue(value);
							}
						} catch (err) {
							ctrl.error(err);
						} finally {
							reader.releaseLock();
						}
					},
				});

				return new Response(tracked, {
					status: 200,
					headers: {
						"Content-Type": contentType,
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
						"X-Livy-Station": stationId,
						"X-Livy-Session": sessionId,
					},
				});
			} catch (err) {
				lastError = err;
				this.logger.warn("upstream source failed, trying next", {
					sessionId,
					source: source.name,
					error: String(err),
				});
			}
		}

		clearTimeout(timeout);
		session.state = "error";
		session.error = String(lastError);
		throw new StreamError(`All stream sources failed for station ${stationId}`, {
			cause: String(lastError),
		});
	}

	/** Record a now-playing title for a source (best-effort, logged). */
	async setNowPlaying(stationId: string, sourceId: string, title: string): Promise<void> {
		this.logger.debug("now playing", { stationId, sourceId, title });
	}
}
