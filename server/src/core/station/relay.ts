/**
 * Listeners and live relays.
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

export const relayMethods = {
  /* ---------------------------- subscribers --------------------------- */

  subscribe({ label = 'http', burst = true }: any = {}) {
    if (this.subscribers.size >= this.options.maxListeners) throw new Error('Station listener limit reached')

    const id = randomUUID()
    const stream = new PassThrough({ highWaterMark: this.options.subscriberHighWaterMark })
    this.subscribers.set(id, { id, stream, label, bytes: 0, since: Date.now() })

    this.stats.listeners = this.subscribers.size
    this.stats.totalListeners += 1
    this.stats.peakListeners = Math.max(this.stats.peakListeners, this.subscribers.size)

    if (burst) {
      for (const frame of this._burst) {
        if (stream.destroyed || stream.writableEnded) break
        stream.write(frame.data)
      }
    }

    const remove = () => {
      if (!this.subscribers.delete(id)) return
      this.stats.listeners = this.subscribers.size
      this.emit('listeners', this.subscribers.size)
    }
    stream.once('close', remove)
    stream.once('error', remove)

    this.emit('listeners', this.subscribers.size)
    if (!this._running && this.options.autoStart) this.start()

    return stream
  },

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
  relay(input, { title = 'Live relay', artist = this.name, id = `relay:${Date.now().toString(36)}`, artwork = null, maxBlockMs = 240, takeover = true, bitrate = this.options.bitrate ?? 128 }: any = {}) {
    if (this._relay?.active) this._relay.stop('replaced')

    const track: Record<string, any> = { source: 'relay', id, title, artist, artwork, live: true, duration: 0, streamable: true, relay: true }
    const framer = new MetroFramer({ coalesce: 8192 })
    // Every relay goes through MetroS: MP3 is detected and forwarded byte
    // for byte, anything else (AAC, HLS/MPEG-TS, Ogg, FLAC…) is decoded and
    // re-encoded on the way to the pacer.
    const transcoder = new MetroTranscoder({ bitrate })
    const abort = new AbortController()
    let resolveDone: (value: Record<string, any>) => void
    const done = new Promise<Record<string, any>>((resolve) => {
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
        if (typeof input !== 'string') {
          input?.destroy?.()
          input?.cancel?.().catch?.(() => {})
        }
        if (this._relay === handle) this._relay = null
        this.emit('relay', { station: this.id, state: 'ended', reason, stats: framer.stats() })
        this.log.info(`relay ended (${reason})`)
        resolveDone({ reason, ...framer.stats() })
        if (takeover) this._wake()
      },
      done
    }

    this._relay = handle

    if (takeover) {
      // Clear whatever the rotation had buffered so the relay starts now.
      this._frames = []
      this._bufferedMs = 0
      this.automix?.reset()
      this._skipRequested = true
      this._readerAbort?.abort()
    }

    if (!this._running && this.options.autoStart !== false) this.start()
    this.emit('relay', { station: this.id, state: 'started', track: publicTrack(track) })
    this.log.info(`relay started: ${title}`)

    const pump = async () => {
      try {
        for await (const raw of this.constructor.openRelayInput(input, abort.signal)) {
          if (!handle.active || !this._running) break

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
            this._frames.push({ data: block.data, ms: block.ms, track })
            this._bufferedMs += block.ms
          }
          while (handle.active && this._running && this._bufferedMs > this.options.bufferAheadMs) {
            await this._sleep(120)
          }
        }
        const tail = transcoder.flush()
        if (tail.length) framer.pushBlocks(tail, { maxBlockMs }).blocks.forEach((block) => {
          this._frames.push({ data: block.data, ms: block.ms, track })
          this._bufferedMs += block.ms
        })
        for (const block of framer.flush({ maxBlockMs }).blocks) {
          this._frames.push({ data: block.data, ms: block.ms, track })
          this._bufferedMs += block.ms
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
}

export default relayMethods
