/** Formatting helpers shared by embeds and commands. */

/** Milliseconds -> "3:45" (or "LIVE" for streams). */
export function formatDuration(ms) {
  if (ms === null || ms === undefined || ms < 0) return 'LIVE';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "1:30" / "90s" / "2m" / "1h5m" -> milliseconds. Returns null when invalid. */
export function parseDuration(input) {
  if (input === null || input === undefined) return null;
  const text = String(input).trim().toLowerCase();
  if (!text) return null;

  // Colon form: h:mm:ss or m:ss
  if (text.includes(':')) {
    const parts = text.split(':').map((p) => Number.parseInt(p, 10));
    if (parts.some((p) => Number.isNaN(p) || p < 0)) return null;
    if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
    if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
    return null;
  }

  // Unit form: 90, 90s, 2m, 1h, 1h30m, 1.5m …
  const match = text.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const hours = Number.parseFloat(match[1] ?? 0);
  const minutes = Number.parseFloat(match[2] ?? 0);
  const seconds = Number.parseFloat(match[3] ?? 0);
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

/** "▬▬▬▬▬🔘▬▬▬▬▬" style progress bar. */
export function progressBar(positionMs, durationMs, width = 20) {
  if (!durationMs || durationMs <= 0) return '🔴 LIVE';
  const ratio = Math.min(1, Math.max(0, positionMs / durationMs));
  const filled = Math.round(ratio * width);
  return '▬'.repeat(filled) + '🔘' + '▬'.repeat(Math.max(0, width - filled));
}

/** Truncate to Discord's limits without breaking surrogate pairs. */
export function truncate(text, max = 200) {
  const str = String(text ?? '');
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

/** Lavalink track info -> display title (falls back to URI / "Unknown"). */
export function trackTitle(track) {
  return track?.info?.title || track?.title || track?.info?.uri || 'Unknown track';
}
