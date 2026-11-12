import { describe, expect, test } from "bun:test";
import { createAppLogger } from "../src/logger.js";
import { decryptAes128 } from "../src/sources/hls.js";
import { isValidMediaType, reconnectDelayMs } from "../src/sources/http.js";
import { createSourceManager } from "../src/sources/manager.js";
import { decodeTrack, encodeTrack, makeTrackInfo } from "../src/sources/track.js";

const logger = createAppLogger("error");

function manager() {
	return createSourceManager(logger, { userAgent: "Livy/test", fetchTimeoutMs: 2000 });
}

describe("track encoding", () => {
	test("round-trips through encode/decode", () => {
		const info = makeTrackInfo({ uri: "https://example.com/a.mp3", title: "Song A" });
		const encoded = encodeTrack(info, { foo: "bar" });
		const decoded = decodeTrack(encoded);
		expect(decoded.info.uri).toBe("https://example.com/a.mp3");
		expect(decoded.info.title).toBe("Song A");
		expect(decoded.pluginInfo.foo).toBe("bar");
	});

	test("rejects invalid encoded tracks", () => {
		expect(() => decodeTrack("!!!not-base64-json!!!")).toThrow();
		expect(() => decodeTrack(Buffer.from("{}").toString("base64"))).toThrow();
	});
});

describe("source routing", () => {
	test("routes by source: prefix", () => {
		const m = manager();
		expect(m.findSource("hls:https://example.com/live.m3u8")?.name).toBe("hls");
		expect(m.findSource("local:/music/a.mp3")?.name).toBe("local");
		expect(m.findSource("m3u:https://example.com/list.m3u")?.name).toBe("m3u");
	});

	test("routes bare URLs by pattern", () => {
		const m = manager();
		expect(m.findSource("https://example.com/live.m3u8")?.name).toBe("hls");
		expect(m.findSource("https://example.com/song.mp3")?.name).toBe("http");
		expect(m.findSource("https://example.com/stream")?.name).toBe("icecast");
	});

	test("lists registered sources", () => {
		const m = manager();
		const names = m.getEnabledSourceNames();
		expect(names).toContain("http");
		expect(names).toContain("hls");
		expect(names).toContain("icecast");
		expect(names).toContain("m3u");
		expect(names).toContain("local");
	});

	test("resolve returns error for unhandled identifiers", async () => {
		const m = manager();
		const result = await m.resolve("ftp://example.com/file.mp3");
		expect(result.loadType).toBe("error");
	});
});

describe("http source helpers", () => {
	test("validates media types", () => {
		expect(isValidMediaType("audio/mpeg")).toBe(true);
		expect(isValidMediaType("audio/ogg; codecs=opus")).toBe(true);
		expect(isValidMediaType("application/vnd.apple.mpegurl")).toBe(true);
		expect(isValidMediaType("text/html")).toBe(false);
		expect(isValidMediaType("")).toBe(true);
	});

	test("reconnect backoff caps at 5s", () => {
		expect(reconnectDelayMs(1)).toBe(300);
		expect(reconnectDelayMs(2)).toBe(600);
		expect(reconnectDelayMs(10)).toBe(5000);
	});
});

describe("HLS AES decryption", () => {
	test("passes through without key/iv", () => {
		const data = new Uint8Array([1, 2, 3]);
		expect(decryptAes128(data, null, null)).toBe(data);
	});
});
