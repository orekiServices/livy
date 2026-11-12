import type { HlsSegment } from './native.js';
import { loadNativeAudio } from './native.js';

export interface M3u8Playlist {
  isMaster: boolean;
  isLive: boolean;
  targetDuration: number;
  mediaSequence: number;
  segments: HlsSegment[];
  /** Variant playlists for master playlists. */
  variants: Array<{ uri: string; bandwidth: number; resolution?: string }>;
  version: number;
}

/**
 * Parse an M3U8 playlist (media or master). Delegates segment extraction
 * to the native module when available.
 */
export function parseM3u8(playlist: string, baseUrl: string): M3u8Playlist {
  const native = loadNativeAudio();
  const segments = native.parseM3u8(playlist, baseUrl);

  let targetDuration = 0;
  let mediaSequence = 0;
  let version = 3;
  let isLive = true;
  const variants: M3u8Playlist['variants'] = [];

  const lines = playlist.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number.parseInt(line.split(':')[1] ?? '0', 10) || 0;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number.parseInt(line.split(':')[1] ?? '0', 10) || 0;
    } else if (line.startsWith('#EXT-X-VERSION:')) {
      version = Number.parseInt(line.split(':')[1] ?? '3', 10) || 3;
    } else if (line === '#EXT-X-ENDLIST') {
      isLive = false;
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const bw = Number.parseInt(/BANDWIDTH=(\d+)/.exec(line)?.[1] ?? '0', 10) || 0;
      const res = /RESOLUTION=([0-9x]+)/.exec(line)?.[1];
      const next = (lines[i + 1] ?? '').trim();
      if (next && !next.startsWith('#')) {
        variants.push({ uri: new URL(next, baseUrl).toString(), bandwidth: bw, resolution: res });
      }
    }
  }

  return {
    isMaster: variants.length > 0,
    isLive,
    targetDuration,
    mediaSequence,
    segments,
    variants,
    version,
  };
}

/** Build a minimal live media playlist for re-serving segments. */
export function buildMediaPlaylist(segments: HlsSegment[], targetDuration: number): string {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(targetDuration))}`,
    `#EXT-X-MEDIA-SEQUENCE:${segments[0]?.sequence ?? 0}`,
  ];
  for (const seg of segments) {
    lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
    lines.push(seg.uri);
  }
  return lines.join('\n') + '\n';
}

/** Parse an M3U (extended or plain) playlist into entries. */
export function parseM3u(
  content: string,
  baseUrl: string,
): Array<{ title: string; url: string; duration?: number; artist?: string }> {
  const entries: Array<{ title: string; url: string; duration?: number; artist?: string }> = [];
  const lines = content.split(/\r?\n/);
  let pendingTitle = '';
  let pendingDuration: number | undefined;
  let pendingArtist: string | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      const rest = line.slice('#EXTINF:'.length);
      const comma = rest.indexOf(',');
      pendingDuration = Number.parseInt(rest.slice(0, comma), 10);
      if (Number.isNaN(pendingDuration)) pendingDuration = undefined;
      const meta = rest.slice(comma + 1).trim();
      const dash = meta.indexOf(' - ');
      if (dash > 0) {
        pendingArtist = meta.slice(0, dash);
        pendingTitle = meta.slice(dash + 3);
      } else {
        pendingTitle = meta;
      }
    } else if (line && !line.startsWith('#')) {
      entries.push({
        title: pendingTitle || line,
        url: new URL(line, baseUrl).toString(),
        duration: pendingDuration,
        artist: pendingArtist,
      });
      pendingTitle = '';
      pendingDuration = undefined;
      pendingArtist = undefined;
    }
  }
  return entries;
}

/** Serialize entries as an extended M3U playlist. */
export function buildM3u(entries: Array<{ title: string; url: string; duration?: number; artist?: string }>): string {
  const lines = ['#EXTM3U'];
  for (const e of entries) {
    const label = e.artist ? `${e.artist} - ${e.title}` : e.title;
    lines.push(`#EXTINF:${e.duration ?? -1},${label}`);
    lines.push(e.url);
  }
  return lines.join('\n') + '\n';
}
