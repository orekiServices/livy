import type { AudioCodec } from "../types.js";

/**
 * Codec detection helpers (TypeScript fallback).
 * The Rust native module provides the same functions with higher fidelity;
 * these implementations cover header sniffing and MIME mapping.
 */

const MIME_BY_CODEC: Record<AudioCodec, string> = {
	mp3: "audio/mpeg",
	aac: "audio/aac",
	flac: "audio/flac",
	opus: "audio/ogg; codecs=opus",
	vorbis: "audio/ogg; codecs=vorbis",
	unknown: "application/octet-stream",
};

export function mimeForCodec(codec: AudioCodec): string {
	return MIME_BY_CODEC[codec];
}

/** Sniff codec from the first bytes of a stream (ID3 / frame sync / OggS / fLaC / ADTS). */
export function sniffCodec(header: Uint8Array): AudioCodec {
	if (header.length >= 4) {
		// ID3v2 tag → MP3
		if (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) return "mp3";
		// fLaC magic
		if (header[0] === 0x66 && header[1] === 0x4c && header[2] === 0x61 && header[3] === 0x43) {
			return "flac";
		}
		// OggS → Opus or Vorbis (peek for "OpusHead" / "vorbis")
		if (header[0] === 0x4f && header[1] === 0x67 && header[2] === 0x67 && header[3] === 0x53) {
			const text = new TextDecoder("latin1").decode(header);
			if (text.includes("OpusHead")) return "opus";
			return "vorbis";
		}
		// ADTS sync (0xFFF) → AAC
		if (header[0] === 0xff && ((header[1] ?? 0) & 0xf6) === 0xf0) return "aac";
		// MP3 frame sync (0xFFE / 0xFFF variants)
		if (header[0] === 0xff && ((header[1] ?? 0) & 0xe0) === 0xe0) return "mp3";
	}
	return "unknown";
}

/** Map a URL or MIME type to a codec guess. */
export function codecFromUrl(url: string): AudioCodec {
	const lower = url.toLowerCase();
	if (lower.endsWith(".mp3") || lower.includes("audio/mpeg")) return "mp3";
	if (lower.endsWith(".flac") || lower.includes("audio/flac")) return "flac";
	if (lower.endsWith(".aac") || lower.endsWith(".m4a") || lower.includes("audio/aac")) return "aac";
	if (lower.endsWith(".ogg") || lower.endsWith(".opus") || lower.includes("opus")) return "opus";
	return "unknown";
}

/** Parse ICY metadata interval from response headers (Shoutcast/Icecast). */
export function icyMetaInt(headers: Headers): number | null {
	const value = headers.get("icy-metaint") ?? headers.get("x-icy-metaint");
	if (!value) return null;
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}
