/**
 * A Station is a continuously broadcasting MP3 radio channel.
 *
 *   queue ──► reader (network, ~15 s ahead) ──► frame buffer ──► pacer (real time)
 *                                                                    │
 *                                       listeners (HTTP MP3 + ICY) ◄─┘
 *
 * Design goals: lightweight + fast.
 *  • zero transcoding — SoundCloud progressive transcodings are already MP3,
 *    so we only split them into frames and forward the bytes
 *  • one decode-free pacer per station, independent of listener count
 *  • the reader stays ~15 s ahead, which hides network latency and makes
 *    track changes gapless
 *  • a listener joining mid-track gets a burst of recent frames, so playback
 *    starts instantly instead of after the player's own buffering
 *
 * Events: state, track, progress, queue, listeners, error, empty
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'

import { buildSilence } from '../util/mp3.js'
import { MetroFramer, MetroTranscoder, engineInfo, sniff } from '../util/metro.js'
import { worthResuming } from './memory.js'
import { hlsSegments, isHlsUrl } from '../util/hls.js'
import createLogger from '../util/logger.js'
import Automix, { DEFAULT_AUTOMIX, decodeMp3, encodeMp3 } from './automix.js'
import { FilterChain } from './filters/index.js'

const DEFAULTS = {
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

export class Station extends EventEmitter {
  constructor(config, sources, { store = null, tts = null, memory = null, smartQueue = null } = {}) {
    super()
    this.store = store
    this.tts = tts
    // What this station remembers across a restart, and what it plays when
    // nobody said what to play next. Both are optional: a station works
    // without either, it just forgets and eventually runs dry.
    this.memory = memory
    this.smartQueue = smartQueue
    this.setMaxListeners(0)

    this.id = config.id
    this.name = config.name ?? config.id
    this.description = config.description ?? null
    this.genre = config.genre ?? null
    this.artwork = config.artwork ?? null
    this.playlists = config.playlists ?? config.sources ?? []
    this.options = { ...DEFAULTS, ...config }
    this.sources = sources

    this.state = 'idle' // idle | loading | playing | stopped | error
    this.queue = []
    this.requests = [] // listener requests, played before the rotation
    this.voteSkips = new Set()
    this.lastRequestAt = new Map() // requesterId -> timestamp
    this.announcements = [] // owner + ident clips: they jump ahead of everything
    this.history = []
    this.current = null // { track, startedAt, positionMs, durationMs }
    this.liveTitle = null // ICY title when relaying a live stream
    this.subscribers = new Map()
    this.stats = { listeners: 0, peakListeners: 0, totalListeners: 0, bytesOut: 0, tracksPlayed: 0, requestsPlayed: 0, fallbacks: 0, upgrades: 0, startedAt: null, errors: 0 }

    this.log = createLogger(`station:${this.id}`)

    // Automix: crossfades, transition effects and the voice-tracking DJ.
    this.automix = new Automix(
      { ...DEFAULT_AUTOMIX, ...(config.automix ?? {}) },
      { sources, station: this, log: createLogger(`automix:${this.id}`) }
    )

    // Every rendered seam is a training sample for the DJ model: note it now,
    // and let `skip()` or the next transition close the label. This is the
    // whole feedback loop — no extra instrumentation, no separate analytics,
    // and it works for a station nobody is watching.
    this.on('automix', (report) => this.noteSeam(report))

    // Station filters (the NodeLink surface): one chain per station, applied to
    // everything the station airs. Compiled once per change, then run per block
    // — see core/filters.js. Empty means "do not decode anything at all",
    // which is why an unfiltered station costs exactly what it did before.
    this.filters = new FilterChain(config.filters ?? {}, { sampleRate: 44_100 })
    this.#filterCache = { track: null, held: [], heldMs: 0, bitrate: 128 }

    // Rehydrate the request line after a restart.
    try {
      const pending = this.store?.pendingRequests(this.id) ?? []
      if (pending.length) {
        this.requests = pending
        this.log.info(`restored ${pending.length} pending request(s) from ${this.store.driver}`)
      }
    } catch (error) {
      this.log.debug(`store restore: ${error.message}`)
    }

    this.#frames = [] // [{ data, ms, track }]
    this.#bufferedMs = 0
    this.#burst = []
    this.#burstMs = 0
  }

  #frames
  #filterCache = { track: null, held: [], heldMs: 0, bitrate: 128 }
  #bufferedMs
  #burst
  #burstMs
  #running = false
  #readerAbort = null
  #pacerTimer = null
  #clock = 0 // ms of audio emitted since start
  #origin = 0 // hrtime ms at pacer start
  #skipRequested = false
  #loadingPromise = null

  /* ------------------------------ queue ------------------------------- */

  /** Resolve the configured playlists into the queue (lazy, once). */
  async load(force = false) {
    if (this.#loadingPromise && !force) return this.#loadingPromise
    if (this.queue.length > 0 && !force) return this.queue

    this.#setState('loading')
    this.#loadingPromise = (async () => {
      const collected = []
      for (const entry of this.playlists) {
        try {
          const result = await this.sources.resolve(entry, { limit: this.options.trackLimit ?? 50 })
          collected.push(...result.tracks)
          this.log.info(`loaded ${result.tracks.length} track(s) from "${entry}"`)
        } catch (error) {
          this.stats.errors += 1
          this.log.warn(`playlist "${entry}" failed: ${error.message}`)
          this.emit('error', error)
        }
      }

      const seen = new Set()
      this.queue = collected.filter((t) => t.streamable !== false && !seen.has(t.id) && seen.add(t.id))
      if (this.options.shuffle) this.shuffle(false)
      this.emit('queue', this.queue)
      return this.queue
    })().finally(() => {
      this.#loadingPromise = null
    })

    return this.#loadingPromise
  }

  enqueue(tracks, { position = -1 } = {}) {
    const list = Array.isArray(tracks) ? tracks : [tracks]
    if (position >= 0) this.queue.splice(position, 0, ...list)
    else this.queue.push(...list)
    this.emit('queue', this.queue)
    if (this.#running && !this.current) this.#wake()
    return this.queue.length
  }

  removeAt(index) {
    const [removed] = this.queue.splice(index, 1)
    if (removed) this.emit('queue', this.queue)
    return removed
  }

  /**
   * Move a queued track. This is what a drag in the console becomes, so it
   * has to be forgiving: out-of-range indexes clamp instead of throwing, and
   * `to: 0` means "play it next".
   */
  move(from, to) {
    const source = Number(from)
    if (!Number.isInteger(source) || source < 0 || source >= this.queue.length) return null
    const target = Math.max(0, Math.min(this.queue.length - 1, Number(to)))
    if (target === source) return this.queue[source]
    const [track] = this.queue.splice(source, 1)
    this.queue.splice(target, 0, track)
    this.emit('queue', this.queue)
    return track
  }

  /** Jump a queued track to the front — the "play next" button. */
  playNext(index) {
    return this.move(index, 0)
  }

  /**
   * Replace the queue wholesale, matching an order the console sent back.
   *
   * The console owns a list the listener can drag around; rather than
   * replaying every move, it can post the ids in their new order. Ids that
   * are not in the queue are ignored, and anything the console did not
   * mention keeps its place at the end — so two people reordering at once
   * cannot delete each other's tracks.
   */
  reorder(ids = []) {
    const byId = new Map()
    for (const track of this.queue) {
      const key = String(track.id ?? track.url ?? track.title)
      if (!byId.has(key)) byId.set(key, [])
      byId.get(key).push(track)
    }

    const next = []
    for (const id of ids) {
      const bucket = byId.get(String(id))
      if (bucket?.length) next.push(bucket.shift())
    }
    for (const bucket of byId.values()) next.push(...bucket)

    this.queue = next
    this.emit('queue', this.queue)
    return this.queue
  }

  clearQueue() {
    this.queue = []
    this.emit('queue', this.queue)
  }

  shuffle(emit = true) {
    for (let i = this.queue.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]]
    }
    if (emit) this.emit('queue', this.queue)
    return this.queue
  }

  skip() {
    const playingId = this.current?.track?.id ?? this.#frames[0]?.track?.id
    if (!playingId) return false

    // A skip is the only listener signal a radio stream gets, and it is the
    // label the DJ model learns from. It is only attributable to the
    // transition if it happened close to one; `recordSkip()` decides that, and
    // a skip in the middle of a song teaches the model nothing about seams.
    this.#recordSkip(playingId)

    // Drop everything still buffered for the current track: the pacer then
    // plays the next track's frames on its very next tick.
    this.#frames = this.#frames.filter((f) => f.track?.id !== playingId)
    this.#bufferedMs = this.#frames.reduce((n, f) => n + f.ms, 0)

    // Only tear down the download if it is still the track we just skipped —
    // otherwise we would also kill the prefetch of the *next* track.
    if (this.#readingTrackId === playingId) {
      this.#skipRequested = true
      this.#readerAbort?.abort()
    }
    return true
  }

  /* --------------------------- DJ seam log ---------------------------- */

  #lastSeam = null

  /**
   * Remember the last transition so that a skip can be attributed to it.
   *
   * Called from the automix's `automix` event. The listener's reaction is what
   * the DJ model is trained on, so the record has to survive until the next
   * transition or until the attribution window has passed — whichever
   * comes first.
   */
  noteSeam(report = {}) {
    if (!report?.effect) return null
    const at = Number(report.at) || Date.now()
    this.#lastSeam = {
      at,
      effect: report.effect,
      source: report.decision?.source ?? 'heuristic',
      baseline: report.decision?.baseline ?? report.effect,
      model: report.decision?.model ?? null,
      // Everything the feature builder needs, copied now: the report object is
      // not guaranteed to exist later, and reading a mutated one would log a
      // seam that never happened.
      bpmOut: report.beat?.bpm ?? 0,
      bpmIn: report.beat?.incomingBpm ?? 0,
      matched: Boolean(report.beat?.matched),
      correlation: report.correlation ?? 0,
      loudnessGap: report.loudness?.appliedDb ?? 0,
      energy: report.entryEnergy ?? 0.5,
      energyIn: report.entryEnergy ?? 0.5,
      vocalOut: report.vocal?.outgoing ? 1 : 0,
      vocalIn: report.vocal?.incoming ? 1 : 0,
      fadeMs: report.blendMs ?? 6000,
      phraseAligned: Boolean(report.beat?.phrase),
      talkover: Boolean(report.dj),
      hour: new Date(at).getHours(),
      from: report.from ?? null,
      to: report.to ?? null
    }
    return this.#lastSeam
  }

  /**
   * Close the loop on the last transition.
   *
   * `outcome` is `completed` (the track played out) or `skipped` (somebody
   * pressed the button). The log line is what the trainer reads.
   */
  #recordSkip(playingId) {
    const seam = this.#lastSeam
    if (!seam) return false
    const since = Date.now() - seam.at
    // A skip further than a couple of minutes from the seam says nothing about
    // it — the listener skipped the *song*.
    if (since > 180_000) {
      this.#lastSeam = null
      return false
    }
    return this.#logSeam({ ...seam, outcome: 'skipped', skippedAfterMs: since, skippedTrack: playingId })
  }

  async #logSeam(record) {
    try {
      const { recordSeam } = await import('./models/trainer.js')
      return recordSeam(record, { store: this.store })
    } catch (error) {
      this.log.debug(`seam log: ${error.message}`)
      return false
    }
  }

  /* ------------------------------ requests ---------------------------- */

  /** Next thing to play: listener requests first (most voted), then rotation. */
  #takeNext() {
    // 1. announcements (station ident, owner "say")
    if (this.announcements.length > 0) return this.announcements.shift()

    // 2. listener requests
    if (this.requests.length > 0) {
      this.requests.sort((a, b) => b.votes - a.votes || a.requestedAt - b.requestedAt)
      const request = this.requests.shift()
      this.emit('requests', this.requests)
      this.stats.requestsPlayed += 1
      return { ...request.track, requestedBy: request.by, requestId: request.id }
    }

    // 3. nothing programmed → keep the channel alive with the station intro
    if (this.queue.length === 0) {
      const intro = this.#introTrack()
      if (intro && Date.now() - this.#lastIntroAt >= (this.options.idleAnnouncementMs ?? 120_000)) {
        this.#lastIntroAt = Date.now()
        return intro
      }
      return null
    }

    const track = this.queue.shift()
    // Endless rotation, but a track earns its place back by *playing*: a dead
    // link would otherwise loop forever at the head of the queue.
    this.#requeueCandidate = this.options.loop ? track : null
    this.emit('queue', this.queue)
    return track
  }

  /**
   * Public request entry point — "everyone can request".
   * @param {object} opts
   * @param {string} opts.query   search terms or a source URL
   * @param {string} [opts.by]    display name
   * @param {string} [opts.requesterId] stable id (ip hash / session) for limits
   */
  async request({ query, by = 'anonymous', requesterId = by, track: presetTrack } = {}) {
    if (!this.options.allowRequests) throw Object.assign(new Error('This station does not take requests'), { status: 403 })
    if (this.requests.length >= this.options.maxRequests) throw Object.assign(new Error('Request queue is full'), { status: 429 })

    const pending = this.requests.filter((r) => r.requesterId === requesterId).length
    if (pending >= this.options.maxPendingPerUser) {
      throw Object.assign(new Error(`You already have ${pending} pending requests`), { status: 429 })
    }

    const last = this.lastRequestAt.get(requesterId) ?? 0
    const wait = this.options.requestCooldownMs - (Date.now() - last)
    if (wait > 0) throw Object.assign(new Error(`Please wait ${Math.ceil(wait / 1000)}s before requesting again`), { status: 429 })

    let track = presetTrack
    if (!track) {
      const resolved = await this.sources.resolve(query, { limit: 5 })
      track = resolved.tracks.find((t) => t.streamable !== false)
      if (!track) throw Object.assign(new Error(`Nothing playable found for "${query}"`), { status: 404 })
    }

    const duplicate =
      this.requests.some((r) => r.track.id === track.id) || this.current?.track?.id === track.id
    if (duplicate) throw Object.assign(new Error('That track is already on air or queued'), { status: 409 })

    if (this.store?.isBanned(requesterId)) {
      throw Object.assign(new Error('Your line has been restricted by the station owner'), { status: 403 })
    }

    const request = {
      id: randomUUID().slice(0, 8),
      track,
      by: String(by).slice(0, 32),
      requesterId,
      votes: 1,
      voters: new Set([requesterId]),
      requestedAt: Date.now()
    }

    // Persisted first: votes and requests survive a restart (SQLite).
    try {
      this.store?.saveRequest({ id: request.id, stationId: this.id, track, by: request.by, requesterId })
      this.store?.addVote({ stationId: this.id, requestId: request.id, voter: requesterId })
    } catch (error) {
      this.log.debug(`store: ${error.message}`)
    }

    this.requests.push(request)
    this.lastRequestAt.set(requesterId, Date.now())
    this.emit('requests', this.requests)
    this.log.info(`request from ${request.by}: ${track.artist} — ${track.title}`)

    if (!this.#running && this.options.autoStart) this.start()
    return { request: this.#publicRequest(request), position: this.requestPosition(request.id) }
  }

  voteRequest(id, voterId = 'anonymous') {
    const request = this.requests.find((r) => r.id === id)
    if (!request) throw Object.assign(new Error('No such request'), { status: 404 })
    if (this.store?.isBanned(voterId)) throw Object.assign(new Error('Your line has been restricted'), { status: 403 })

    // SQLite UNIQUE(request_id, voter) is the source of truth for duplicates.
    const accepted = this.store ? this.store.addVote({ stationId: this.id, requestId: id, voter: voterId }) : !request.voters.has(voterId)
    if (!accepted) throw Object.assign(new Error('You already voted for this'), { status: 409 })

    request.voters.add(voterId)
    request.votes = this.store ? this.store.voteCount(id) : request.votes + 1
    this.requests.sort((a, b) => b.votes - a.votes || a.requestedAt - b.requestedAt)
    this.emit('requests', this.requests)
    return { request: this.#publicRequest(request), position: this.requestPosition(id) }
  }

  removeRequest(id) {
    const index = this.requests.findIndex((r) => r.id === id)
    if (index === -1) return null
    const [removed] = this.requests.splice(index, 1)
    this.emit('requests', this.requests)
    return this.#publicRequest(removed)
  }

  requestPosition(id) {
    const sorted = [...this.requests].sort((a, b) => b.votes - a.votes || a.requestedAt - b.requestedAt)
    return sorted.findIndex((r) => r.id === id) + 1
  }

  /** Democratic skip: needs half of the current listeners (at least one). */
  voteSkip(voterId = 'anonymous') {
    if (!this.options.allowRequests) throw Object.assign(new Error('Voting is disabled here'), { status: 403 })
    if (this.store?.isBanned(voterId)) throw Object.assign(new Error('Your line has been restricted'), { status: 403 })

    const trackId = this.current?.track?.id ?? 'idle'
    this.voteSkips.add(voterId)
    if (this.store) this.store.addSkipVote({ stationId: this.id, trackId, voter: voterId })

    const needed = Math.max(1, Math.ceil(this.listeners * this.options.voteSkipRatio))
    const votes = this.store ? Math.max(this.voteSkips.size, this.store.skipVoteCount(this.id, trackId)) : this.voteSkips.size
    const passed = votes >= needed
    if (passed) {
      this.voteSkips.clear()
      this.store?.clearSkipVotes(this.id, trackId)
      this.skip()
    }
    this.emit('voteskip', { votes, needed, passed })
    return { votes, needed, passed }
  }

  #publicRequest(request) {
    return {
      id: request.id,
      by: request.by,
      votes: request.votes,
      requestedAt: request.requestedAt,
      // Same allow-list as everything else a listener sees: a request must not
      // hand out the media URL (a local path, or a signed CDN link) either.
      track: publicTrack(request.track)
    }
  }

  publicRequests() {
    return [...this.requests]
      .sort((a, b) => b.votes - a.votes || a.requestedAt - b.requestedAt)
      .map((r) => this.#publicRequest(r))
  }

  /* --------------------------- announcements -------------------------- */

  #lastIntroAt = 0

  /** Build the station's intro track from config (owner audio beats TTS). */
  #introTrack() {
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
  }

  /** Put a clip on air ahead of everything else (idents, owner announcements). */
  playAnnouncement(track, { immediate = true } = {}) {
    this.announcements.push(track)
    if (immediate) this.#dropBufferedFrames()
    if (!this.#running && this.options.autoStart) this.start()
    this.emit('announcement', track)
    return track
  }

  /**
   * Speak text on air, in this station's language unless told otherwise.
   * `immediate: false` lets the current song finish first.
   */
  say(text, meta = {}) {
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
  }

  /** Discard buffered audio so the next thing queued starts immediately. */
  #dropBufferedFrames() {
    this.#frames = []
    this.#bufferedMs = 0
    this.automix?.reset()
    this.#skipRequested = true
    this.#readerAbort?.abort()
  }

  /* ----------------------------- lifecycle ---------------------------- */

  async start() {
    if (this.#running) return this
    this.#running = true
    this.stats.startedAt = Date.now()
    this.#clock = 0
    this.#origin = performance.now()
    this.#startPacer()
    this.#readLoop().catch((error) => {
      this.log.error(error)
      this.#setState('error')
    })
    return this
  }

  stop(reason = 'stopped') {
    this.#running = false
    this.#readerAbort?.abort()
    clearTimeout(this.#pacerTimer)
    this.#pacerTimer = null
    this.#frames = []
    this.#bufferedMs = 0
    this.automix?.reset()
    this.current = null
    this.#setState('stopped')
    this.log.info(`stopped (${reason})`)
    return this
  }

  destroy() {
    this.stop('destroyed')
    for (const sub of this.subscribers.values()) sub.stream.destroy()
    this.subscribers.clear()
    this.removeAllListeners()
  }

  #setState(next) {
    if (this.state === next) return
    const previous = this.state
    this.state = next
    this.emit('state', next, previous)
  }

  #wake() {
    if (this.#running && !this.#readerBusy) this.#readLoop().catch((error) => this.log.error(error))
  }

  /* ------------------------------ reader ------------------------------ */

  #readerBusy = false

  async #readLoop() {
    if (this.#readerBusy) return
    this.#readerBusy = true

    try {
      while (this.#running) {
        // A live relay owns the transmitter while it lasts.
        if (this.#relay?.active) {
          this.memory?.save(this)
          await this.#sleep(250)
          continue
        }

        // Keep a few tracks ahead: the smart queue looks at what this
        // station has been playing and finds more of it, so the rotation
        // never simply stops. It runs *before* the "nothing queued" branch
        // so a station with autoplay on rarely reaches it.
        if (this.options.autoplay !== false && this.smartQueue?.enabled && this.announcements.length === 0) {
          try {
            await this.smartQueue.refill(this)
          } catch (error) {
            this.log.debug(`autoplay: ${error.message}`)
          }
        }

        this.memory?.save(this)

        if (this.queue.length === 0 && this.announcements.length === 0 && this.requests.length === 0) {
          await this.load().catch(() => {})
          if (this.queue.length === 0) {
            // Empty station (one the owner has not programmed yet): keep the
            // carrier alive with the station ident instead of dead air.
            const intro = this.#introTrack()
            const due = Date.now() - this.#lastIntroAt >= (this.options.idleAnnouncementMs ?? 120_000)
            if (intro && due) {
              this.#lastIntroAt = Date.now()
              this.announcements.push(intro)
            } else {
              this.emit('empty')
              this.#setState(this.current ? 'playing' : 'idle')
              await this.#flushAutomix('nothing queued')
              await this.#sleep(2000)
              continue
            }
          }
        }

        const next = this.#takeNext()
        if (!next) {
          await this.#flushAutomix('nothing to take')
          await this.#sleep(500)
          continue
        }

        // Hi-res policy: the registry may hand back a better copy of the same
        // recording from another provider ("re-clone").
        let track = next
        try {
          const prepared = await this.sources.prepare(next, { quality: this.options.quality })
          if (prepared !== next) {
            this.stats.upgrades += 1
            track = { ...prepared, requestedBy: next.requestedBy, requestId: next.requestId }
          }
        } catch (error) {
          this.log.debug(`prepare failed: ${error.message}`)
        }

        await this.#readTrack(track)
        // The reader's last block left one encoded frame in hand. It belongs
        // on air before the next track's first frame, not spliced behind it.
        await this.#flushFilterFrames()
        // The track played out, so the transition into it was a keeper: this
        // is the positive label the trainer learns from.
        if (this.#lastSeam && !this.#skipRequested) {
          this.#logSeam({ ...this.#lastSeam, outcome: 'completed', completedAfterMs: Date.now() - this.#lastSeam.at })
          this.#lastSeam = null
        }
      }
    } finally {
      this.#readerBusy = false
    }
  }

  #readingTrackId = null
  #consecutiveFailures = 0
  #requeueCandidate = null

  /**
   * Put reader frames on air. The automix sits in the middle of this path: it
   * runs one crossfade behind the reader and may replace the seam between two
   * songs with a rendered blend (plus a DJ voice track over the top).
   */
  async #air(batch) {
    let ready = batch

    // Filters first: they are what the listener hears, and the automix's seam
    // renderer produces already-encoded MP3 — filtering after it would mean
    // decoding audio that was just encoded. Unfiltered, this is one property
    // read per batch.
    if (this.filters && !this.filters.empty) {
      try {
        ready = await this.#filterThrough(ready)
      } catch (error) {
        this.log.warn(`filters bypassed: ${error.message}`)
      }
    }

    if (this.automix?.enabled) {
      try {
        ready = await this.automix.push(batch)
      } catch (error) {
        this.log.warn(`automix bypassed: ${error.message}`)
        ready = batch
      }
    }
    for (const frame of ready) {
      this.#frames.push(frame)
      this.#bufferedMs += frame.ms
    }
  }

  /**
   * Drive one batch through the air path exactly as the reader does.
   *
   * Public because the filter chain is the one stage whose correctness is a
   * question about *audio*, and a test that re-implements decode → chain →
   * encode would pass even if `#air` stopped calling it. Named with the double
   * underscore so it reads as the test seam it is, not as API.
   */
  async __airForTest(batch) {
    if (this.filters && !this.filters.empty) return this.#filterThrough(batch)
    return batch
  }

  /* ------------------------------ filters ----------------------------- */

  /**
   * Run a batch of reader frames through the station's filter chain.
   *
   * The block is decoded, filtered and re-encoded at the same bitrate it
   * arrived at. Three details make this shippable on a live node:
   *
   *   • **Batch granularity.** A reader batch is 8–10 frames (200–260 ms), so
   *     that is the block: one decode and one encode per batch, not per frame.
   *     At 128 kbps that is a few milliseconds of work per quarter second.
   *   • **A one-batch hold.** A block seldom ends on a frame boundary, and the
   *     encoder emits whole frames. The remainder is carried into the next
   *     block, so the output is contiguous and the timing does not drift; a
   *     small `flushFilters()` at the end of a track releases it.
   *   • **Announcements are filtered too.** A jingle with the station's reverb
   *     on it is the point of having the reverb; bypassing idents would leave
   *     one piece of the hour dry.
   *
   * Returns frames tagged with the source track so the pacer's metadata,
   * history and lyrics stay attached to the right song.
   */
  async #filterThrough(batch) {
    if (!batch.length) return batch
    const track = batch[0].track

    // A new track (or a different one mid-batch) starts a clean block: the old
    // remainder would otherwise splice onto the head of the next song.
    if (track?.id !== this.#filterCache.track?.id) {
      this.#filterCache.track = track
      this.#filterCache.held = []
      this.#filterCache.heldMs = 0
      this.filters.reset()
    }

    const held = this.#filterCache.held
    const bitrate = clampBitrate(track?.streamBitrate ?? this.#filterCache.bitrate ?? 128)
    this.#filterCache.bitrate = bitrate

    const frames = [...held, ...batch.map((frame) => frame.data)]
    const pcm = await decodeMp3(Buffer.concat(frames))
    if (!pcm) return batch

    const out = this.filters.process(pcm.left, pcm.right, Math.min(pcm.left.length, pcm.right.length))
    const mp3 = await encodeMp3({ left: out.left, right: out.right, sampleRate: pcm.sampleRate, bitrate })
    const parsed = new MetroFramer().push(mp3)
    if (parsed.frames.length === 0) return batch

    // The encoder emits whole frames and the block it was given did not
    // necessarily end on a frame boundary, so the last one may carry audio the
    // next block also contains. Hold it and prepend it there: the splice is
    // then continuous, and the duration handed to the pacer is the duration
    // that actually went out.
    const frameMs = parsed.durationMs / parsed.frames.length
    const keep = parsed.frames.length > 2 ? 1 : 0
    const emit = keep ? parsed.frames.slice(0, -keep) : parsed.frames
    this.#filterCache.held = keep ? parsed.frames.slice(-keep) : []
    this.#filterCache.heldMs = frameMs * this.#filterCache.held.length

    return emit.map((data) => ({ data, ms: frameMs, track }))
  }

  /** Push `flushFilters()` output onto the air, if there is any. */
  async #flushFilterFrames() {
    const frames = await this.flushFilters().catch(() => [])
    for (const frame of frames) {
      this.#frames.push(frame)
      this.#bufferedMs += frame.ms
    }
    return frames
  }

  /**
   * Release the filter's held frame.
   *
   * One frame of audio is always in hand; it belongs on air before the track
   * ends, or the last 26 ms of every song disappears. `reset` clears the
   * chain's biquad memory (a new track must not inherit the old one's tail).
   */
  async flushFilters() {
    if (!this.filters || this.filters.empty) return []
    const held = this.#filterCache.held ?? []
    if (!held.length) return []
    const track = this.#filterCache.track
    const frameMs = this.#filterCache.heldMs / held.length
    this.#filterCache.held = []
    this.#filterCache.heldMs = 0
    return held.map((data) => ({ data, ms: frameMs, track }))
  }

  /**
   * Owner control: replace the station's filter chain while it is on air.
   *
   * The chain is *updated* rather than rebuilt. A rebuild would flush the
   * delay lines and cut a reverb tail in half every time an owner moved a
   * fader; `update()` keeps the state of every filter that stays engaged and
   * only resets the ones that switch off.
   */
  setFilters(payload = {}) {
    const next = this.filters ? this.filters.update(payload) : new FilterChain(payload, { sampleRate: 44_100 })
    const previous = this.filters
    this.filters = next
    // The held frame was encoded by the previous chain, but it is still the
    // audio of the track that is playing: keep it, and keep the track so the
    // next block is not mistaken for a new song.
    const info = next.compiled
    this.options.filters = payload
    // A filter that could not be built is a request to fail loudly, not to
    // pretend the station has a chorus. The previous chain keeps running.
    if (info.unknown.length && payload?.strict !== false && Object.keys(payload ?? {}).length && info.active.length === 0) {
      this.filters = previous
      throw new Error(`unknown filter(s): ${info.unknown.join(', ')}`)
    }
    this.emit('filters', { active: info.active, unknown: info.unknown, clamped: info.clamped, configured: true })
    this.log.info(info.active.length ? `filters: ${info.active.join(', ')}` : 'filters cleared')
    return { active: info.active, skipped: info.skipped, unknown: info.unknown, clamped: info.clamped }
  }

  /** Release audio the automix is holding back (end of programme, errors). */
  async #flushAutomix(reason = 'flush') {
    if (!this.automix?.enabled) return
    try {
      const frames = await this.automix.flush(reason)
      for (const frame of frames) {
        this.#frames.push(frame)
        this.#bufferedMs += frame.ms
      }
    } catch (error) {
      this.log.debug(`automix flush failed: ${error.message}`)
    }
  }

  /** Owner control: change transition style / DJ behaviour while on air. */
  setAutomix(patch = {}) {
    const info = this.automix.configure(patch)
    this.options.automix = { ...(this.options.automix ?? {}), ...patch }
    this.emit('automix', { ...info, configured: true })
    return info
  }

  /** Put a rotation track back at the tail — only after it really played. */
  #requeue(played) {
    const candidate = this.#requeueCandidate
    this.#requeueCandidate = null
    if (!candidate || !this.options.loop) return
    if (!played) {
      this.log.debug(`dropped "${candidate.title}" from the rotation (it never played)`)
      return
    }

    // One song is not a playlist. A station given a single track — or one
    // whose rotation has run down to nothing — should play something *new*
    // rather than the same record on a loop, so when autoplay can take over
    // the finished track is retired instead of re-queued.
    const rotationIsThin = this.queue.length === 0
    if (rotationIsThin && this.options.autoplay !== false && this.smartQueue?.enabled) {
      this.log.debug(`"${candidate.title}" finished; autoplay takes it from here`)
      // Nudge the reader so the refill happens now, not after a silence.
      this.#wake()
      return
    }

    this.queue.push(candidate)
    this.emit('queue', this.queue)
  }

  /**
   * What this station was doing when the node stopped.
   *
   * The queue comes back first (so the running order survives), and the
   * track that was on air is put at the front with the offset it had
   * reached — `#readTrack` then drops frames until it gets there, which
   * works for every source because it happens after the bytes arrive.
   */
  resumeFromMemory() {
    if (this.options.resume === false || !this.memory) return null

    const remembered = this.memory.recall(this.id)
    if (!remembered) return null

    let restored = 0
    if (remembered.queue?.length && this.queue.length === 0) {
      this.queue = remembered.queue
      restored = this.queue.length
    }

    const resumable = worthResuming(remembered)
    if (resumable) {
      // Back to the front of the queue, with a note of where we were.
      this.queue.unshift({ ...remembered.track, resumeMs: remembered.positionMs })
      this.log.info(
        `resuming "${remembered.track.title}" at ${(remembered.positionMs / 1000).toFixed(0)}s` +
          (restored ? ` (and ${restored} queued track(s))` : '')
      )
    } else if (restored) {
      this.log.info(`restored ${restored} queued track(s) from memory`)
    }

    this.emit('queue', this.queue)
    return { resumed: resumable, positionMs: resumable ? remembered.positionMs : 0, queue: restored }
  }

  async #readTrack(track) {
    this.#skipRequested = false
    this.#readerAbort = new AbortController()
    this.#readingTrackId = track.id

    let opened
    try {
      opened = await this.sources.stream(track, {
        signal: this.#readerAbort.signal,
        fallbackTag: this.#fallbackTag(track),
        // Relaying a live station is a last resort: only reach for it once the
        // station has failed repeatedly, never for a single dead link.
        allowLiveFallback: this.#consecutiveFailures >= 2,
        onMetadata: (title) => {
          this.liveTitle = title
          this.emit('track', { ...this.nowPlaying(), liveTitle: title })
        }
      })
      this.#consecutiveFailures = 0
      if (opened.fallback) {
        this.stats.fallbacks += 1
        // keep the requester attribution when we had to clone the track
        track = { ...opened.track, requestedBy: track.requestedBy, requestId: track.requestId, fallbackOf: track.title }
        this.#readingTrackId = track.id
      }
    } catch (error) {
      this.stats.errors += 1
      this.#consecutiveFailures += 1
      this.log.warn(`skip "${track.title}": ${error.message}`)
      this.emit('error', error)
      this.#requeue(false)
      await this.#flushAutomix('track failed')
      await this.#sleep(this.options.skipOnErrorDelay)
      return
    }

    // Live ingest arrives in whatever sizes the network produced; coalescing
    // keeps the relay on the cheap path. A file read gives big chunks
    // already, so it is left alone.
    const framer = new MetroFramer({ coalesce: track.live === true || opened.mode === 'icy' ? 8192 : 0 })
    // AAC, FLAC, Ogg, an HLS segment stream…: MetroS turns it into MP3 on
    // the way past. MP3 detects as passthrough and costs nothing.
    const transcoder =
      opened.transcode || track.transcode || (opened.contentType && !/mpeg|mp3/i.test(opened.contentType))
        ? new MetroTranscoder({ bitrate: this.options.bitrate ?? 128 })
        : null

    // A source can answer with a playlist instead of a socket (HLS): follow
    // it here, so every provider gets the same segment handling for free.
    const stream = opened.hls || (opened.url && isHlsUrl(opened.url))
      ? hlsSegments(opened.url, { signal: this.#readerAbort.signal })
      : opened.stream
    let frames = 0

    // Autoseek: a resumed track arrives with the offset it had reached, and
    // the cheapest way to honour it on *any* source is to drop frames until
    // we are there. No range requests, no decoding, no per-source special
    // cases — 3 minutes of a 128 kbps MP3 is 7,000 frames to skip.
    let skipMs = Math.max(0, Number(track.resumeMs) || 0)
    const seeking = skipMs > 0
    if (seeking) this.log.debug(`seeking ${(skipMs / 1000).toFixed(0)}s into "${track.title}"`)

    // A live stream is a relay, not a song: nothing crossfades into it and
    // nothing crossfades out, so it takes MetroS's block path — frames stay
    // contiguous and the pacer airs a quarter second at a time instead of
    // ten separate objects.
    const live = track.live === true || opened.mode === 'icy' || opened.mode === 'hls'

    const onAbort = () => stream.destroy?.()
    this.#readerAbort.signal.addEventListener('abort', onAbort, { once: true })

    try {
      for await (const raw of stream) {
        if (!this.#running || this.#skipRequested) break

        let chunk = raw
        if (transcoder) {
          chunk = transcoder.push(raw)
          if (chunk.length === 0) continue
          if (!track.transcodedFrom && !transcoder.passthrough) {
            track.transcodedFrom = transcoder.kind
            this.log.info(`transcoding ${transcoder.kind} → mp3 for "${track.title}"`)
          }
        }

        if (live) {
          const parsed = framer.pushBlocks(chunk)
          if (parsed.info && !track.streamBitrate) {
            track.streamBitrate = parsed.info.bitrate
            track.sampleRate = parsed.info.sampleRate
          }
          for (const block of parsed.blocks) {
            frames += block.frames
            this.#frames.push({ data: block.data, ms: block.ms, track })
            this.#bufferedMs += block.ms
          }
        } else {
          const parsed = framer.push(chunk)
          if (parsed.info && !track.streamBitrate) {
            track.streamBitrate = parsed.info.bitrate
            track.sampleRate = parsed.info.sampleRate
          }
          if (parsed.frames.length > 0) {
            const ms = parsed.info?.durationMs ?? (1152 / (parsed.info?.sampleRate ?? 44100)) * 1000

            let batch = parsed.frames
            if (skipMs > 0) {
              // Throw away whole frames until the offset is reached; what is
              // left of this batch goes out as usual, so the seam lands
              // within one frame (26 ms) of where we stopped.
              const drop = Math.min(batch.length, Math.floor(skipMs / ms))
              skipMs -= drop * ms
              batch = batch.slice(drop)
              if (skipMs < ms) {
                skipMs = 0
                if (seeking && batch.length) this.log.info(`resumed "${track.title}" mid-song`)
              }
            }

            frames += parsed.frames.length
            if (batch.length) await this.#air(batch.map((data) => ({ data, ms, track })))
          }
        }

        // Backpressure: stay ~bufferAheadMs in front of the pacer.
        while (this.#running && this.#bufferedMs > this.options.bufferAheadMs) {
          await this.#sleep(120)
        }
      }
    } catch (error) {
      if (!this.#skipRequested) {
        this.stats.errors += 1
        this.log.warn(`stream error on "${track.title}": ${error.message}`)
      }
    } finally {
      this.#readerAbort.signal.removeEventListener('abort', onAbort)
      stream.destroy?.()
      stream.return?.()
    }

    // Whatever the transcoder still holds (a container decoded whole, the
    // encoder's last frame) belongs on air too.
    if (transcoder) {
      try {
        const tail = transcoder.flush()
        if (tail.length) {
          const parsed = framer.push(tail)
          const ms = parsed.info?.durationMs ?? 26.122448979591837
          frames += parsed.frames.length
          if (parsed.frames.length) await this.#air(parsed.frames.map((data) => ({ data, ms, track })))
        }
      } catch (error) {
        this.log.debug(`transcode flush: ${error.message}`)
      }
    }

    // Anything the coalescer is still holding belongs on air, not in memory.
    if (live) {
      for (const block of framer.flush().blocks) {
        frames += block.frames
        this.#frames.push({ data: block.data, ms: block.ms, track })
        this.#bufferedMs += block.ms
      }
    }

    if (frames === 0) {
      this.log.warn(`"${track.title}" produced no MP3 frames`)
      this.#requeue(false)
      await this.#flushAutomix('track failed')
      await this.#sleep(this.options.skipOnErrorDelay)
      return
    }

    this.#requeue(true)
  }

  /**
   * Tag used when the station has to relay a live stream as a last resort.
   * A station genre like "Premium" is not a music genre and would match
   * something absurd in the directory, so unknown genres fall back to a safe
   * default instead of whatever the search engine feels like.
   */
  #fallbackTag(track) {
    const KNOWN = [
      'pop', 'rock', 'jazz', 'blues', 'classical', 'electronic', 'house', 'techno', 'trance', 'ambient',
      'chillout', 'lofi', 'hip hop', 'rap', 'rnb', 'soul', 'funk', 'disco', 'reggae', 'metal', 'indie',
      'folk', 'country', 'latin', 'dance', 'drum and bass', 'synthwave', 'easy listening', 'lounge'
    ]
    const candidates = [track?.genre, this.genre, this.name]
    for (const value of candidates) {
      if (!value) continue
      const text = String(value).toLowerCase()
      const hit = KNOWN.find((tag) => text.includes(tag))
      if (hit) return hit
    }
    return 'easy listening'
  }

  /** Public shim over #fallbackTag (used by tests and the owner API). */
  fallbackTagFor(track = {}) {
    return this.#fallbackTag(track)
  }

  /* ------------------------------- pacer ------------------------------ */

  #startPacer() {
    const tick = () => {
      if (!this.#running) return

      const elapsed = performance.now() - this.#origin
      let guard = 0

      // Emit every frame whose playback time has arrived.
      while (this.#clock <= elapsed && this.#frames.length > 0 && guard++ < 4000) {
        const frame = this.#frames.shift()
        this.#bufferedMs -= frame.ms
        this.#clock += frame.ms
        this.#emitFrame(frame)
      }

      if (this.#frames.length === 0 && this.#clock < elapsed) {
        // Underrun: the reader is behind. Re-base the clock so we do not try to
        // "catch up" by dumping a burst of audio at the listeners later.
        this.#clock = elapsed
        if (this.state === 'playing' && this.current) this.#setState('loading')
        // An empty station (a fresh iMusic Pro channel) would otherwise send
        // nothing at all and players would time out. Keep the carrier open
        // with silent MP3 frames between idents.
        this.#emitKeepAlive()
      }

      this.#pacerTimer = setTimeout(tick, 40)
    }
    tick()
  }

  /** Silent MP3 frames so an idle station still holds its listeners. */
  #emitKeepAlive() {
    if (this.subscribers.size === 0) return
    if (this.#silence.length === 0) {
      const built = buildSilence(1000)
      const ms = built.durationMs / Math.max(1, built.frames.length)
      this.#silence = built.frames.map((data) => ({ data, ms }))
    }
    for (const frame of this.#silence) {
      for (const sub of this.subscribers.values()) {
        sub.stream.write(frame.data)
        sub.bytes += frame.data.length
        this.stats.bytesOut += frame.data.length
      }
    }
    this.#clock += this.#silence.reduce((n, f) => n + f.ms, 0)
  }

  #silence = []

  #emitFrame(frame) {
    // Track boundary?
    if (!this.current || this.current.track.id !== frame.track.id) {
      if (this.current) this.#pushHistory(this.current.track)
      // A resumed track starts its clock where it left off, so the console,
      // the lyrics and the progress bar all agree with what is being heard.
      const resumedAt = Number(frame.track.resumeMs) || 0
      this.current = { track: frame.track, startedAt: Date.now() - resumedAt, positionMs: resumedAt }
      this.liveTitle = null
      this.voteSkips.clear()
      this.stats.tracksPlayed += 1
      this.#setState('playing')
      // Memory: what is on air now, and what has played (the smart queue
      // reads both).
      this.memory?.played(this.id, frame.track)
      this.memory?.save(this, { force: true })
      try {
        this.store?.savePlay({
          stationId: this.id,
          track: frame.track,
          requestedBy: frame.track.requestedBy ?? null,
          bitrate: frame.track.streamBitrate ?? frame.track.bitrate ?? null
        })
        if (frame.track.requestId) this.store?.markRequest(frame.track.requestId, 'played')
        if (this.current?.track?.id) this.store?.clearSkipVotes(this.id, this.current.track.id)
      } catch (error) {
        this.log.debug(`store: ${error.message}`)
      }
      this.log.info(`▶ ${frame.track.artist} — ${frame.track.title}`)
      this.emit('track', this.nowPlaying())
    }

    this.current.positionMs += frame.ms

    // burst buffer for instant joins
    this.#burst.push(frame)
    this.#burstMs += frame.ms
    while (this.#burstMs > this.options.burstMs && this.#burst.length > 1) {
      this.#burstMs -= this.#burst.shift().ms
    }

    for (const sub of this.subscribers.values()) {
      const ok = sub.stream.write(frame.data)
      sub.bytes += frame.data.length
      this.stats.bytesOut += frame.data.length
      if (!ok && sub.stream.writableLength > this.options.subscriberHighWaterMark) {
        this.log.warn(`dropping slow listener ${sub.label}`)
        this.subscribers.delete(sub.id)
        sub.stream.destroy()
      }
    }

    // progress event, ~1/s
    if (Math.floor(this.current.positionMs / 1000) !== this.#lastProgressSec) {
      this.#lastProgressSec = Math.floor(this.current.positionMs / 1000)
      this.emit('progress', { positionMs: this.current.positionMs, track: this.current.track })
    }
  }

  #lastProgressSec = -1

  #pushHistory(track) {
    this.history.unshift({ ...track, playedAt: Date.now() })
    if (this.history.length > this.options.historySize) this.history.length = this.options.historySize
  }

  /* ---------------------------- subscribers --------------------------- */

  subscribe({ label = 'http', burst = true } = {}) {
    if (this.subscribers.size >= this.options.maxListeners) throw new Error('Station listener limit reached')

    const id = randomUUID()
    const stream = new PassThrough({ highWaterMark: this.options.subscriberHighWaterMark })
    this.subscribers.set(id, { id, stream, label, bytes: 0, since: Date.now() })

    this.stats.listeners = this.subscribers.size
    this.stats.totalListeners += 1
    this.stats.peakListeners = Math.max(this.stats.peakListeners, this.subscribers.size)

    if (burst) for (const frame of this.#burst) stream.write(frame.data)

    const remove = () => {
      if (!this.subscribers.delete(id)) return
      this.stats.listeners = this.subscribers.size
      this.emit('listeners', this.subscribers.size)
    }
    stream.once('close', remove)
    stream.once('error', remove)

    this.emit('listeners', this.subscribers.size)
    if (!this.#running && this.options.autoStart) this.start()

    return stream
  }

  /* ------------------------------- relay ------------------------------ */

  /**
   * Turn whatever a caller handed us into an async iterable of bytes.
   *
   * A relay can be given a stream (a socket, an HTTP body, a file, a
   * generator) or simply a URL — including an HLS playlist, which is
   * followed segment by segment for as long as the relay lasts.
   */
  static async *openRelayInput(input, signal) {
    if (typeof input === 'string') {
      if (isHlsUrl(input)) {
        yield* hlsSegments(input, { signal })
        return
      }
      const res = await fetch(input, { signal, headers: { 'user-agent': 'Livy/3', accept: '*/*' } })
      if (!res.ok || !res.body) throw new Error(`upstream answered ${res.status}`)
      // A playlist served without the .m3u8 extension is still a playlist.
      const type = res.headers.get('content-type') ?? ''
      if (/mpegurl|m3u8/i.test(type)) {
        res.body.cancel?.()
        yield* hlsSegments(res.url || input, { signal })
        return
      }
      yield* res.body
      return
    }
    yield* input
  }


  #relay = null

  /** Is a live relay currently holding the transmitter? */
  get relaying() {
    return this.#relay?.active === true
  }

  /**
   * Put a live MP3 stream straight on air — the path plugins use.
   *
   * `input` is anything async-iterable that yields MP3 bytes: a socket, an
   * HTTP response, a child process's stdout, a generator. Bytes are re-framed
   * by MetroS and aired in short contiguous blocks; nothing is decoded, so a
   * relay costs a scan and a copy per chunk no matter how many listeners are
   * attached.
   *
   * The relay takes over from the rotation while it runs and hands the
   * station back when the stream ends (or `stop()` is called).
   *
   * @returns {{stop: Function, stats: Function, done: Promise<object>}}
   */
  relay(input, { title = 'Live relay', artist = this.name, id = `relay:${Date.now().toString(36)}`, artwork = null, maxBlockMs = 240, takeover = true, bitrate = this.options.bitrate ?? 128 } = {}) {
    if (this.#relay?.active) this.#relay.stop('replaced')

    const track = { source: 'relay', id, title, artist, artwork, live: true, duration: 0, streamable: true, relay: true }
    const framer = new MetroFramer({ coalesce: 8192 })
    // Every relay goes through MetroS: MP3 is detected and forwarded byte
    // for byte, anything else (AAC, HLS/MPEG-TS, Ogg, FLAC…) is decoded and
    // re-encoded on the way to the pacer.
    const transcoder = new MetroTranscoder({ bitrate })
    const abort = new AbortController()
    let resolveDone
    const done = new Promise((resolve) => {
      resolveDone = resolve
    })

    const handle = {
      active: true,
      track,
      startedAt: Date.now(),
      stats: () => ({
        ...framer.stats(),
        codec: transcoder.kind,
        passthrough: transcoder.passthrough,
        track: publicTrack(track),
        startedAt: handle.startedAt
      }),
      stop: (reason = 'stopped') => {
        if (!handle.active) return
        handle.active = false
        abort.abort()
        if (typeof input !== 'string') input.destroy?.()
        if (this.#relay === handle) this.#relay = null
        this.emit('relay', { station: this.id, state: 'ended', reason, stats: framer.stats() })
        this.log.info(`relay ended (${reason})`)
        resolveDone({ reason, ...framer.stats() })
        if (takeover) this.#wake()
      },
      done
    }

    this.#relay = handle

    if (takeover) {
      // Clear whatever the rotation had buffered so the relay starts now.
      this.#frames = []
      this.#bufferedMs = 0
      this.automix?.reset()
      this.#skipRequested = true
      this.#readerAbort?.abort()
    }

    if (!this.#running && this.options.autoStart !== false) this.start()
    this.emit('relay', { station: this.id, state: 'started', track: publicTrack(track) })
    this.log.info(`relay started: ${title}`)

    const pump = async () => {
      try {
        for await (const raw of Station.openRelayInput(input, abort.signal)) {
          if (!handle.active || !this.#running) break

          const chunk = transcoder.push(raw)
          if (chunk.length === 0) continue
          if (!track.codec) {
            track.codec = transcoder.kind
            if (!transcoder.passthrough) this.log.info(`relay: transcoding ${transcoder.kind} → mp3`)
          }

          const { blocks, info } = framer.pushBlocks(chunk, { maxBlockMs })
          if (info && !track.streamBitrate) {
            track.streamBitrate = info.bitrate
            track.sampleRate = info.sampleRate
          }
          for (const block of blocks) {
            this.#frames.push({ data: block.data, ms: block.ms, track })
            this.#bufferedMs += block.ms
          }
          while (handle.active && this.#running && this.#bufferedMs > this.options.bufferAheadMs) {
            await this.#sleep(120)
          }
        }
        const tail = transcoder.flush()
        if (tail.length) framer.pushBlocks(tail, { maxBlockMs }).blocks.forEach((block) => {
          this.#frames.push({ data: block.data, ms: block.ms, track })
          this.#bufferedMs += block.ms
        })
        for (const block of framer.flush({ maxBlockMs }).blocks) {
          this.#frames.push({ data: block.data, ms: block.ms, track })
          this.#bufferedMs += block.ms
        }
        handle.stop('stream ended')
      } catch (error) {
        this.log.warn(`relay failed: ${error.message}`)
        handle.stop(error.message)
      }
    }
    pump()

    return handle
  }

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
  }

  get listeners() {
    return this.subscribers.size
  }

  info({ queue = false, owner = false } = {}) {
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
      automix: this.automix.info(),
      // Public payloads never expose a filesystem path: listeners learn that
      // an ident exists, owners get the real record.
      intro: this.options.intro ? (owner ? this.options.intro : { tts: this.options.intro.tts ?? null, audio: Boolean(this.options.intro.file) }) : null,
      owner: this.options.owner ?? null,
      requests: this.publicRequests().slice(0, 10),
      requestCount: this.requests.length,
      voteSkips: { votes: this.voteSkips.size, needed: Math.max(1, Math.ceil(this.listeners * this.options.voteSkipRatio)) },
      listeners: this.listeners,
      bufferedMs: Math.round(this.#bufferedMs),
      uptime: this.stats.startedAt ? Date.now() - this.stats.startedAt : 0,
      stats: this.stats,
      history: this.history.slice(0, 5).map(publicTrack),
      ...(queue ? { queue: this.queue.map(publicTrack) } : {})
    }
  }

  toJSON() {
    return this.info()
  }

  /* ------------------------------ helpers ----------------------------- */

  #sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** Silence generator used when a station has nothing to play (keeps players connected). */
  pushSilence(ms = 1000) {
    const { frames } = buildSilence(ms)
    for (const data of frames) {
      this.#frames.push({ data, ms: (1152 / 44100) * 1000, track: this.current?.track ?? { id: '__silence__', title: 'Silence', artist: this.name } })
      this.#bufferedMs += (1152 / 44100) * 1000
    }
  }
}

export default Station

/** Bitrates a re-encode may use: the frame's own rate, inside the MP3 range. */
function clampBitrate(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 128
  return Math.max(96, Math.min(320, Math.round(number)))
}
