import { Hono } from "hono";
import { ValidationError } from "../../errors.js";
import type { SourceManager } from "../../sources/manager.js";
import { decodeTrack } from "../../sources/track.js";

/**
 * Source + track resolution routes (NodeLink/Lavalink-inspired).
 *
 * - `GET /api/v1/sources` — list registered sources
 * - `GET /api/v1/sources/health` — run health probes
 * - `GET /api/v1/loadtracks?identifier=` — resolve URL / `source:query` → tracks
 * - `GET /api/v1/trackstream?encoded=` — direct stream URL for an encoded track
 */
export function sourceRoutes(sources: SourceManager) {
	const app = new Hono();

	app.get("/sources", (c) => {
		return c.json({ items: sources.listHealth() });
	});

	app.get("/sources/health", async (c) => {
		const health = await sources.probeAll();
		return c.json({ items: health });
	});

	app.get("/loadtracks", async (c) => {
		const identifier = c.req.query("identifier");
		if (!identifier) {
			throw new ValidationError("identifier query parameter is required");
		}
		const result = await sources.resolve(identifier);
		return c.json(result);
	});

	app.get("/trackstream", async (c) => {
		const encoded = c.req.query("encoded");
		if (!encoded) {
			throw new ValidationError("encoded query parameter is required");
		}
		// Validate the track decodes before resolving.
		decodeTrack(encoded);
		const result = await sources.getTrackUrl(encoded);
		if (!result.url) {
			throw new ValidationError(result.exception?.message ?? "Could not resolve track URL");
		}
		return c.json({ url: result.url, protocol: result.protocol, format: result.format });
	});

	return app;
}
