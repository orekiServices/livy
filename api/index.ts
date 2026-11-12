import { createApp } from "../src/api/server.js";
/**
 * Vercel Serverless entry point.
 *
 * Serverless functions are stateless and time-limited, so continuous radio
 * streaming cannot run here. This handler exposes the management API
 * (stations, sources, playlists, config, health) backed by an external
 * database (Postgres). Audio streaming must run on a persistent host —
 * see `deplexo.yaml` / `Dockerfile` for the Deplexo/self-hosted runtime.
 *
 * Vercel routes all `/api/*` requests to this function (see vercel.json).
 */
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/factory.js";
import { createAppLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import { createSourceManager } from "../src/sources/manager.js";
import { StationService } from "../src/stations/service.js";
import { StreamService } from "../src/streams/service.js";

const startedAt = Date.now();
const config = loadConfig();
const logger = createAppLogger(config.logLevel);

// Serverless functions are stateless: use an ephemeral in-memory DB unless
// DATABASE_TYPE points at an external database (postgres recommended).
const db = createDatabase(config);
await db.init().catch((err) => {
	logger.error("database init failed", { error: String(err) });
});

const sources = createSourceManager(
	logger,
	{ userAgent: "Livy/0.1", fetchTimeoutMs: config.streamTimeoutMs },
	config.defaultSearchSource,
);

const stations = new StationService(db);
const streams = new StreamService(
	db,
	logger,
	{
		maxListenersPerStation: config.maxListenersPerStation,
		streamTimeoutMs: config.streamTimeoutMs,
	},
	sources,
);
const metrics = new Metrics();

const app = createApp({ config, logger, db, stations, streams, sources, metrics, startedAt });

export default app.fetch;
