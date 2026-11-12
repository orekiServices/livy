import type { TrackData, TrackInfo } from "./types.js";

/**
 * Track encoding — Lavalink/NodeLink-compatible base64 JSON.
 *
 * `encodeTrack` serialises a TrackInfo into the opaque `encoded` string
 * clients pass back to the server; `decodeTrack` reverses it. The format is
 * versioned (`v: 1`) so future fields can be added without breaking clients.
 */

const ENCODE_VERSION = 1;

interface EncodedPayload {
	v: number;
	info: TrackInfo;
	pluginInfo: Record<string, unknown>;
}

export function makeTrackInfo(partial: Partial<TrackInfo> & { uri: string }): TrackInfo {
	return {
		identifier: partial.identifier ?? partial.uri,
		isSeekable: partial.isSeekable ?? false,
		author: partial.author ?? "Unknown",
		length: partial.length ?? 0,
		isStream: partial.isStream ?? true,
		position: partial.position ?? 0,
		title: partial.title ?? partial.uri,
		uri: partial.uri,
		artworkUrl: partial.artworkUrl ?? null,
		isrc: partial.isrc ?? null,
		sourceName: partial.sourceName ?? "http",
	};
}

export function encodeTrack(info: TrackInfo, pluginInfo: Record<string, unknown> = {}): string {
	const payload: EncodedPayload = { v: ENCODE_VERSION, info, pluginInfo };
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export function decodeTrack(encoded: string): TrackData {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
	} catch {
		throw new Error("Invalid encoded track: not base64 JSON");
	}
	const payload = parsed as Partial<EncodedPayload>;
	if (!payload?.info || typeof payload.info !== "object") {
		throw new Error("Invalid encoded track: missing info");
	}
	const info = payload.info as TrackInfo;
	if (typeof info.uri !== "string" || typeof info.title !== "string") {
		throw new Error("Invalid encoded track: info must include uri and title");
	}
	return {
		encoded,
		info: makeTrackInfo(info),
		pluginInfo: payload.pluginInfo ?? {},
	};
}

/** Build a TrackData from a TrackInfo (encodes it). */
export function toTrackData(info: TrackInfo, pluginInfo: Record<string, unknown> = {}): TrackData {
	return { encoded: encodeTrack(info, pluginInfo), info, pluginInfo };
}
