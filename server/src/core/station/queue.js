/**
 * Queue, rotation, seam logging and skips.
 *
 * Mixed into Station.prototype in ../station.js.
 */
import { recordSeam } from '../models/trainer/dataset.js'
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
} from './deps.js'

export const queueMethods = {
  /* ------------------------------ queue ------------------------------- */

  /** Resolve the configured playlists into the queue (lazy, once). */
  async load(force = false) {
    if (this._loadingPromise && !force) return this._loadingPromise
    if (this.queue.length > 0 && !force) return this.queue

    this._setState('loading')
    this._loadingPromise = (async () => {
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
      this._loadingPromise = null
    })

    return this._loadingPromise
  },

  enqueue(tracks, { position = -1 } = {}) {
    const list = Array.isArray(tracks) ? tracks : [tracks]
    if (position >= 0) this.queue.splice(position, 0, ...list)
    else this.queue.push(...list)
    this.emit('queue', this.queue)
    if (this._running && !this.current) this._wake()
    return this.queue.length
  },

  /**
   * Put one song on air now: front of the queue, then skip the current track.
   * A listener picking a song in the web client is the same operation as the
   * owner's "play next", without the owner key.
   */
  playNow(track, { by = 'listener' } = {}) {
    if (!track?.id) throw Object.assign(new Error('A track is required'), { status: 400 })
    const entry = { ...track, requestedBy: String(by).slice(0, 32), requestedAt: Date.now() }
    this.enqueue([entry], { position: 0 })
    if (this.current) this.skip()
    else if (this.state === 'idle') this.start()
    this.emit('queue', this.queue)
    return entry
  },

  removeAt(index) {
    const [removed] = this.queue.splice(index, 1)
    if (removed) this.emit('queue', this.queue)
    return removed
  },

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
  },

  /** Jump a queued track to the front — the "play next" button. */
  playNext(index) {
    return this.move(index, 0)
  },

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
  },

  clearQueue() {
    this.queue = []
    this.emit('queue', this.queue)
  },

  shuffle(emit = true) {
    for (let i = this.queue.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]]
    }
    if (emit) this.emit('queue', this.queue)
    return this.queue
  },

  skip() {
    const playingId = this.current?.track?.id ?? this._frames[0]?.track?.id
    if (!playingId) return false

    // A skip is the only listener signal a radio stream gets, and it is the
    // label the DJ model learns from. It is only attributable to the
    // transition if it happened close to one; `recordSkip()` decides that, and
    // a skip in the middle of a song teaches the model nothing about seams.
    this._recordSkip(playingId)

    // Drop everything still buffered for the current track: the pacer then
    // plays the next track's frames on its very next tick.
    this._frames = this._frames.filter((f) => f.track?.id !== playingId)
    this._bufferedMs = this._frames.reduce((n, f) => n + f.ms, 0)

    // Only tear down the download if it is still the track we just skipped —
    // otherwise we would also kill the prefetch of the *next* track.
    if (this._readingTrackId === playingId) {
      this._skipRequested = true
      this._readerAbort?.abort()
    }
    return true
  },

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
    this._lastSeam = {
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
      to: report.to ?? null,
      // What the music was doing on either side — what RL learns from. The
      // entry is often not known yet (the incoming song has barely been
      // read); `_logSeam` fills it in when the label is written.
      ...this._seamKindsNow(report)
    }
    return this._lastSeam
  },

  /**
   * Close the loop on the last transition.
   *
   * `outcome` is `completed` (the track played out) or `skipped` (somebody
   * pressed the button). The log line is what the trainer reads.
   */
  _recordSkip(playingId) {
    const seam = this._lastSeam
    if (!seam) return false
    const since = Date.now() - seam.at
    // A skip further than a couple of minutes from the seam says nothing about
    // it — the listener skipped the *song*.
    if (since > 180_000) {
      this._lastSeam = null
      return false
    }
    return this._logSeam({ ...seam, outcome: 'skipped', skippedAfterMs: since, skippedTrack: playingId })
  },

  /** The kinds of beat at the last advised seam, as far as they are known. */
  _seamKindsNow(report = {}) {
    const context = this._seamContext
    if (!context) return {}
    const blendMs = report.blendMs ?? 6000
    const entry = context.entry ?? this._scoutFor?.(context.to)?.beatAt(blendMs) ?? null
    if (entry) context.entry = entry
    return {
      exitKind: context.exit?.category ?? null,
      exitBeat: context.exit?.descriptor ?? null,
      entryKind: entry?.category ?? null,
      entryBeat: entry?.descriptor ?? null
    }
  },

  _logSeam(record) {
    try {
      if (record.exitKind !== undefined && !record.entryKind) record = { ...record, ...this._seamKindsNow({ blendMs: record.fadeMs }) }
      // Both destinations are written by the dataset: the MetroDB row the
      // trainer polls and the JSONL tail for a node without a database. The
      // optional `seamLogFile` override is for embedded nodes and tests; the
      // default stays in the data directory.
      return recordSeam(record, {
        store: this.store,
        file: this.options?.seamLogFile ?? undefined
      })
    } catch (error) {
      this.log.warn(`seam log failed: ${error.message}`)
      return false
    }
  },

  /* ------------------------------ requests ---------------------------- */

  /** Next thing to play: listener requests first (most voted), then rotation. */
  _takeNext() {
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
      const intro = this._introTrack()
      if (intro && Date.now() - this._lastIntroAt >= (this.options.idleAnnouncementMs ?? 120_000)) {
        this._lastIntroAt = Date.now()
        return intro
      }
      return null
    }

    const track = this.queue.shift()
    // Endless rotation, but a track earns its place back by *playing*: a dead
    // link would otherwise loop forever at the head of the queue.
    this._requeueCandidate = this.options.loop ? track : null
    this.emit('queue', this.queue)
    return track
  }
}

export default queueMethods
