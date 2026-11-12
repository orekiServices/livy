#!/usr/bin/env bun
import { createApp } from "./api/server.js";
import { nativeInfo } from "./audio/native.js";
/**
 * Livy — TypeScript & Rust hybrid radio streaming server.
 *
 * Entry point for persistent deployments (Bun or Node.js).
 * For serverless deployments use `api/index.ts` (Vercel) instead —
 * continuous streaming cannot run inside serverless functions.
 */
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/factory.js";
import { createAppLogger } from "./logger.js";
import { StationService } from "./stations/service.js";
import { StreamService } from "./streams/service.js";

const startedAt = Date.now();
const config = loadConfig();
const logger = createAppLogger(config.logLevel);

logger.info("starting livy", {
	host: config.host,
	port: config.port,
	database: config.databaseType,
	auth: config.apiKey !== null,
});

const db = createDatabase(config);
await db.init();
logger.info("database ready", { type: db.type });

const stations = new StationService(db);
const streams = new StreamService(db, logger, {
	maxListenersPerStation: config.maxListenersPerStation,
	streamTimeoutMs: config.streamTimeoutMs,
});

if (config.useNativeAudio) {
	const native = nativeInfo(logger);
	logger.info("native audio", { available: native.available, version: native.version });
} else {
	logger.info("native audio disabled by config");
}

const app = createApp({ config, logger, db, stations, streams, startedAt });

// Bun.serve when running under Bun; Node's http adapter otherwise.
const bunGlobal = globalThis as unknown as {
	Bun?: { serve: (opts: Record<string, unknown>) => unknown };
};

let server: { stop?: () => void } | null = null;

if (bunGlobal.Bun) {
	server = bunGlobal.Bun.serve({
		hostname: config.host,
		port: config.port,
		fetch: app.fetch,
	}) as { stop?: () => void };
	logger.info("listening", { host: config.host, port: config.port, runtime: "bun" });
} else {
	const { serve } = await import("@hono/node-server");
	server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }) as unknown as {
		stop?: () => void;
	};
	logger.info("listening", { host: config.host, port: config.port, runtime: "node" });
}

// ── Graceful shutdown ─────────────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info("shutting down", { signal });
	try {
		server?.stop?.();
	} catch {
		// ignore
	}
	await db.close();
	logger.info("shutdown complete");
	process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
