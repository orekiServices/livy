/**
 * Values every station module shares.
 */
export const DEFAULTS = {
  bufferAheadMs: 15_000, // how far the reader runs ahead of real time
  burstMs: 4000, // audio replayed to a new listener
  maxListeners: 500,
  shuffle: true,
  // Re-queue finished tracks (endless radio). With `autoplay` on, a station
  // whose rotation is nearly over prefers *new* music to another lap: one
  // song means the next song, not that song again.
  loop: true,
  crossfadeMs: 0, // legacy knob; the automix owns transitions now
  automix: null, // see core/automix.js — crossfades, effects and the DJ
  historySize: 30,
  autoStart: true,
  skipOnErrorDelay: 1500,
  subscriberHighWaterMark: 1.5 * 1024 * 1024,
  // listener requests
  allowRequests: false,
  // Listener-picked songs (the minimalist web client). Owner can turn it off.
  allowPlayNow: true,
  maxRequests: 40,
  maxPendingPerUser: 3,
  requestCooldownMs: 20_000,
  voteSkipRatio: 0.5,
  // audio quality policy ('high' asks the registry to re-clone in hi-res)
  quality: 'high',
  // Keep playing when the queue runs out, by looking at what this station
  // has been playing and asking the sources for more of it.
  autoplay: true,
  // Pick up mid-song after a restart instead of starting it again.
  resume: true,
  // What language this station speaks: idents, owner announcements, the DJ
  // and its half of a spoken error. `null` follows the node's TTS default,
  // so a multilingual node can still have one Vietnamese channel.
  language: null,
  // station intro: spoken welcome (or an owner-supplied audio file)
  intro: null,             // { tts: "…", file: "/path/or/url.mp3", bundled: "id" }
  introOnStart: true,
  idleAnnouncementMs: 120_000, // replay the intro while the station is empty
  owner: null
}

/**
 * What a listener is allowed to know about a track.
 *
 * Deliberately *not* a blacklist: only these fields are copied, so an upstream
 * CDN URL, a local file path, a signed query string or an API key embedded in
 * a provider response can never reach the browser by accident.
 */
export function publicTrack(track) {
  if (!track) return null
  return {
    id: track.id,
    title: track.title ?? null,
    artist: track.artist ?? null,
    album: track.album ?? null,
    duration: track.duration ?? 0,
    artwork: track.artwork ?? null,
    source: track.source ?? null,
    bitrate: track.streamBitrate ?? track.bitrate ?? null,
    live: track.live === true,
    announcement: track.announcement === true,
    requestedBy: track.requestedBy ?? null,
    mirroredFrom: track.mirroredFrom ?? null,
    upgradedFrom: track.upgradedFrom ?? null,
    automix: track.automix === true,
    mixedFrom: track.mixedFrom ?? null,
    // Search results carry two extra facts a UI needs and a listener may
    // safely know: whether this can actually be played, and how well it
    // matched what they typed.
    ...(track.streamable === false || track.metadataOnly ? { streamable: false } : {}),
    ...(track.searchScore != null ? { searchScore: track.searchScore } : {}),
    // The artist's own page is public by definition; the media URL is not.
    link: track.pageUrl ?? track.link ?? null
  }
}



/** Bitrates a re-encode may use: the frame's own rate, inside the MP3 range. */
export function clampBitrate(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 128
  return Math.max(96, Math.min(320, Math.round(number)))
}
