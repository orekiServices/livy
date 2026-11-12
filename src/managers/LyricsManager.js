/**
 * Lyrics via NodeLink's /v4/loadlyrics (FastLink: player.loadLyrics).
 *
 * NodeLink returns synced or plain lyrics depending on the source.
 * Response shapes vary between NodeLink versions, so parsing here is
 * deliberately defensive: accept a plain string, { lyrics }, { text },
 * { lines: [...] }, or a synced array of { timestamp, line } objects.
 */
import { withTimeout } from '../fastlink-compat.js';
import { truncate } from '../utils/format.js';

const CACHE_TTL_MS = 5 * 60 * 1000;

export class LyricsManager {
  constructor() {
    /** @type {Map<string, { lyrics: string, synced: boolean, expires: number }>} */
    this.cache = new Map();
  }

  async getLyrics(player, encoded, { lang } = {}) {
    const cached = this.cache.get(encoded);
    if (cached && cached.expires > Date.now()) return cached;

    const raw = await withTimeout(player.loadLyrics(encoded, lang), 15_000, 'loadlyrics');
    const parsed = parseLyricsResponse(raw);
    if (!parsed) return null;

    const entry = { ...parsed, expires: Date.now() + CACHE_TTL_MS };
    this.cache.set(encoded, entry);
    return entry;
  }
}

export function parseLyricsResponse(raw) {
  if (!raw) return null;

  // FastLink returns the parsed JSON body directly.
  const data = raw.data ?? raw;
  if (!data) return null;

  if (typeof data === 'string') {
    return data.trim() ? { lyrics: data.trim(), synced: false } : null;
  }

  if (typeof data.lyrics === 'string' && data.lyrics.trim()) {
    return { lyrics: data.lyrics.trim(), synced: Boolean(data.synced) };
  }
  if (typeof data.text === 'string' && data.text.trim()) {
    return { lyrics: data.text.trim(), synced: false };
  }

  const lines = data.lines ?? data.syncedLyrics ?? data.lyrics;
  if (Array.isArray(lines) && lines.length) {
    const text = lines
      .map((line) => {
        if (typeof line === 'string') return line;
        return line.line ?? line.text ?? '';
      })
      .filter(Boolean)
      .join('\n');
    return text.trim() ? { lyrics: text.trim(), synced: true } : null;
  }

  return null;
}

/** Format lyrics for a Discord embed (keeps under the 4096-char limit). */
export function formatLyrics(lyrics, max = 3500) {
  return truncate(lyrics, max);
}
