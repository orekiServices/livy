/**
 * MetroS — the relay engine.
 *
 * Every byte a station airs passes through a re-framer: live relays from
 * plugins, HTTP/ICY ingest, local files, automix output. That loop is the one
 * piece of Livy that scales with listeners *and* with stations, so it has
 * a native implementation — `libmetro`, a Rust + napi-rs addon — and a pure
 * JavaScript one.
 *
 * The native engine is optional in the strongest sense: if no binary exists
 * for the host, `libmetro` returns nothing, and everything here transparently
 * uses `src/util/mp3.js` instead. Same API, same bytes out, just slower. No
 * install step, no postinstall compile, no failure mode where the node will
 * not boot because a toolchain is missing.
 *
 * What the native path actually buys (measured on this machine, 44 s of
 * 128 kbps stereo):
 *
 *   re-framing, 64 KB chunks   0.38 ms → 0.15 ms   (~2.6x)
 *   re-framing, 8 KB chunks    0.65 ms → 0.33 ms   (~2.0x)
 *   decode to PCM            113.8 ms → 46.9 ms    (~2.4x vs the WASM decoder)
 *
 * The re-framing numbers come from `pushInto`, which writes whole frames into
 * a buffer the caller owns: in steady state a relay allocates nothing per
 * chunk and crosses the FFI boundary exactly once.
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Mp3FrameSplitter, parseFrameHeader, probeMp3 as probeMp3Js, id3v2Size, isXingFrame, buildSilence } from './mp3.js'
import { createLogger } from './logger.js'

const log = createLogger('metro')
const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))

/** Where a libmetro build might live, in order of preference. */
const CANDIDATES = [
  // bundled with the node (the layout this repo ships)
  path.join(here, '..', '..', '..', 'native', 'libmetro', 'index.js'),
  // installed as a dependency
  'libmetro'
]

function loadNative() {
  // `NODECAST_DISABLE_METRO` is honoured too: an existing deployment's
  // environment keeps working after the rename.
  if (process.env.LIVY_DISABLE_METRO === '1' || process.env.NODECAST_DISABLE_METRO === '1') return null
  for (const candidate of CANDIDATES) {
    try {
      const mod = require(candidate)
      if (mod?.available && typeof mod.Framer === 'function') return mod
    } catch {
      /* try the next location */
    }
  }
  return null
}

const native = loadNative()

/** 2048 frames is ~53 s of audio — far more than any single chunk carries. */
const MAX_FRAMES_PER_PUSH = 2048
const EMPTY = Buffer.alloc(0)

/**
 * Streaming re-framer: feed it bytes, get whole MP3 frames back.
 *
 * Drop-in compatible with `Mp3FrameSplitter` — `push()` returns
 * `{ frames, durationMs, info }` — so callers never learn which engine they
 * got. Frames are always safe to keep: each push writes into its own buffer.
 */
export class MetroFramer {
  #native = null
  #js = null
  #lengths = null
  #coalesce = 0
  #hold = []
  #holdBytes = 0
  #pending = 0
  #frames = 0
  #bytes = 0
  #dropped = 0
  #durationMs = 0
  #info = null

  /**
   * @param {object} [options]
   * @param {boolean} [options.skipVbrHeader] drop a leading Xing/Info frame
   * @param {number} [options.coalesce] hold chunks smaller than this many
   *   bytes and hand them over in one go. A live relay is fed by the kernel
   *   in whatever sizes the network produced — often 1–2 KB — and at that
   *   size the crossing into native code costs more than the scan itself.
   *   Relays set this; parsers that must see every byte immediately (and
   *   tests) leave it off. Anything held is released by `flush()`.
   */
  constructor({ skipVbrHeader = true, coalesce = 0 } = {}) {
    this.#coalesce = coalesce
    if (native) {
      this.#native = new native.Framer({ skipVbrHeader })
      this.#lengths = new Uint32Array(MAX_FRAMES_PER_PUSH)
    } else {
      this.#js = new Mp3FrameSplitter()
    }
  }

  /** Which engine this framer is actually running. */
  get engine() {
    return this.#native ? 'native' : 'javascript'
  }

  /**
   * @param {Buffer} chunk
   * @returns {{frames: Buffer[], durationMs: number, info: object|null}}
   */
  push(chunk, { flush = false } = {}) {
    chunk = this.#gather(chunk, flush)
    if (!chunk) return { frames: [], durationMs: 0, info: this.#info }

    if (this.#js) return this.#pushJs(chunk)

    // Upper bound on the output: everything held back plus everything new.
    // `allocUnsafe` is pooled for small sizes, and because this buffer is
    // never reused the frame views handed out stay valid for as long as the
    // caller keeps them — which matters, since the pacer airs them later.
    const out = Buffer.allocUnsafe(chunk.length + this.#pending)
    const result = this.#native.pushInto(chunk, out, this.#lengths)

    const frames = []
    let offset = 0
    for (let i = 0; i < result.frames; i += 1) {
      const length = this.#lengths[i]
      frames.push(out.subarray(offset, offset + length))
      offset += length
    }

    this.#frames += result.frames
    this.#bytes += chunk.length
    this.#dropped += result.dropped
    this.#durationMs += result.durationMs
    this.#pending = result.pending
    // The engine only sends the format when it changes, so cache it.
    if (result.format) this.#info = normaliseInfo(result.format)

    return { frames, durationMs: result.durationMs, info: this.#info }
  }

  /**
   * Relay mode: whole frames grouped into a handful of contiguous blocks
   * instead of hundreds of individual frames.
   *
   * A live relay does not need per-frame objects — nothing crossfades a
   * stream that is already playing — and the pacer is happy to air a block
   * as one unit. Grouping is where the native engine actually shows up in a
   * profile: one `memcpy` in Rust, one buffer in JavaScript, and ~10x fewer
   * objects for the garbage collector than frame-by-frame relaying.
   *
   * Blocks stay short (`maxBlockMs`, ~a quarter second by default) so the
   * pacer keeps releasing audio smoothly rather than in bursts.
   *
   * @returns {{blocks: {data: Buffer, ms: number, frames: number}[], durationMs: number, info: object|null}}
   */
  pushBlocks(chunk, { maxBlockMs = 240, flush = false } = {}) {
    chunk = this.#gather(chunk, flush)
    if (!chunk) return { blocks: [], durationMs: 0, info: this.#info }

    if (this.#js) {
      // Straight to the splitter: the chunk has already been gathered.
      const { frames, durationMs } = this.#pushJs(chunk)
      return { blocks: groupFrames(frames, this.#info, maxBlockMs), durationMs, info: this.#info }
    }

    const out = Buffer.allocUnsafe(chunk.length + this.#pending)
    const result = this.#native.pushInto(chunk, out, this.#lengths)

    this.#frames += result.frames
    this.#bytes += chunk.length
    this.#dropped += result.dropped
    this.#durationMs += result.durationMs
    this.#pending = result.pending
    if (result.format) this.#info = normaliseInfo(result.format)

    const frameMs = this.#info?.durationMs ?? 26.122448979591837
    const perBlock = Math.max(1, Math.round(maxBlockMs / frameMs))

    const blocks = []
    let offset = 0
    let start = 0
    let count = 0
    for (let i = 0; i < result.frames; i += 1) {
      offset += this.#lengths[i]
      count += 1
      if (count === perBlock || i === result.frames - 1) {
        // A view, not a copy: the frames are already contiguous in `out`.
        blocks.push({ data: out.subarray(start, offset), ms: count * frameMs, frames: count })
        start = offset
        count = 0
      }
    }

    return { blocks, durationMs: result.durationMs, info: this.#info }
  }

  /** The JavaScript engine's push, without the coalescing layer. */
  #pushJs(chunk) {
    const out = this.#js.push(chunk)
    this.#frames += out.frames.length
    this.#bytes += chunk.length
    this.#durationMs += out.durationMs
    this.#pending = this.#js.pending
    if (out.info) this.#info = out.info
    return { frames: out.frames, durationMs: out.durationMs, info: this.#info }
  }

  /**
   * Collect trickle-sized chunks into something worth a native call.
   * Returns the buffer to process, or null when there is nothing to do yet.
   */
  #gather(chunk, flush) {
    if (!this.#coalesce) return chunk ?? EMPTY
    if (chunk?.length) {
      this.#hold.push(chunk)
      this.#holdBytes += chunk.length
    }
    if (!flush && this.#holdBytes < this.#coalesce) return null
    if (this.#holdBytes === 0) return null
    const joined = this.#hold.length === 1 ? this.#hold[0] : Buffer.concat(this.#hold, this.#holdBytes)
    this.#hold = []
    this.#holdBytes = 0
    return joined
  }

  /**
   * Release everything held back — call it when a stream ends, or audio
   * that arrived in small pieces would never be aired.
   */
  flush({ maxBlockMs = 240 } = {}) {
    return this.pushBlocks(EMPTY, { maxBlockMs, flush: true })
  }

  /** Bytes held back behind an incomplete frame (or waiting to be coalesced). */
  get pending() {
    return this.#pending + this.#holdBytes
  }

  /** Running totals — what a station reports as relay health. */
  stats() {
    return {
      engine: this.engine,
      frames: this.#frames,
      bytes: this.#bytes,
      dropped: this.#dropped,
      durationMs: this.#durationMs,
      pending: this.#pending,
      bitrate: this.#info?.bitrate ?? 0,
      sampleRate: this.#info?.sampleRate ?? 0,
      channels: this.#info?.channels ?? 0
    }
  }

  reset() {
    this.#native?.reset()
    this.#js?.reset()
    this.#hold = []
    this.#holdBytes = 0
    this.#pending = 0
    this.#info = null
  }
}

/** Fallback grouping: the JS splitter hands back separate buffers. */
function groupFrames(frames, info, maxBlockMs) {
  const frameMs = info?.durationMs ?? 26.122448979591837
  const perBlock = Math.max(1, Math.round(maxBlockMs / frameMs))
  const blocks = []
  for (let i = 0; i < frames.length; i += perBlock) {
    const group = frames.slice(i, i + perBlock)
    blocks.push({
      data: group.length === 1 ? group[0] : Buffer.concat(group),
      ms: group.length * frameMs,
      frames: group.length
    })
  }
  return blocks
}

/** The native FrameInfo carries a few extras; keep the JS shape authoritative. */
function normaliseInfo(info) {
  return {
    length: info.length,
    durationMs: info.durationMs,
    bitrate: info.bitrate,
    sampleRate: info.sampleRate,
    channels: info.channels,
    version: info.version === 10 ? 1 : info.version === 20 ? 2 : 2.5,
    layer: info.layer,
    samples: info.samples
  }
}

/** Measure an in-memory MP3: frame count, duration, bitrate, sample rate. */
export function probeMp3(buffer) {
  if (!native) return probeMp3Js(buffer)
  const info = native.probe(buffer)
  return {
    frames: info.frames,
    bytes: buffer.length,
    durationMs: info.durationMs,
    bitrate: info.bitrate,
    sampleRate: info.sampleRate,
    channels: info.channels,
    vbr: info.vbr
  }
}

/** Full frame table — used by tooling and tests, not on the hot path. */
export function scanFrames(buffer, { skipVbrHeader = true } = {}) {
  if (native) return native.scanFrames(buffer, skipVbrHeader).map(normaliseFrame)

  const frames = []
  let offset = id3v2Size(buffer)
  let first = true
  while (offset + 4 <= buffer.length) {
    const header = parseFrameHeader(buffer, offset)
    if (!header) {
      const next = buffer.indexOf(0xff, offset + 1)
      if (next === -1) break
      offset = next
      continue
    }
    if (offset + header.length > buffer.length) break
    if (first && skipVbrHeader && isXingFrame(buffer.subarray(offset, offset + header.length))) {
      offset += header.length
      first = false
      continue
    }
    first = false
    frames.push({ ...header, offset })
    offset += header.length
  }
  return frames
}

function normaliseFrame(frame) {
  return { ...normaliseInfo(frame), offset: frame.offset }
}

/**
 * Decode MP3 bytes to float channels.
 *
 * Native decoding happens on libuv's thread pool, so a seam decode never
 * stalls the pacer — the single biggest reason to have libmetro at all.
 * Returns null when nothing can decode the buffer; automix treats that as
 * "pass the audio through untouched".
 */
export async function decodeMp3(buffer) {
  if (native) {
    try {
      const pcm = await native.decodeAsync(buffer)
      if (!pcm?.length) return null
      return { left: pcm.left, right: pcm.right, sampleRate: pcm.sampleRate, length: pcm.length }
    } catch (error) {
      log.warn(`native decode failed (${error.message}); falling back`)
    }
  }
  return decodeWithWasm(buffer)
}

/**
 * Decode whole frames and get back exactly `expected` samples.
 *
 * A seam is placed on the frame grid, so "sample 0" has to mean "the first
 * sample of the first frame". Decoders do not all promise that: symphonia
 * drops frames it cannot decode (a shine-encoded run of digital silence, a
 * frame whose bit reservoir was cut away) and the output is simply shorter.
 * mpg123 emits every frame, so it is the fallback when the count is off; if
 * it is off there too, the audio is aligned to the *end* (the part a seam
 * actually blends) and the front is padded.
 *
 * @returns {Promise<{left: Float32Array, right: Float32Array, sampleRate: number, length: number, exact: boolean}|null>}
 */
export async function decodeExact(buffer, expected) {
  let pcm = await decodeMp3(buffer)
  if (pcm && pcm.length === expected) return { ...pcm, exact: true }
  if (native) {
    const second = await decodeWithWasm(buffer).catch(() => null)
    if (second && second.length === expected) return { ...second, exact: true }
    pcm = pcm ?? second
  }
  if (!pcm) return null
  const left = new Float32Array(expected)
  const right = new Float32Array(expected)
  const n = Math.min(expected, pcm.length)
  left.set(pcm.left.subarray(pcm.length - n, pcm.length), expected - n)
  right.set(pcm.right.subarray(pcm.length - n, pcm.length), expected - n)
  return { left, right, sampleRate: pcm.sampleRate, length: expected, exact: false }
}

let wasmModule // lazily imported, optional dependency

async function decodeWithWasm(buffer) {
  if (wasmModule === undefined) {
    try {
      wasmModule = await import('mpg123-decoder')
    } catch (error) {
      log.warn(`no mp3 decoder available (${error.message}); automix runs in pass-through mode`)
      wasmModule = null
    }
  }
  if (!wasmModule) return null

  const decoder = new wasmModule.MPEGDecoder()
  await decoder.ready
  try {
    const out = decoder.decode(new Uint8Array(buffer))
    if (!out || !out.samplesDecoded) return null
    return {
      left: out.channelData[0],
      right: out.channelData[1] ?? out.channelData[0],
      sampleRate: out.sampleRate,
      length: out.samplesDecoded
    }
  } finally {
    decoder.free()
  }
}

/* ------------------------------------------------------------------ *
 * Transcoding — anything → MP3
 * ------------------------------------------------------------------ */

/** What is this audio? `mp3` · `aac` · `mpeg-ts` · `ogg` · `flac` · … */
export function sniff(buffer) {
  if (native) return native.sniff(buffer)
  // The fallback can only recognise what it can also play.
  const tag = id3v2Size(buffer)
  const body = tag < buffer.length ? buffer.subarray(tag) : buffer
  if (body.length >= 4 && body.toString('latin1', 0, 4) === 'OggS') return 'ogg'
  if (body.length >= 4 && body.toString('latin1', 0, 4) === 'fLaC') return 'flac'
  if (body.length >= 12 && body.toString('latin1', 4, 8) === 'ftyp') return 'mp4'
  if (body[0] === 0x47 && body[188] === 0x47) return 'mpeg-ts'
  for (let at = 0; at + 4 < Math.min(body.length, 8192); at += 1) {
    if (body[at] !== 0xff) continue
    // ADTS has layer bits 00; an MP3 frame never does.
    if ((body[at + 1] & 0xf0) === 0xf0 && (body[at + 1] & 0x06) === 0) return 'aac'
    if (parseFrameHeader(body, at)) return 'mp3'
  }
  return 'unknown'
}

/**
 * Streaming transcoder: any supported audio in, MP3 frames out.
 *
 * This is what makes a relay from a plugin work when the feed is not MP3 —
 * an AAC Icecast stream, an HLS transport segment, Ogg/Vorbis, FLAC, an MP4
 * chunk. MP3 input is *not* re-encoded: it is detected and forwarded byte
 * for byte, so the common case stays free.
 *
 * Without a native binary only MP3 passes through; anything else raises a
 * clear error rather than silently airing nothing, because there is no
 * pure-JavaScript AAC decoder in this project's dependency list.
 */
export class MetroTranscoder {
  #native = null
  #framer = null
  #kind = 'unknown'
  #seen = 0
  #bitrate

  constructor({ bitrate = 128 } = {}) {
    this.#bitrate = bitrate
    if (native) this.#native = new native.Transcoder(bitrate)
    else this.#framer = new MetroFramer()
  }

  /** @returns {Buffer} MP3 bytes (possibly empty while buffering) */
  push(chunk) {
    if (this.#native) {
      const out = this.#native.push(chunk)
      this.#kind = this.#native.kind
      return out
    }

    // JavaScript fallback: MP3 only.
    this.#seen += chunk.length
    if (this.#kind === 'unknown') {
      const guess = sniff(chunk)
      if (guess !== 'unknown') this.#kind = guess
      if (this.#kind !== 'unknown' && this.#kind !== 'mp3') {
        throw new Error(`${this.#kind} needs the libmetro native engine to be transcoded to mp3`)
      }
      // Say so rather than airing nothing: after a few kilobytes of
      // something we cannot recognise, this relay is never going to work.
      if (this.#kind === 'unknown' && this.#seen >= 4096) {
        throw new Error('unrecognised audio: not mp3 (and this build has no native decoder)')
      }
    }
    const { frames } = this.#framer.push(chunk)
    return frames.length ? Buffer.concat(frames) : EMPTY
  }

  /** End of stream: decode anything held whole and flush the encoder. */
  flush() {
    if (this.#native) return this.#native.flush()
    const { blocks } = this.#framer.flush()
    return blocks.length ? Buffer.concat(blocks.map((block) => block.data)) : EMPTY
  }

  /** What the input turned out to be. */
  get kind() {
    return this.#native ? this.#native.kind : this.#kind
  }

  /** True when the feed is already MP3 and nothing is being re-encoded. */
  get passthrough() {
    return this.#native ? this.#native.passthrough : true
  }

  stats() {
    if (this.#native) return { engine: 'native', ...this.#native.stats() }
    const stats = this.#framer.stats()
    return {
      engine: 'javascript',
      kind: this.#kind,
      bytesIn: stats.bytes,
      bytesOut: stats.bytes,
      framesIn: stats.frames,
      durationMs: stats.durationMs,
      sampleRate: stats.sampleRate,
      channels: stats.channels,
      bitrate: 0,
      passthrough: true
    }
  }
}

/** One-shot: a whole file or HLS segment in, MP3 out. */
export async function transcodeToMp3(buffer, { bitrate = 128 } = {}) {
  if (native) return native.transcodeAsync(buffer, bitrate)
  if (sniff(buffer) === 'mp3') return buffer
  throw new Error('transcoding needs the libmetro native engine')
}

/**
 * Encode float channels to MP3 — the automix's output stage.
 *
 * Native shine is roughly five times quicker than the JavaScript encoder,
 * and every crossfade in the node goes through here.
 */
export async function encodeMp3({ left, right, sampleRate, bitrate = 128 }) {
  if (native) {
    try {
      return native.encodeMp3(
        left instanceof Float32Array ? left : Float32Array.from(left),
        right instanceof Float32Array ? right : Float32Array.from(right),
        sampleRate,
        bitrate
      )
    } catch (error) {
      log.warn(`native encoder failed (${error.message}); falling back to lamejs`)
    }
  }
  return encodeWithLame({ left, right, sampleRate, bitrate })
}

async function encodeWithLame({ left, right, sampleRate, bitrate }) {
  const { Mp3Encoder } = await import('@breezystack/lamejs')
  const encoder = new Mp3Encoder(2, sampleRate, bitrate)
  const block = 1152
  const chunks = []
  const l = new Int16Array(block)
  const r = new Int16Array(block)

  for (let offset = 0; offset < left.length; offset += block) {
    const n = Math.min(block, left.length - offset)
    for (let i = 0; i < n; i += 1) {
      l[i] = clamp(left[offset + i] ?? 0, -1, 1) * 32767
      r[i] = clamp(right[offset + i] ?? left[offset + i] ?? 0, -1, 1) * 32767
    }
    const encoded = n === block ? encoder.encodeBuffer(l, r) : encoder.encodeBuffer(l.subarray(0, n), r.subarray(0, n))
    if (encoded.length > 0) chunks.push(Buffer.from(encoded))
    // Let the pacer breathe: a long seam must not block the event loop.
    if ((offset / block) % 20 === 19) await new Promise((resolve) => setImmediate(resolve))
  }

  const tail = encoder.flush()
  if (tail.length > 0) chunks.push(Buffer.from(tail))
  return Buffer.concat(chunks)
}

const clamp = (value, low, high) => (value < low ? low : value > high ? high : value)

/* ------------------------------------------------------------------ *
 * Smart Automix — the DSP behind long crossfades
 * ------------------------------------------------------------------ */

/**
 * Tempo, grid and confidence for a mono buffer.
 *
 * Native when libmetro is there (about 13x faster, and on the thread pool
 * so the pacer keeps ticking), the JavaScript reference implementation when
 * it is not. Both return the same shape and agree on real music.
 */
export async function analyseBeat(mono, sampleRate) {
  if (native?.analyseBeatAsync) {
    const beat = await native.analyseBeatAsync(mono, sampleRate)
    return beat ?? null
  }
  const { estimateBeat } = await import('../core/dsp.js')
  return estimateBeat(mono, sampleRate)
}

/**
 * WSOLA time stretch — change the tempo, leave the pitch alone.
 *
 * @param {Float32Array[]} channels [left, right]
 * @returns {Promise<{channels: Float32Array[], length: number}>}
 */
export async function stretchAudio(channels, sampleRate, { stretch = 1, rampSamples = 0, length = null } = {}) {
  const [left, right = left] = channels

  if (native?.timeStretchAsync && Math.abs(stretch - 1) > 1e-6) {
    const out = await native.timeStretchAsync(left, right, sampleRate, stretch, rampSamples, length ?? undefined)
    // The time map is pure arithmetic and the caller needs it to find where
    // a beat *landed*; it is the same map the native side used.
    const { stretchMap } = await import('../core/dsp.js')
    return { channels: [out.left, out.right], length: out.length, map: stretchMap(stretch, rampSamples), engine: 'native' }
  }

  const { timeStretch } = await import('../core/dsp.js')
  const out = timeStretch([left, right], sampleRate, { stretch, rampSamples, length })
  return { ...out, engine: 'javascript' }
}

/**
 * The jukebox's all-pairs kernel, when the loaded binary was built with one
 * (`native/libmetro/src/jukebox.rs`). `null` otherwise: `seams/jukebox.ts` then uses its own, which is
 * the reference the native one is checked against.
 */
export function jukeboxKernel() {
  if (typeof native?.jukeboxNeighbours !== 'function') return null
  return (vectors, width, bars, limit) => native.jukeboxNeighbours(vectors, width, bars, limit)
}

/** One line for the boot banner and the owner console. */
export function engineInfo() {
  return {
    engine: native ? 'MetroS' : 'MetroS (javascript)',
    native: Boolean(native),
    version: native ? native.version() : null,
    describe: native ? native.describe() : 'MetroS · javascript fallback',
    decoder: native ? 'libmetro (rust)' : 'mpg123 (wasm)',
    encoder: native ? 'shine (rust)' : 'lamejs',
    // The automix's two expensive stages, and where they run.
    dsp: native?.analyseBeatAsync ? 'libmetro (rust, off the event loop)' : 'javascript',
    // What a relay may arrive as and still end up on air.
    codecs: native
      ? ['mp3', 'aac', 'mpeg-ts/hls', 'mp4/m4a', 'ogg', 'vorbis', 'flac', 'alac', 'wav', 'aiff', 'matroska']
      : ['mp3']
  }
}

export { buildSilence, id3v2Size, isXingFrame, parseFrameHeader }

export default {
  MetroFramer,
  MetroTranscoder,
  probeMp3,
  scanFrames,
  decodeMp3,
  encodeMp3,
  transcodeToMp3,
  sniff,
  engineInfo,
  buildSilence
}
