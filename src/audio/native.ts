import { createRequire } from "node:module";
import type { Logger } from "../logger.js";

/**
 * Native Rust addon loader (napi-rs).
 *
 * The addon is optional: when it has not been built (`bun run build:native`)
 * or `USE_NATIVE_AUDIO=false`, Livy falls back to pure-TypeScript
 * implementations. All native capabilities are probed once at startup.
 */

export interface NativeAudioInfo {
	available: boolean;
	version: string | null;
	codecs: string[];
}

interface NativeModule {
	version?: string;
	supportedCodecs?: string[];
	probeAudio?: (data: Uint8Array) => {
		codec: string;
		sampleRate: number;
		channels: number;
		durationMs: number;
	};
	parseHlsPlaylist?: (text: string, baseUrl: string) => unknown;
	icyParse?: (chunk: Uint8Array, metaint: number) => { audio: Uint8Array; metadata: string | null };
}

let cached: NativeModule | null | undefined;

function tryLoad(): NativeModule | null {
	if (cached !== undefined) return cached;
	const req = createRequire(import.meta.url);
	// Candidates resolved relative to this file (src/audio/ or dist/audio/).
	const candidates = [
		"../../native/livy-native.node",
		"../native/livy-native.node",
		"./livy-native.node",
		"../../native/livy-native.linux-x64-gnu.node",
	];
	for (const candidate of candidates) {
		try {
			cached = req(candidate) as NativeModule;
			return cached;
		} catch {
			// try next candidate
		}
	}
	cached = null;
	return null;
}

export function nativeInfo(logger: Logger): NativeAudioInfo {
	const mod = tryLoad();
	if (!mod) {
		logger.debug("native addon not found — using TypeScript fallback");
		return { available: false, version: null, codecs: [] };
	}
	logger.info("native addon loaded", { version: mod.version ?? "unknown" });
	return {
		available: true,
		version: mod.version ?? null,
		codecs: mod.supportedCodecs ?? ["mp3", "flac", "aac", "opus"],
	};
}

export function getNativeModule(): NativeModule | null {
	return tryLoad();
}
