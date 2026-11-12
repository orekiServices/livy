import { describe, expect, test } from "bun:test";
import { createApp } from "../src/api/server.js";
import { loadConfig } from "../src/config.js";
import { MemoryAdapter } from "../src/db/memory.js";
import { createAppLogger } from "../src/logger.js";
import { StationService } from "../src/stations/service.js";
import { StreamService } from "../src/streams/service.js";

async function setup() {
	const config = loadConfig({ DATABASE_TYPE: "memory", LOG_LEVEL: "error" });
	const logger = createAppLogger("error");
	const db = new MemoryAdapter();
	await db.init();
	const stations = new StationService(db);
	const streams = new StreamService(db, logger, {
		maxListenersPerStation: 10,
		streamTimeoutMs: 5000,
	});
	const app = createApp({ config, logger, db, stations, streams, startedAt: Date.now() });
	return { app, stations, streams };
}

describe("HTTP API", () => {
	test("health and info endpoints", async () => {
		const { app } = await setup();
		const health = await app.request("/health");
		expect(health.status).toBe(200);
		const info = await app.request("/api/v1/info");
		expect(info.status).toBe(200);
		const body = (await info.json()) as { name: string; database: string };
		expect(body.name).toBe("livy");
		expect(body.database).toBe("memory");
	});

	test("station CRUD over HTTP", async () => {
		const { app } = await setup();
		const created = await app.request("/api/v1/stations", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Test Radio", streamUrl: "https://example.com/s.mp3" }),
		});
		expect(created.status).toBe(201);
		const station = (await created.json()) as { id: string; slug: string };
		expect(station.slug).toBe("test-radio");

		const list = await app.request("/api/v1/stations");
		expect(list.status).toBe(200);
		const listBody = (await list.json()) as { total: number };
		expect(listBody.total).toBe(1);

		const streams = await app.request(`/api/v1/stations/${station.id}/streams`);
		const streamsBody = (await streams.json()) as { items: unknown[] };
		expect(streamsBody.items).toHaveLength(1);

		const status = await app.request(`/api/v1/stations/${station.id}/status`);
		expect(status.status).toBe(200);

		const del = await app.request(`/api/v1/stations/${station.id}`, { method: "DELETE" });
		expect(del.status).toBe(204);
	});

	test("validation errors return 400", async () => {
		const { app } = await setup();
		const res = await app.request("/api/v1/stations", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "" }),
		});
		expect(res.status).toBe(400);
	});

	test("unknown routes return 404", async () => {
		const { app } = await setup();
		const res = await app.request("/nope");
		expect(res.status).toBe(404);
	});
});
