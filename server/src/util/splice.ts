/**
 * Splicing MP3 without a click.
 *
 * A station that renders a seam has to put freshly encoded frames between
 * frames it never touched. Three things make that harder than concatenation,
 * and each of them is audible when ignored:
 *
 *   1. **Codec delay.** Audio handed to an encoder comes out of a decoder
 *      ~1100 samples late (576 of encoder look-ahead plus the 528+1 of the
 *      decoder's filterbank for LAME; shine and symphonia differ by a few
 *      dozen). Splice an encode in as-is and there is a 25 ms hole in front
 *      of it and 25 ms of repeated audio behind it.
 *   2. **The MDCT overlaps.** Every granule is windowed across its neighbour,
 *      so the first frame of a fresh encoder fades in from nothing and the
 *      last one fades out to nothing. The fix is the one a gapless encoder
 *      uses: encode more than is needed on both sides and throw the edges
 *      away, so the frames that are kept were encoded with real neighbours.
 *   3. **The bit reservoir.** A Layer III frame may keep its audio in the
 *      *previous* frames (`main_data_begin`, up to 511 bytes back). Remove
 *      those frames and the decoder reads whatever is there instead — the
 *      next song's first frame after a seam is decoded from the seam's bytes.
 *
 * (1) and (2) are handled by `bridge()`; (3) by re-muxing: frames are turned
 * into *logical* frames (header + side info + their own main data, wherever
 * it lived), and written back out so that the first frame depends on nothing
 * before it and the last one leaves exactly the bytes the following original
 * frame expects to find behind it. This is what pcutmp3 and mp3packer do on
 * files; here it happens on a few frames at each seam, in memory.
 *
 * References: ISO/IEC 11172-3 §2.4.1.7 (side information), the LAME technical
 * FAQ (encoder/decoder delay), "Gapless looping MP3 tracks" (CompuPhase).
 */
import { parseFrameHeader } from './mp3.ts'

export interface Layer3Frame {
  /** MPEG-1 (false) or MPEG-2/2.5 "low sampling frequency" (true). */
  lsf: boolean
  mono: boolean
  sampleRate: number
  samples: number
  /** Offset of the side information inside the frame (4, or 6 with a CRC). */
  sideOffset: number
  sideSize: number
  /** `main_data_begin`: how many bytes before this header the audio starts. */
  mainDataBegin: number
  /** Bytes of main data this frame owns (granules × channels, rounded up). */
  mainBytes: number
  /** The frame's own data area: everything after the side information. */
  area: Buffer
}

export interface LogicalFrame {
  /** Four header bytes with the CRC switched off (it is not rewritten). */
  header: Buffer
  side: Buffer
  main: Buffer
  lsf: boolean
  mono: boolean
  sampleRate: number
  samples: number
  /** False when the frame's audio lived in bytes that were not supplied. */
  complete: boolean
}

const MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]

/** Read `count` bits starting at bit `at` of `bytes`. */
function bits(bytes: Uint8Array, at: number, count: number): number {
  let value = 0
  for (let i = 0; i < count; i += 1) {
    const bit = at + i
    value = (value << 1) | ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1)
  }
  return value
}

/** Parse one Layer III frame far enough to know where its audio is. */
export function parseLayer3(frame: Buffer): Layer3Frame | null {
  const header = frame && frame.length >= 4 ? parseFrameHeader(frame, 0) : null
  if (!frame || frame.length < 4) return null
  if (!header || header.layer !== 3 || frame.length < header.length) return null
  const lsf = header.version !== 1
  const mono = header.channels === 1
  const protectedByCrc = (frame[1] & 1) === 0
  const sideOffset = protectedByCrc ? 6 : 4
  const sideSize = lsf ? (mono ? 9 : 17) : mono ? 17 : 32
  if (frame.length < sideOffset + sideSize) return null
  const side = frame.subarray(sideOffset, sideOffset + sideSize)

  // Where part2_3_length sits for each granule/channel (ISO 11172-3 2.4.1.7,
  // and 13818-3 for the single-granule low-rate layout).
  let mainDataBegin: number
  let total = 0
  if (!lsf) {
    mainDataBegin = bits(side, 0, 9)
    const first = mono ? 18 : 20
    const count = mono ? 2 : 4
    for (let i = 0; i < count; i += 1) total += bits(side, first + i * 59, 12)
  } else {
    mainDataBegin = bits(side, 0, 8)
    const first = mono ? 9 : 10
    const count = mono ? 1 : 2
    for (let i = 0; i < count; i += 1) total += bits(side, first + i * 63, 12)
  }

  return {
    lsf,
    mono,
    sampleRate: header.sampleRate,
    samples: header.samples,
    sideOffset,
    sideSize,
    mainDataBegin,
    mainBytes: (total + 7) >> 3,
    area: frame.subarray(sideOffset + sideSize, header.length)
  }
}

/**
 * Physical frames → logical frames.
 *
 * The data areas are a single byte stream that the headers interrupt; each
 * frame's audio is `mainBytes` of that stream starting `main_data_begin`
 * bytes before its own area. A frame whose audio starts before the first
 * area supplied is returned with `complete: false` — it can be carried, but
 * not decoded, exactly as a decoder joining mid-stream would find it.
 */
export function toLogical(frames: Buffer[]): LogicalFrame[] {
  const out: LogicalFrame[] = []
  let stream = Buffer.alloc(0)
  for (const frame of frames) {
    const info = parseLayer3(frame)
    if (!info) continue
    const before = stream.length
    stream = Buffer.concat([stream, info.area])
    const start = before - info.mainDataBegin
    const end = start + info.mainBytes
    const complete = start >= 0 && end <= stream.length
    const header = Buffer.from(frame.subarray(0, 4))
    header[1] |= 1 // no CRC in what we write
    out.push({
      header,
      side: Buffer.from(frame.subarray(info.sideOffset, info.sideOffset + info.sideSize)),
      main: complete ? Buffer.from(stream.subarray(start, end)) : Buffer.alloc(0),
      lsf: info.lsf,
      mono: info.mono,
      sampleRate: info.sampleRate,
      samples: info.samples,
      complete
    })
    // 511 bytes is as far back as any frame can reach; keep a little more.
    if (stream.length > 8192) stream = stream.subarray(stream.length - 2048)
  }
  return out
}

/**
 * The bytes `frames[index]` expects to find immediately behind it — the start
 * of its own audio, parked in earlier frames. Empty when it is self-contained.
 * `null` when the earlier frames supplied do not reach far enough back.
 */
export function reservoirBefore(frames: Buffer[], index: number): Buffer | null {
  const target = parseLayer3(frames[index])
  if (!target) return null
  if (target.mainDataBegin === 0) return Buffer.alloc(0)
  const parts: Buffer[] = []
  let have = 0
  for (let i = index - 1; i >= 0 && have < target.mainDataBegin; i -= 1) {
    const info = parseLayer3(frames[i])
    if (!info) break
    parts.unshift(info.area)
    have += info.area.length
  }
  if (have < target.mainDataBegin) return null
  const joined = Buffer.concat(parts)
  return Buffer.from(joined.subarray(joined.length - target.mainDataBegin))
}

interface Slot {
  buffer: Buffer
  offset: number
  length: number
}

/** Every legal frame size for this stream, smallest first. */
function frameSizes(frame: LogicalFrame): { size: number; index: number; padding: number }[] {
  const table = frame.lsf ? MPEG2_L3 : MPEG1_L3
  const factor = frame.lsf ? 72_000 : 144_000
  const sizes = []
  for (let index = 1; index < table.length; index += 1) {
    const base = Math.floor((factor * table[index]) / frame.sampleRate)
    sizes.push({ size: base, index, padding: 0 }, { size: base + 1, index, padding: 1 })
  }
  return sizes.sort((a, b) => a.size - b.size)
}

/**
 * Logical frames → physical frames that depend on nothing before them.
 *
 * Greedy and forward, the way mp3packer does it: a frame's audio starts as
 * far back as the free bytes behind it allow, and the frame itself is the
 * smallest legal size that holds the rest. Sizes are therefore mostly the
 * stream's own bitrate with the occasional larger frame — a few frames of
 * VBR at a seam, which every decoder accepts.
 *
 * `tail` is the reservoir the frame *after* this run needs (see
 * `reservoirBefore`); it is written into the last bytes of the run.
 *
 * @param preferredBitrate the smallest bitrate (kbps) to use, so a 128 kbps
 *   station does not get a burst of 32 kbps-sized frames for a quiet seam.
 */
export function remux(frames: LogicalFrame[], { tail = Buffer.alloc(0), preferredBitrate = 0 }: { tail?: Buffer; preferredBitrate?: number } = {}): Buffer[] {
  const out: Buffer[] = []
  let free: Slot[] = []
  const freeBytes = () => free.reduce((sum, slot) => sum + slot.length, 0)

  frames.forEach((frame, position) => {
    const last = position === frames.length - 1
    const maxBack = frame.lsf ? 255 : 511
    const table = frame.lsf ? MPEG2_L3 : MPEG1_L3
    const available = freeBytes()
    const back = Math.min(available, maxBack)
    const overhead = 4 + frame.side.length
    const need = Math.max(0, frame.main.length - back)
    // What must still be free once this frame is written.
    const wantFree = last ? tail.length : 0
    const sizes = frameSizes(frame)
    const fits = (candidate: { size: number; index: number }) => {
      if (table[candidate.index] < preferredBitrate) return false
      const area = candidate.size - overhead
      if (area < need) return false
      const leftover = frame.main.length <= back ? back - frame.main.length + area : area - need
      return leftover >= wantFree
    }
    const chosen = sizes.find(fits) ?? sizes.find((candidate) => candidate.size - overhead >= need) ?? sizes[sizes.length - 1]

    const physical = Buffer.alloc(chosen.size)
    frame.header.copy(physical, 0)
    physical[2] = (physical[2] & 0x0d) | (chosen.index << 4) | (chosen.padding << 1)
    frame.side.copy(physical, 4)
    // main_data_begin is the first 9 (MPEG-1) or 8 (LSF) bits of the side info.
    if (frame.lsf) physical[4] = back
    else {
      physical[4] = back >> 1
      physical[5] = (physical[5] & 0x7f) | ((back & 1) << 7)
    }

    // Bytes further back than `main_data_begin` can reach are dead space.
    let skip = available - back
    while (skip > 0 && free.length) {
      const slot = free[0]
      const take = Math.min(skip, slot.length)
      slot.offset += take
      slot.length -= take
      skip -= take
      if (slot.length === 0) free.shift()
    }
    free.push({ buffer: physical, offset: overhead, length: chosen.size - overhead })

    let written = 0
    while (written < frame.main.length && free.length) {
      const slot = free[0]
      const take = Math.min(frame.main.length - written, slot.length)
      frame.main.copy(slot.buffer, slot.offset, written, written + take)
      slot.offset += take
      slot.length -= take
      written += take
      if (slot.length === 0) free.shift()
    }
    out.push(physical)
  })

  if (tail.length) {
    // The reservoir goes in the *last* bytes: that is where the next header
    // will look for it.
    let remaining = tail.length
    for (let i = free.length - 1; i >= 0 && remaining > 0; i -= 1) {
      const slot = free[i]
      const take = Math.min(remaining, slot.length)
      tail.copy(slot.buffer, slot.offset + slot.length - take, remaining - take, remaining)
      remaining -= take
    }
  }
  return out
}

/** Samples per frame of a physical frame (1152 for MPEG-1, 576 for LSF). */
export function samplesPerFrame(frame: Buffer): number {
  return parseFrameHeader(frame, 0)?.samples ?? 1152
}

/* ------------------------------------------------------------------ *
 * Codec delay
 * ------------------------------------------------------------------ */

export interface Codec {
  encode(pcm: { left: Float32Array; right: Float32Array; sampleRate: number; bitrate: number }): Promise<Buffer>
  decode(buffer: Buffer): Promise<{ left: Float32Array; right: Float32Array; sampleRate: number; length: number } | null>
  /** Split a buffer into frames, dropping any Xing/Info header. */
  frames(buffer: Buffer): Buffer[]
}

const delays = new Map<string, Promise<number>>()

/**
 * How late does audio come out of encode → decode, in samples?
 *
 * Measured, not assumed: lamejs through mpg123 is 1105, shine through
 * symphonia is 1057, and a build with a different encoder would be something
 * else. Band-limited noise is encoded and decoded, and the lag that maximises
 * the cross-correlation is the answer. Cached per sample rate and bitrate —
 * it costs ~30 ms once.
 */
export function codecDelay(codec: Codec, sampleRate: number, bitrate = 128, key = 'default'): Promise<number> {
  const id = `${key}:${sampleRate}:${bitrate}`
  let pending = delays.get(id)
  if (!pending) {
    pending = measureDelay(codec, sampleRate, bitrate).catch(() => 1105)
    delays.set(id, pending)
  }
  return pending
}

async function measureDelay(codec: Codec, sampleRate: number, bitrate: number): Promise<number> {
  const length = Math.round(sampleRate * 0.75)
  const signal = new Float32Array(length)
  let seed = 0x1234567
  let low = 0
  for (let i = 0; i < length; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    low += 0.15 * (seed / 2 ** 32 - 0.5 - low)
    signal[i] = low * 2.5 * (0.6 + 0.4 * Math.sin(i / 3000))
  }
  const encoded = await codec.encode({ left: signal, right: signal, sampleRate, bitrate })
  const decoded = await codec.decode(Buffer.concat(codec.frames(encoded)))
  if (!decoded) return 1105
  const from = Math.round(length * 0.3)
  const span = Math.round(length * 0.4)
  let best = -Infinity
  let lag = 1105
  for (let candidate = 0; candidate <= 2400; candidate += 1) {
    let sum = 0
    for (let i = from; i < from + span; i += 2) sum += signal[i] * (decoded.left[i + candidate] ?? 0)
    if (sum > best) {
      best = sum
      lag = candidate
    }
  }
  return lag
}

/* ------------------------------------------------------------------ *
 * The bridge
 * ------------------------------------------------------------------ */

/** Frames of original audio left untouched in front of a bridge. */
export const LEAD_FRAMES = 2
/** Frames encoded past the end of a bridge and thrown away (MDCT overlap). */
const TRAIL_FRAMES = 2

export interface BridgeInput {
  /**
   * What the listener should hear, starting at the first sample of the first
   * lead frame. The first `LEAD_FRAMES + 1` frames of it must be the original
   * audio, unmodified: the lead frames go out as the originals, and the frame
   * after them is where the two encodings overlap.
   */
  left: Float32Array
  right: Float32Array
  sampleRate: number
  bitrate: number
  /**
   * Audio that follows the bridge (the start of the frame that will air
   * next). Never aired from here; it gives the encoder real audio to overlap
   * the last kept frame with.
   */
  after?: { left: Float32Array; right: Float32Array } | null
  /** Reservoir the next original frame needs (see `reservoirBefore`). */
  tail?: Buffer | null
}

/**
 * Encode `left/right` so it can be dropped between original frames.
 *
 * Returns the frames that replace everything from the *end of the lead
 * frames* to the end of the supplied audio, which must be a whole number of
 * frames long. Nothing else about the stream has to change.
 */
export async function bridge(codec: Codec, input: BridgeInput, key = 'default'): Promise<Buffer[]> {
  const { left, right, sampleRate, bitrate } = input
  const spf = sampleRate >= 32_000 ? 1152 : 576
  const frames = Math.floor(left.length / spf)
  if (frames <= LEAD_FRAMES) return []
  const delay = await codecDelay(codec, sampleRate, bitrate, key)

  // Audio given to the encoder at sample s is heard at s + delay, so the
  // encoder is fed the programme `delay` samples early; the hole that leaves
  // at the front lands inside the lead frames, which are not used.
  const total = frames * spf
  const feed = total - delay + TRAIL_FRAMES * spf + delay
  const l = new Float32Array(feed)
  const r = new Float32Array(feed)
  l.set(left.subarray(delay, total))
  r.set(right.subarray(delay, total))
  const copied = total - delay
  if (input.after) {
    const more = Math.min(feed - copied, input.after.left.length)
    l.set(input.after.left.subarray(0, more), copied)
    r.set(input.after.right.subarray(0, more), copied)
  }

  const encoded = codec.frames(await codec.encode({ left: l, right: r, sampleRate, bitrate }))
  if (encoded.length < frames) return []
  // Logical frames are taken over the whole encode so the kept ones find
  // their reservoir, then only the kept ones are written back out.
  const logical = toLogical(encoded).slice(LEAD_FRAMES, frames)
  if (logical.length !== frames - LEAD_FRAMES || logical.some((frame) => !frame.complete)) return []
  return remux(logical, { tail: input.tail ?? Buffer.alloc(0), preferredBitrate: bitrate })
}

export default bridge
