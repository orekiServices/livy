import { Hono } from "hono";
import { ValidationError } from "../../errors.js";
import type { StationService } from "../../stations/service.js";
import {
	CreatePlaylistSchema,
	CreateStationSchema,
	CreateStreamSourceSchema,
	ImportStationSchema,
	PaginationQuerySchema,
	UpdateStationSchema,
	UpdateStreamSourceSchema,
} from "../schemas.js";

export function stationRoutes(stations: StationService) {
	const app = new Hono();

	// ── Stations ──────────────────────────────────────────────────────────

	app.get("/", async (c) => {
		const query = PaginationQuerySchema.parse(c.req.query());
		const { items, total } = await stations.listStations(query);
		return c.json({ items, total, page: query.page, pageSize: query.pageSize });
	});

	app.post("/", async (c) => {
		const body = CreateStationSchema.parse(await c.req.json().catch(() => null));
		const station = await stations.createStation(body);
		return c.json(station, 201);
	});

	app.get("/:id", async (c) => {
		const station = await stations.getStation(c.req.param("id"));
		return c.json(station);
	});

	app.patch("/:id", async (c) => {
		const body = UpdateStationSchema.parse(await c.req.json().catch(() => null));
		const station = await stations.updateStation(c.req.param("id"), body);
		return c.json(station);
	});

	app.delete("/:id", async (c) => {
		await stations.deleteStation(c.req.param("id"));
		return c.body(null, 204);
	});

	// ── Import / export ───────────────────────────────────────────────────

	app.get("/:id/export", async (c) => {
		const data = await stations.exportStation(c.req.param("id"));
		return c.json(data);
	});

	app.post("/import", async (c) => {
		const body = ImportStationSchema.parse(await c.req.json().catch(() => null));
		const station = await stations.importStation(body);
		return c.json(station, 201);
	});

	// ── Stream sources ────────────────────────────────────────────────────

	app.get("/:id/streams", async (c) => {
		const streams = await stations.listStreams(c.req.param("id"));
		return c.json({ items: streams });
	});

	app.post("/:id/streams", async (c) => {
		const body = CreateStreamSourceSchema.parse(await c.req.json().catch(() => null));
		const source = await stations.createStream(c.req.param("id"), body);
		return c.json(source, 201);
	});

	app.patch("/:id/streams/:streamId", async (c) => {
		const body = UpdateStreamSourceSchema.parse(await c.req.json().catch(() => null));
		const source = await stations.updateStream(c.req.param("id"), c.req.param("streamId"), body);
		return c.json(source);
	});

	app.delete("/:id/streams/:streamId", async (c) => {
		await stations.deleteStream(c.req.param("id"), c.req.param("streamId"));
		return c.body(null, 204);
	});

	// ── Playlists ─────────────────────────────────────────────────────────

	app.get("/:id/playlists", async (c) => {
		const playlists = await stations.listPlaylists(c.req.param("id"));
		return c.json({ items: playlists });
	});

	app.post("/:id/playlists", async (c) => {
		const body = CreatePlaylistSchema.parse(await c.req.json().catch(() => null));
		const playlist = await stations.createPlaylist(c.req.param("id"), body);
		return c.json(playlist, 201);
	});

	app.delete("/:id/playlists/:playlistId", async (c) => {
		await stations.deletePlaylist(c.req.param("id"), c.req.param("playlistId"));
		return c.body(null, 204);
	});

	return app;
}

/** Parse JSON body or throw a validation error. */
export function parseJsonBody(value: unknown): unknown {
	if (value === null || value === undefined) {
		throw new ValidationError("Request body must be valid JSON");
	}
	return value;
}
