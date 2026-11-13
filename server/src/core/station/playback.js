/**
 * The reader, filters and the track reader.
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
  clampBitrate,
  publicTrack
} from './deps.js'

export const playbackMethods = {
  async _readLoop() {
    if (this._readerBusy) return
    this._readerBusy = true

    try {
      while (this._running) {
        // A live relay owns the transmitter while it lasts.
        if (this._relay?.active) {
          this.memory?.save(this)
          await this._sleep(250)
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
            const intro = this._introTrack()
            const due = Date.now() - this._lastIntroAt >= (this.options.idleAnnouncementMs ?? 120_000)
            if (intro && due) {
              this._lastIntroAt = Date.now()
              this.announcements.push(intro)
            } else {
              this.emit('empty')
              this._setState(this.current ? 'playing' : 'idle')
              await this._flushAutomix('nothing queued')
              await this._sleep(2000)
              continue
            }
          }
        }

        const next = this._takeNext()
        if (!next) {
          await this._flushAutomix('nothing to take')
          await this._sleep(500)
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

        await this._readTrack(track)
        // The reader's last block left one encoded frame in hand. It belongs
        // on air before the next track's first frame, not spliced behind it.
        await this._flushFilterFrames()
        // The track played out, so the transition into it was a keeper: this
        // is the positive label the trainer learns from.
        if (this._lastSeam && !this._skipRequested) {
          this._logSeam({ ...this._lastSeam, outcome: 'completed', completedAfterMs: Date.now() - this._lastSeam.at })
          this._lastSeam = null
        }
      }
    } finally {
      this._readerBusy = false
    }
  },

  /**
   * Put reader frames on air. The automix sits in the middle of this path: it
   * runs one crossfade behind the reader and may replace the seam between two
   * songs with a rendered blend (plus a DJ voice track over the top).
   */
  async _air(batch) {
    let ready = batch

    // Filters first: they are what the listener hears, and the automix's seam
    // renderer produces already-encoded MP3 — filtering after it would mean
    // decoding audio that was just encoded. Unfiltered, this is one property
    // read per batch.
    if (this.filters && !this.filters.empty) {
      try {
        ready = await this._filterThrough(ready)
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
      this._frames.push(frame)
      this._bufferedMs += frame.ms
    }
  },

  /**
   * Drive one batch through the air path exactly as the reader does.
   *
   * Public because the filter chain is the one stage whose correctness is a
   * question about *audio*, and a test that re-implements decode → chain →
   * encode would pass even if `_air` stopped calling it. Named with the double
   * underscore so it reads as the test seam it is, not as API.
   */
  async __airForTest(batch) {
    if (this.filters && !this.filters.empty) return this._filterThrough(batch)
    return batch
  },

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
  async _filterThrough(batch) {
    if (!batch.length) return batch
    const track = batch[0].track

    // A new track (or a different one mid-batch) starts a clean block: the old
    // remainder would otherwise splice onto the head of the next song.
    if (track?.id !== this._filterCache.track?.id) {
      this._filterCache.track = track
      this._filterCache.held = []
      this._filterCache.heldMs = 0
      this.filters.reset()
    }

    const held = this._filterCache.held
    const bitrate = clampBitrate(track?.streamBitrate ?? this._filterCache.bitrate ?? 128)
    this._filterCache.bitrate = bitrate

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
    this._filterCache.held = keep ? parsed.frames.slice(-keep) : []
    this._filterCache.heldMs = frameMs * this._filterCache.held.length

    return emit.map((data) => ({ data, ms: frameMs, track }))
  },

  /** Push `flushFilters()` output onto the air, if there is any. */
  async _flushFilterFrames() {
    const frames = await this.flushFilters().catch(() => [])
    for (const frame of frames) {
      this._frames.push(frame)
      this._bufferedMs += frame.ms
    }
    return frames
  },

  /**
   * Release the filter's held frame.
   *
   * One frame of audio is always in hand; it belongs on air before the track
   * ends, or the last 26 ms of every song disappears. `reset` clears the
   * chain's biquad memory (a new track must not inherit the old one's tail).
   */
  async flushFilters() {
    if (!this.filters || this.filters.empty) return []
    const held = this._filterCache.held ?? []
    if (!held.length) return []
    const track = this._filterCache.track
    const frameMs = this._filterCache.heldMs / held.length
    this._filterCache.held = []
    this._filterCache.heldMs = 0
    return held.map((data) => ({ data, ms: frameMs, track }))
  },

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
  },

  /** Release audio the automix is holding back (end of programme, errors). */
  async _flushAutomix(reason = 'flush') {
    if (!this.automix?.enabled) return
    try {
      const frames = await this.automix.flush(reason)
      for (const frame of frames) {
        this._frames.push(frame)
        this._bufferedMs += frame.ms
      }
    } catch (error) {
      this.log.debug(`automix flush failed: ${error.message}`)
    }
  },

  /** Owner control: change transition style / DJ behaviour while on air. */
  setAutomix(patch = {}) {
    const info = this.automix.configure(patch)
    this.options.automix = { ...(this.options.automix ?? {}), ...patch }
    this.emit('automix', { ...info, configured: true })
    return info
  },

  /** Put a rotation track back at the tail — only after it really played. */
  _requeue(played) {
    const candidate = this._requeueCandidate
    this._requeueCandidate = null
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
      this._wake()
      return
    }

    this.queue.push(candidate)
    this.emit('queue', this.queue)
  },

  /**
   * What this station was doing when the node stopped.
   *
   * The queue comes back first (so the running order survives), and the
   * track that was on air is put at the front with the offset it had
   * reached — `_readTrack` then drops frames until it gets there, which
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
  },

  async _readTrack(track) {
    this._skipRequested = false
    this._readerAbort = new AbortController()
    this._readingTrackId = track.id

    let opened
    try {
      opened = await this.sources.stream(track, {
        signal: this._readerAbort.signal,
        fallbackTag: this._fallbackTag(track),
        // Relaying a live station is a last resort: only reach for it once the
        // station has failed repeatedly, never for a single dead link.
        allowLiveFallback: this._consecutiveFailures >= 2,
        onMetadata: (title) => {
          this.liveTitle = title
          this.emit('track', { ...this.nowPlaying(), liveTitle: title })
        }
      })
      this._consecutiveFailures = 0
      if (opened.fallback) {
        this.stats.fallbacks += 1
        // keep the requester attribution when we had to clone the track
        track = { ...opened.track, requestedBy: track.requestedBy, requestId: track.requestId, fallbackOf: track.title }
        this._readingTrackId = track.id
      }
    } catch (error) {
      this.stats.errors += 1
      this._consecutiveFailures += 1
      this.log.warn(`skip "${track.title}": ${error.message}`)
      this.emit('error', error)
      this._requeue(false)
      await this._flushAutomix('track failed')
      await this._sleep(this.options.skipOnErrorDelay)
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
      ? hlsSegments(opened.url, { signal: this._readerAbort.signal })
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
    this._readerAbort.signal.addEventListener('abort', onAbort, { once: true })

    try {
      for await (const raw of stream) {
        if (!this._running || this._skipRequested) break

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
            this._frames.push({ data: block.data, ms: block.ms, track })
            this._bufferedMs += block.ms
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
            if (batch.length) await this._air(batch.map((data) => ({ data, ms, track })))
          }
        }

        // Backpressure: stay ~bufferAheadMs in front of the pacer.
        while (this._running && this._bufferedMs > this.options.bufferAheadMs) {
          await this._sleep(120)
        }
      }
    } catch (error) {
      if (!this._skipRequested) {
        this.stats.errors += 1
        this.log.warn(`stream error on "${track.title}": ${error.message}`)
      }
    } finally {
      this._readerAbort.signal.removeEventListener('abort', onAbort)
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
          if (parsed.frames.length) await this._air(parsed.frames.map((data) => ({ data, ms, track })))
        }
      } catch (error) {
        this.log.debug(`transcode flush: ${error.message}`)
      }
    }

    // Anything the coalescer is still holding belongs on air, not in memory.
    if (live) {
      for (const block of framer.flush().blocks) {
        frames += block.frames
        this._frames.push({ data: block.data, ms: block.ms, track })
        this._bufferedMs += block.ms
      }
    }

    if (frames === 0) {
      this.log.warn(`"${track.title}" produced no MP3 frames`)
      this._requeue(false)
      await this._flushAutomix('track failed')
      await this._sleep(this.options.skipOnErrorDelay)
      return
    }

    this._requeue(true)
  },

  /**
   * Tag used when the station has to relay a live stream as a last resort.
   * A station genre like "Premium" is not a music genre and would match
   * something absurd in the directory, so unknown genres fall back to a safe
   * default instead of whatever the search engine feels like.
   */
  _fallbackTag(track) {
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
  },

  /** Public shim over _fallbackTag (used by tests and the owner API). */
  fallbackTagFor(track = {}) {
    return this._fallbackTag(track)
  },

  /* ------------------------------- pacer ------------------------------ */

  _startPacer() {
    const tick = () => {
      if (!this._running) return

      const elapsed = performance.now() - this._origin
      let guard = 0

      // Emit every frame whose playback time has arrived.
      while (this._clock <= elapsed && this._frames.length > 0 && guard++ < 4000) {
        const frame = this._frames.shift()
        this._bufferedMs -= frame.ms
        this._clock += frame.ms
        this._emitFrame(frame)
      }

      if (this._frames.length === 0 && this._clock < elapsed) {
        // Underrun: the reader is behind. Re-base the clock so we do not try to
        // "catch up" by dumping a burst of audio at the listeners later.
        this._clock = elapsed
        if (this.state === 'playing' && this.current) this._setState('loading')
        // An empty station (a fresh iMusic Pro channel) would otherwise send
        // nothing at all and players would time out. Keep the carrier open
        // with silent MP3 frames between idents.
        this._emitKeepAlive()
      }

      this._pacerTimer = setTimeout(tick, 40)
    }
    tick()
  },

  /** Silent MP3 frames so an idle station still holds its listeners. */
  _emitKeepAlive() {
    if (this.subscribers.size === 0) return
    if (this._silence.length === 0) {
      const built = buildSilence(1000)
      const ms = built.durationMs / Math.max(1, built.frames.length)
      this._silence = built.frames.map((data) => ({ data, ms }))
    }
    for (const frame of this._silence) {
      for (const sub of this.subscribers.values()) {
        sub.stream.write(frame.data)
        sub.bytes += frame.data.length
        this.stats.bytesOut += frame.data.length
      }
    }
    this._clock += this._silence.reduce((n, f) => n + f.ms, 0)
  },

  _emitFrame(frame) {
    // Track boundary?
    if (!this.current || this.current.track.id !== frame.track.id) {
      if (this.current) this._pushHistory(this.current.track)
      // A resumed track starts its clock where it left off, so the console,
      // the lyrics and the progress bar all agree with what is being heard.
      const resumedAt = Number(frame.track.resumeMs) || 0
      this.current = { track: frame.track, startedAt: Date.now() - resumedAt, positionMs: resumedAt }
      this.liveTitle = null
      this.voteSkips.clear()
      this.stats.tracksPlayed += 1
      this._setState('playing')
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
    this._burst.push(frame)
    this._burstMs += frame.ms
    while (this._burstMs > this.options.burstMs && this._burst.length > 1) {
      this._burstMs -= this._burst.shift().ms
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
    if (Math.floor(this.current.positionMs / 1000) !== this._lastProgressSec) {
      this._lastProgressSec = Math.floor(this.current.positionMs / 1000)
      this.emit('progress', { positionMs: this.current.positionMs, track: this.current.track })
    }
  },

  _pushHistory(track) {
    this.history.unshift({ ...track, playedAt: Date.now() })
    if (this.history.length > this.options.historySize) this.history.length = this.options.historySize
  }
}

export default playbackMethods
