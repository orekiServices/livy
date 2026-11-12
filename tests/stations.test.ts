import { describe, expect, test } from "bun:test";
import { MemoryAdapter } from "../src/db/memory.js";
import { StationService } from "../src/stations/service.js";

async function setup() {
	const db = new MemoryAdapter();
	await db.init();
	return { db, stations: new StationService(db) };
}

describe("StationService", () => {
	test("creates a station with a derived slug", async () => {
		const { stations } = await setup();
		const station = await stations.createStation({ name: "Lo-Fi Beats" });
		expect(station.slug).toBe("lo-fi-beats");
		expect(station.status).toBe("idle");
	});

	test("rejects duplicate slugs", async () => {
		const { stations } = await setup();
		await stations.createStation({ name: "Jazz FM" });
		await expect(stations.createStation({ name: "Jazz FM" })).rejects.toThrow(/slug/i);
	});

	test("mirrors streamUrl into a primary source", async () => {
		const { stations } = await setup();
		const station = await stations.createStation({
			name: "Radio One",
			streamUrl: "https://example.com/stream.mp3",
		});
		const sources = await stations.listStreams(station.id);
		expect(sources).toHaveLength(1);
		expect(sources[0]?.url).toBe("https://example.com/stream.mp3");
		expect(sources[0]?.priority).toBe(1);
	});

	test("isolates stations from each other", async () => {
		const { stations } = await setup();
		const a = await stations.createStation({ name: "Station A" });
		const b = await stations.createStation({ name: "Station B" });
		await stations.createStream(a.id, { name: "S1", url: "https://a.example.com/1.mp3" });
		const bSources = await stations.listStreams(b.id);
		expect(bSources).toHaveLength(0);
	});

	test("updates and deletes stations", async () => {
		const { stations } = await setup();
		const station = await stations.createStation({ name: "Old Name" });
		const updated = await stations.updateStation(station.id, { name: "New Name" });
		expect(updated.name).toBe("New Name");
		await stations.deleteStation(station.id);
		await expect(stations.getStation(station.id)).rejects.toThrow(/not found/i);
	});

	test("exports and imports a station", async () => {
		const { stations } = await setup();
		const original = await stations.createStation({
			name: "Export Me",
			streamUrl: "https://example.com/x.mp3",
		});
		await stations.createPlaylist(original.id, {
			name: "Favourites",
			entries: [{ url: "https://example.com/a.mp3", title: "A" }],
		});
		const exported = await stations.exportStation(original.id);
		expect(exported.streams).toHaveLength(1);
		expect(exported.playlists).toHaveLength(1);

		await stations.deleteStation(original.id);
		const imported = await stations.importStation(exported);
		expect(imported.slug).toBe(original.slug);
		expect(imported.id).not.toBe(original.id);
	});
});
