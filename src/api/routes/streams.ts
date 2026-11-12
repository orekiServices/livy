import { Hono } from "hono";
import { NotFoundError } from "../../errors.js";
import type { StationService } from "../../stations/service.js";
import type { StreamService } from "../../streams/service.js";

export function streamRoutes(stations: StationService, streams: StreamService) {
	const app = new Hono();

	// Start a playback session for a station.
	app.post("/:id/play", async (c) => {
		await stations.getStation(c.req.param("id"));
		const session = await streams.startSession(c.req.param("id"));
		return c.json(session, 201);
	});

	// Stream audio to a listener. Requires ?session=<id>.
	app.get("/:id/stream", async (c) => {
		const stationId = c.req.param("id");
		const sessionId = c.req.query("session");
		if (!sessionId) {
			throw new NotFoundError("Session", "(missing ?session= query param)");
		}
		return streams.proxyStation(stationId, sessionId);
	});

	// Station status (listener count, active source, now playing).
	app.get("/:id/status", async (c) => {
		const status = await streams.getStatus(c.req.param("id"));
		return c.json(status);
	});

	// Stop all sessions for a station.
	app.post("/:id/stop", async (c) => {
		const stopped = await streams.stopStationSessions(c.req.param("id"));
		return c.json({ stopped });
	});

	// List sessions (optionally filtered by station).
	app.get("/sessions", async (c) => {
		const stationId = c.req.query("stationId");
		return c.json({ items: streams.listSessions(stationId) });
	});

	// Stop a single session.
	app.delete("/sessions/:sessionId", async (c) => {
		const stopped = await streams.stopSession(c.req.param("sessionId"));
		if (!stopped) throw new NotFoundError("Session", c.req.param("sessionId"));
		return c.body(null, 204);
	});

	return app;
}
