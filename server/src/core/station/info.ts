/**
 * Announcements and the public view of a station.
 *
 * Mixed into Station.prototype in ../station.js.
 */
import {
  PassThrough,
  randomUUID,
  buildSilence,
  MetroFramer,
  MetroTranscoder,
  engineInfo,
  sniff,
  worthResuming,
  hlsSegments,
  isHlsUrl,
  createLogger,
  Automix,
  DEFAULT_AUTOMIX,
  decodeMp3,
  encodeMp3,
  FilterChain,
  DEFAULTS,
  publicTrack
} from './deps.ts'

export const infoMethods = {
  /** Build the station's intro track from config (owner audio beats TTS). */
  _introTrack() {
    const intro = this.options.intro
    if (!intro) return null
    const text = intro.tts ?? intro.text ?? null
    if (!text && !intro.file) return null
    return {
      source: 'tts',
      id: `tts:intro:${this.id}`,
      language: intro.language ?? this.options.language ?? null,
      title: intro.title ?? `${this.name} — station ident`,
      artist: this.name,
      text: text ?? '',
      file: intro.file ?? null,
      bundled: intro.bundled ?? null,
      announcement: true,
      intro: true,
      duration: 0,
      bitrate: 128,
      streamable: true
    }
  },

  /** Put a clip on air ahead of everything else (idents, owner announcements). */
  playAnnouncement(track, { immediate = true }: any = {}) {
    this.announcements.push(track)
    if (immediate) this._dropBufferedFrames()
    if (!this._running && this.options.autoStart) this.start()
    this.emit('announcement', track)
    return track
  },

  /**
   * Speak text on air, in this station's language unless told otherwise.
   * `immediate: false` lets the current song finish first.
   */
  say(text, meta: any = {}) {
    return this.playAnnouncement({
      source: 'tts',
      id: `tts:say:${Date.now().toString(36)}`,
      title: meta.title ?? 'Station announcement',
      artist: meta.artist ?? this.name,
      text,
      language: meta.language ?? this.options.language ?? null,
      announcement: true,
      duration: 0,
      bitrate: 128,
      streamable: true
    }, { immediate: meta.immediate !== false })
  },

  /** Discard buffered audio so the next thing queued starts immediately. */
  _dropBufferedFrames() {
    this._frames = []
    this._bufferedMs = 0
    this.automix?.reset()
    this._skipRequested = true
    this._readerAbort?.abort()
  },

  /* -------------------------------- info ------------------------------ */

  nowPlaying() {
    if (!this.current) return null
    const { track, positionMs, startedAt } = this.current
    return {
      station: this.id,
      track: publicTrack(track),
      title: this.liveTitle ?? `${track.artist} - ${track.title}`,
      positionMs: Math.round(positionMs),
      durationMs: track.duration || null,
      startedAt,
      requestedBy: track.requestedBy ?? null,
      bitrate: track.streamBitrate ?? track.bitrate ?? null,
      quality: (track.streamBitrate ?? track.bitrate ?? 0) >= 192 ? 'hi-res' : 'standard',
      upgradedFrom: track.upgradedFrom ?? null,
      sourceName: track.source
    }
  },

  info({ queue = false, owner = false }: any = {}) {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      genre: this.genre,
      artwork: this.artwork ?? this.current?.track?.artwork ?? null,
      state: this.state,
      contentType: 'audio/mpeg',
      // Canonical, and it ends in .mp3 so every player, podcast app and
      // `curl -O` on earth treats it as what it is.
      stream: `/stream/${this.id}.mp3`,
      engine: engineInfo().engine,
      relaying: this.relaying,
      language: this.options.language ?? null,
      autoplay: this.options.autoplay !== false,
      resume: this.options.resume !== false,
      nowPlaying: this.nowPlaying(),
      upNext: this.queue.slice(0, 3).map(publicTrack),
      queueLength: this.queue.length,
      allowRequests: this.options.allowRequests === true,
      ...(owner ? { allowPlayNow: this.options.allowPlayNow !== false, playlists: this.playlists } : {}),
      automix: this.automix.info(),
      // Public payloads never expose a filesystem path: listeners learn that
      // an ident exists, owners get the real record.
      intro: this.options.intro ? (owner ? this.options.intro : { tts: this.options.intro.tts ?? null, audio: Boolean(this.options.intro.file) }) : null,
      owner: this.options.owner ?? null,
      requests: this.publicRequests().slice(0, 10),
      requestCount: this.requests.length,
      voteSkips: { votes: this.voteSkips.size, needed: Math.max(1, Math.ceil(this.listeners * this.options.voteSkipRatio)) },
      listeners: this.listeners,
      bufferedMs: Math.round(this._bufferedMs),
      uptime: this.stats.startedAt ? Date.now() - this.stats.startedAt : 0,
      stats: this.stats,
      history: this.history.slice(0, 5).map(publicTrack),
      ...(queue ? { queue: this.queue.map(publicTrack) } : {})
    }
  },

  toJSON() {
    return this.info()
  }
}

export default infoMethods
