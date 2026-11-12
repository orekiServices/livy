import { Hono } from "hono";
import { nativeInfo } from "../audio/native.js";
import { publicConfig } from "../config.js";
import type { DatabaseAdapter } from "../db/adapter.js";
import { LivyError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
import type { SourceManager } from "../sources/manager.js";
import type { StationService } from "../stations/service.js";
import type { StreamService } from "../streams/service.js";
import type { LivyConfig, ServerInfo } from "../types.js";
import { cors, requestLogger, requireAuth } from "./middleware.js";
import { RateLimiter, rateLimitMiddleware } from "./ratelimit.js";
import { hlsRoutes } from "./routes/hls.js";
import { sourceRoutes } from "./routes/sources.js";
import { stationRoutes } from "./routes/stations.js";
import { streamRoutes } from "./routes/streams.js";

export interface AppDeps {
	config: LivyConfig;
	logger: Logger;
	db: DatabaseAdapter;
	stations: StationService;
	streams: StreamService;
	sources: SourceManager;
	metrics: Metrics;
	startedAt: number;
}

export function createApp(deps: AppDeps): Hono {
	const { config, logger, db, stations, streams, sources, metrics, startedAt } = deps;
	const app = new Hono();

	app.use("*", requestLogger(logger));
	app.use("*", cors(config.corsOrigins));

	// ── Health ────────────────────────────────────────────────────────────

	app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

	app.get("/ready", async (c) => {
		const health = await db.healthCheck();
		return c.json(
			{ ready: health.ok, database: health, ts: new Date().toISOString() },
			health.ok ? 200 : 503,
		);
	});

	// ── Metrics (Prometheus text exposition) ──────────────────────────────

	app.get("/metrics", (_c) => {
		metrics.setGauge("livy_uptime_seconds", Math.floor((Date.now() - startedAt) / 1000));
		metrics.setGauge("livy_active_sessions", streams.listSessions().length);
		return new Response(metrics.render(), {
			headers: { "Content-Type": "text/plain; version=0.0.4" },
		});
	});

	// ── Info / config ─────────────────────────────────────────────────────

	app.get("/api/v1/info", (c) => {
		const native = config.useNativeAudio
			? nativeInfo(logger)
			: { available: false, version: null, codecs: [] };
		const info: ServerInfo = {
			name: "livy",
			version: "0.1.0",
			nativeAvailable: native.available,
			nativeVersion: native.version,
			database: config.databaseType,
			uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
		};
		return c.json({
			...info,
			nativeCodecs: native.codecs,
			sources: sources.getEnabledSourceNames(),
		});
	});

	app.get("/api/v1/config", (c) => c.json(publicConfig(config)));

	app.get("/api/v1/db/status", async (c) => {
		const health = await db.healthCheck();
		return c.json({ type: db.type, ready: db.ready, health });
	});

	// ── Authenticated API ─────────────────────────────────────────────────

	const limiter = new RateLimiter(config.rateLimitMax, config.rateLimitWindowMs);
	setInterval(() => limiter.sweep(), config.rateLimitWindowMs).unref?.();

	const api = new Hono();
	api.use("*", rateLimitMiddleware(limiter));
	api.use("*", requireAuth(config.apiKey));
	api.route("/", sourceRoutes(sources));
	api.route("/", hlsRoutes(stations, logger));
	api.route("/stations", stationRoutes(stations));
	api.route("/stations", streamRoutes(stations, streams));
	app.route("/api/v1", api);

	// ── Error handling ────────────────────────────────────────────────────

	app.onError((err, c) => {
		if (err instanceof LivyError) {
			metrics.inc("livy_http_errors_total");
			return c.json(
				{ error: err.code, message: err.message, details: err.details },
				err.status as 400 | 401 | 404 | 409 | 429 | 502,
			);
		}
		// Zod validation errors
		const zodLike = err as { name?: string; issues?: unknown };
		if (zodLike.name === "ZodError") {
			return c.json(
				{
					error: "VALIDATION_ERROR",
					message: "Request validation failed",
					details: zodLike.issues,
				},
				400,
			);
		}
		metrics.inc("livy_http_errors_total");
		logger.error("unhandled error", { error: String(err) });
		return c.json({ error: "INTERNAL_ERROR", message: "Internal server error" }, 500);
	});

	app.notFound((c) =>
		c.json({ error: "NOT_FOUND", message: `No route: ${c.req.method} ${c.req.path}` }, 404),
	);

	return app;
}
