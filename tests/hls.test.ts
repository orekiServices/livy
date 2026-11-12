import { describe, expect, test } from "bun:test";
import { sniffCodec } from "../src/audio/codecs.js";
import { parseHlsPlaylist, parseM3u, toM3u } from "../src/audio/hls.js";
import { parseIcyMetadata } from "../src/audio/pipeline.js";

describe("HLS parsing", () => {
	test("parses a media playlist", () => {
		const text = [
			"#EXTM3U",
			"#EXT-X-VERSION:3",
			"#EXT-X-TARGETDURATION:10",
			"#EXT-X-MEDIA-SEQUENCE:42",
			"#EXTINF:9.5,",
			"seg1.ts",
			"#EXTINF:9.5,",
			"seg2.ts",
			"#EXT-X-ENDLIST",
		].join("\n");
		const pl = parseHlsPlaylist(text, "https://example.com/live/playlist.m3u8");
		expect(pl.isMaster).toBe(false);
		expect(pl.segments).toHaveLength(2);
		expect(pl.segments[0]?.sequence).toBe(42);
		expect(pl.segments[0]?.url).toBe("https://example.com/live/seg1.ts");
		expect(pl.isEndList).toBe(true);
	});

	test("parses a master playlist", () => {
		const text = [
			"#EXTM3U",
			"#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
			"low.m3u8",
			"#EXT-X-STREAM-INF:BANDWIDTH=2000000",
			"mid.m3u8",
		].join("\n");
		const pl = parseHlsPlaylist(text, "https://example.com/master.m3u8");
		expect(pl.isMaster).toBe(true);
		expect(pl.variants).toHaveLength(2);
		expect(pl.variants[0]?.bandwidth).toBe(800000);
	});

	test("rejects invalid playlists", () => {
		expect(() => parseHlsPlaylist("nope", "https://x/")).toThrow(/EXTM3U/);
	});
});

describe("M3U parsing", () => {
	test("round-trips entries", () => {
		const text =
			"#EXTM3U\n#EXTINF:-1,My Song\nhttps://example.com/a.mp3\nhttps://example.com/b.mp3\n";
		const entries = parseM3u(text);
		expect(entries).toHaveLength(2);
		expect(entries[0]?.title).toBe("My Song");
		const out = toM3u(entries);
		expect(out).toContain("#EXTM3U");
		expect(out).toContain("https://example.com/a.mp3");
	});
});

describe("ICY metadata", () => {
	test("extracts StreamTitle", () => {
		const block = new TextEncoder().encode("StreamTitle='Artist - Title';");
		expect(parseIcyMetadata(block)).toBe("Artist - Title");
	});

	test("returns null when absent", () => {
		expect(parseIcyMetadata(new TextEncoder().encode("nothing"))).toBeNull();
	});
});

describe("codec sniffing", () => {
	test("detects FLAC magic", () => {
		expect(sniffCodec(new TextEncoder().encode("fLaC...."))).toBe("flac");
	});

	test("detects ID3 MP3", () => {
		expect(sniffCodec(new TextEncoder().encode("ID3...."))).toBe("mp3");
	});

	test("detects ADTS AAC", () => {
		expect(sniffCodec(new Uint8Array([0xff, 0xf1, 0x50, 0x80]))).toBe("aac");
	});
});
