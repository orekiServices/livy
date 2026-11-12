/**
 * M3U8 / HLS playlist parser (TypeScript fallback).
 * The Rust native module provides an equivalent parser for hot paths.
 */

export interface HlsSegment {
	url: string;
	duration: number;
	sequence: number;
}

export interface HlsPlaylist {
	isMaster: boolean;
	/** For master playlists: variant URLs. */
	variants: { url: string; bandwidth: number | null; resolution: string | null }[];
	/** For media playlists: segments in order. */
	segments: HlsSegment[];
	targetDuration: number | null;
	mediaSequence: number;
	isEndList: boolean;
	version: number | null;
}

function resolveUrl(base: string, relative: string): string {
	try {
		return new URL(relative, base).toString();
	} catch {
		return relative;
	}
}

/** Parse an M3U8 playlist text. Throws on invalid input. */
export function parseHlsPlaylist(text: string, baseUrl: string): HlsPlaylist {
	const lines = text.split(/\r?\n/).map((l) => l.trim());
	const first = lines[0] ?? "";
	if (lines.length === 0 || !first.startsWith("#EXTM3U")) {
		throw new Error("Invalid M3U8 playlist: missing #EXTM3U header");
	}

	const playlist: HlsPlaylist = {
		isMaster: false,
		variants: [],
		segments: [],
		targetDuration: null,
		mediaSequence: 0,
		isEndList: false,
		version: null,
	};

	let pendingDuration = 0;
	let sequence = 0;

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;

		if (line.startsWith("#EXT-X-STREAM-INF:")) {
			playlist.isMaster = true;
			const attrs = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
			const next = lines[i + 1];
			if (next && !next.startsWith("#")) {
				playlist.variants.push({
					url: resolveUrl(baseUrl, next),
					bandwidth: attrs.BANDWIDTH ? Number.parseInt(attrs.BANDWIDTH, 10) : null,
					resolution: attrs.RESOLUTION ?? null,
				});
				i++;
			}
		} else if (line.startsWith("#EXTINF:")) {
			const dur = Number.parseFloat(line.slice("#EXTINF:".length).split(",")[0] ?? "0");
			pendingDuration = Number.isFinite(dur) ? dur : 0;
		} else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
			playlist.targetDuration = Number.parseInt(line.slice("#EXT-X-TARGETDURATION:".length), 10);
		} else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
			playlist.mediaSequence = Number.parseInt(line.slice("#EXT-X-MEDIA-SEQUENCE:".length), 10);
			sequence = playlist.mediaSequence;
		} else if (line.startsWith("#EXT-X-VERSION:")) {
			playlist.version = Number.parseInt(line.slice("#EXT-X-VERSION:".length), 10);
		} else if (line === "#EXT-X-ENDLIST") {
			playlist.isEndList = true;
		} else if (!line.startsWith("#")) {
			playlist.segments.push({
				url: resolveUrl(baseUrl, line),
				duration: pendingDuration,
				sequence: sequence++,
			});
			pendingDuration = 0;
		}
	}

	return playlist;
}

function parseAttributes(input: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
	for (const match of input.matchAll(re)) {
		const key = match[1];
		const raw = match[2] ?? "";
		if (key) attrs[key] = raw.replace(/^"|"$/g, "");
	}
	return attrs;
}

/** Parse an M3U playlist (extended or simple) into entries. */
export function parseM3u(text: string): { url: string; title?: string }[] {
	const entries: { url: string; title?: string }[] = [];
	const lines = text.split(/\r?\n/).map((l) => l.trim());
	let pendingTitle: string | undefined;

	for (const line of lines) {
		if (!line) continue;
		if (line.startsWith("#EXTINF:")) {
			const comma = line.indexOf(",");
			pendingTitle = comma >= 0 ? line.slice(comma + 1).trim() : undefined;
		} else if (line.startsWith("#")) {
		} else {
			entries.push(pendingTitle ? { url: line, title: pendingTitle } : { url: line });
			pendingTitle = undefined;
		}
	}
	return entries;
}

/** Serialise entries to M3U format. */
export function toM3u(entries: { url: string; title?: string }[]): string {
	const lines = ["#EXTM3U"];
	for (const e of entries) {
		if (e.title) lines.push(`#EXTINF:-1,${e.title}`);
		lines.push(e.url);
	}
	return `${lines.join("\n")}\n`;
}
