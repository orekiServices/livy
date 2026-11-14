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

import { queueMethods } from './station/queue.js'
import { requestsMethods } from './station/requests.js'
import { playbackMethods } from './station/playback.js'
import { seamMethods } from './station/seams.js'
import { relayMethods } from './station/relay.js'
import { infoMethods } from './station/info.js'
import { DEFAULTS, publicTrack } from './station/shared.js'

export { publicTrack } from './station/shared.js'

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
    this._filterCache = { track: null, held: [], heldMs: 0, bitrate: 128 }

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

    this._frames = [] // [{ data, ms, track }]
    this._bufferedMs = 0
    this._burst = []
    this._burstMs = 0
  }

  _frames
  _filterCache = { track: null, held: [], heldMs: 0, bitrate: 128 }
  _bufferedMs
  _burst
  _burstMs
  _running = false
  _readerAbort = null
  _pacerTimer = null
  _clock = 0 // ms of audio emitted since start
  _origin = 0 // hrtime ms at pacer start
  _skipRequested = false
  _loadingPromise = null










  /* --------------------------- DJ seam log ---------------------------- */

  _lastSeam = null












  /* --------------------------- announcements -------------------------- */

  _lastIntroAt = 0





  /* ----------------------------- lifecycle ---------------------------- */

  async start() {
    if (this._running) return this
    this._running = true
    this.stats.startedAt = Date.now()
    this._clock = 0
    this._origin = performance.now()
    this._startPacer()
    this._readLoop().catch((error) => {
      this.log.error(error)
      this._setState('error')
    })
    return this
  }

  stop(reason = 'stopped') {
    this._running = false
    this._readerAbort?.abort()
    clearTimeout(this._pacerTimer)
    this._pacerTimer = null
    this._frames = []
    this._bufferedMs = 0
    this.automix?.reset()
    this.current = null
    this._setState('stopped')
    this.log.info(`stopped (${reason})`)
    return this
  }

  destroy() {
    this.stop('destroyed')
    for (const sub of this.subscribers.values()) sub.stream.destroy()
    this.subscribers.clear()
    this.removeAllListeners()
  }

  _setState(next) {
    if (this.state === next) return
    const previous = this.state
    this.state = next
    this.emit('state', next, previous)
  }

  _wake() {
    if (this._running && !this._readerBusy) this._readLoop().catch((error) => this.log.error(error))
  }

  /* ------------------------------ reader ------------------------------ */

  _readerBusy = false


  _readingTrackId = null
  _consecutiveFailures = 0
  _requeueCandidate = null
















  _silence = []


  _lastProgressSec = -1



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


  _relay = null

  /** Is a live relay currently holding the transmitter? */
  get relaying() {
    return this._relay?.active === true
  }



  get listeners() {
    return this.subscribers.size
  }



  /* ------------------------------ helpers ----------------------------- */

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** Silence generator used when a station has nothing to play (keeps players connected). */
  pushSilence(ms = 1000) {
    const { frames } = buildSilence(ms)
    for (const data of frames) {
      this._frames.push({ data, ms: (1152 / 44100) * 1000, track: this.current?.track ?? { id: '__silence__', title: 'Silence', artist: this.name } })
      this._bufferedMs += (1152 / 44100) * 1000
    }
  }
}
Object.assign(Station.prototype, queueMethods, requestsMethods, playbackMethods, seamMethods, relayMethods, infoMethods)

export default Station
