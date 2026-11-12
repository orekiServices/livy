import { describe, expect, test } from "bun:test";
import { MemoryAdapter } from "../src/db/memory.js";
import { createAppLogger } from "../src/logger.js";
import { StationService } from "../src/stations/service.js";
import { StreamService } from "../src/streams/service.js";

async function setup() {
	const db = new MemoryAdapter();
	await db.init();
	const logger = createAppLogger("error");
	const stations = new StationService(db);
	const streams = new StreamService(db, logger, {
		maxListenersPerStation: 2,
		streamTimeoutMs: 5000,
	});
	return { db, stations, streams };
}

describe("StreamService", () => {
	test("starts and stops sessions", async () => {
		const { stations, streams } = await setup();
		const station = await stations.createStation({ name: "S" });
		const session = await streams.startSession(station.id);
		expect(session.state).toBe("connecting");
		expect(streams.listSessions(station.id)).toHaveLength(1);
		const stopped = await streams.stopSession(session.id);
		expect(stopped).toBe(true);
		expect(streams.listSessions(station.id)).toHaveLength(0);
	});

	test("enforces listener capacity", async () => {
		const { stations, streams } = await setup();
		const station = await stations.createStation({ name: "S" });
		await streams.startSession(station.id);
		await streams.startSession(station.id);
		await expect(streams.startSession(station.id)).rejects.toThrow(/limit/i);
	});

	test("reports idle status without sessions", async () => {
		const { stations, streams } = await setup();
		const station = await stations.createStation({ name: "S" });
		const status = await streams.getStatus(station.id);
		expect(status.status).toBe("idle");
		expect(status.listenerCount).toBe(0);
	});

	test("proxy fails cleanly with no sources", async () => {
		const { stations, streams } = await setup();
		const station = await stations.createStation({ name: "S" });
		const session = await streams.startSession(station.id);
		await expect(streams.proxyStation(station.id, session.id)).rejects.toThrow(/no enabled/i);
	});
});
