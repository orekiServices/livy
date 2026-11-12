import { sniffCodec } from "../src/audio/codecs.js";
/**
 * Benchmarks for performance-critical audio operations.
 * Run with: bun run bench
 *
 * Measures HLS parsing, codec sniffing and ICY stripping throughput.
 * When the native addon is built, the same operations are also timed
 * through the native bindings for comparison.
 */
import { parseHlsPlaylist } from "../src/audio/hls.js";
import { getNativeModule } from "../src/audio/native.js";
import { createAppLogger } from "../src/logger.js";

const logger = createAppLogger("error");

const MEDIA_PLAYLIST = [
	"#EXTM3U",
	"#EXT-X-VERSION:3",
	"#EXT-X-TARGETDURATION:10",
	"#EXT-X-MEDIA-SEQUENCE:100",
	...Array.from({ length: 50 }, (_, i) => `#EXTINF:9.5,\nseg${i}.ts`)
		.join("\n")
		.split("\n"),
	"#EXT-X-ENDLIST",
].join("\n");

const AUDIO_HEADER = new TextEncoder().encode("fLaC\x80\x00\x00\x00\x00\x00\x00\x00");

function bench(name: string, iterations: number, fn: () => void) {
	// Warmup
	for (let i = 0; i < Math.min(100, iterations); i++) fn();
	const start = performance.now();
	for (let i = 0; i < iterations; i++) fn();
	const elapsed = performance.now() - start;
	const perOp = (elapsed / iterations).toFixed(3);
	console.log(`${name}: ${iterations} ops in ${elapsed.toFixed(1)}ms (${perOp}ms/op)`);
}

console.log("Livy audio benchmarks\n");

bench("parseHlsPlaylist (50 segments)", 5000, () => {
	parseHlsPlaylist(MEDIA_PLAYLIST, "https://example.com/live/playlist.m3u8");
});

bench("sniffCodec (FLAC header)", 50000, () => {
	sniffCodec(AUDIO_HEADER);
});

const native = getNativeModule();
if (native?.probeAudio) {
	bench("native probeAudio", 50000, () => {
		native.probeAudio?.(AUDIO_HEADER);
	});
} else {
	logger.debug("native addon not built — skipping native benchmarks");
	console.log("(native addon not built — run `bun run build:native` for native timings)");
}

console.log("\nDone.");
