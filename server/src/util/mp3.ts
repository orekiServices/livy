/**
 * MPEG audio (MP3) frame tooling — the heart of the "no ffmpeg" design.
 *
 * Every station streams MP3 bytes straight through: we only need to know where
 * frame boundaries are and how long each frame lasts, so the broadcaster can
 * pace output at exactly real time and cut cleanly between tracks. Parsing a
 * 4-byte header per ~26 ms of audio costs microseconds, so a station runs at
 * ~0% CPU no matter how many listeners it has.
 */

// bitrate tables in kbps, index 0 = free, 15 = bad
const BITRATES = {
  // MPEG 1
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  // MPEG 2 / 2.5
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
}

const SAMPLE_RATES = {
  1: [44100, 48000, 32000, 0], // MPEG 1
  2: [22050, 24000, 16000, 0], // MPEG 2
  2.5: [11025, 12000, 8000, 0]
}

const SAMPLES_PER_FRAME = {
  '1-1': 384,
  '1-2': 1152,
  '1-3': 1152,
  '2-1': 384,
  '2-2': 1152,
  '2-3': 576
}

/**
 * Parse a frame header at `offset`. Returns null when it isn't a valid frame.
 * @returns {{length:number, durationMs:number, bitrate:number, sampleRate:number, channels:number, version:number|string, layer:number}|null}
 */
export function parseFrameHeader(buf, offset = 0) {
  if (offset + 4 > buf.length) return null
  if (buf[offset] !== 0xff || (buf[offset + 1] & 0xe0) !== 0xe0) return null

  const b1 = buf[offset + 1]
  const b2 = buf[offset + 2]
  const b3 = buf[offset + 3]

  const versionBits = (b1 >> 3) & 0b11
  const layerBits = (b1 >> 1) & 0b11
  if (versionBits === 1 || layerBits === 0) return null // reserved

  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5
  const layer = 4 - layerBits // 1, 2, 3
  const tableKey = `${version === 1 ? 1 : 2}-${layer}`

  const bitrate = BITRATES[tableKey][(b2 >> 4) & 0b1111]
  const sampleRate = SAMPLE_RATES[version][(b2 >> 2) & 0b11]
  if (!bitrate || !sampleRate) return null

  const padding = (b2 >> 1) & 1
  const channelMode = (b3 >> 6) & 0b11
  const samples = SAMPLES_PER_FRAME[tableKey]

  const length =
    layer === 1
      ? (Math.floor((12 * bitrate * 1000) / sampleRate) + padding) * 4
      : Math.floor((samples / 8) * ((bitrate * 1000) / sampleRate)) + padding

  if (length < 24 || length > 8192) return null

  return {
    length,
    durationMs: (samples / sampleRate) * 1000,
    bitrate,
    sampleRate,
    channels: channelMode === 3 ? 1 : 2,
    version,
    layer,
    samples
  }
}

/** Size of an ID3v2 tag at the start of `buf`, or 0. */
export function id3v2Size(buf) {
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f)
  const footer = (buf[5] & 0x10) !== 0 ? 10 : 0
  return 10 + size + footer
}

/** Xing/Info/VBRI frames carry no audio — they must not be broadcast. */
export function isXingFrame(frame) {
  const head = frame.subarray(0, Math.min(frame.length, 200)).toString('latin1')
  return head.includes('Xing') || head.includes('Info') || head.includes('VBRI')
}

/**
 * Incremental MP3 splitter: feed arbitrary byte chunks, get whole frames back.
 * Resynchronises automatically (ID3 tags, garbage, mid-stream joins).
 */
export class Mp3FrameSplitter {
  #buffer = Buffer.alloc(0)
  #skip = 0
  #started = false

  /**
   * @param {Buffer} chunk
   * @returns {{frames: Buffer[], durationMs: number, info: object|null}}
   */
  push(chunk) {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, input]) : input

    if (this.#skip > 0) {
      const drop = Math.min(this.#skip, this.#buffer.length)
      this.#buffer = this.#buffer.subarray(drop)
      this.#skip -= drop
    }

    if (!this.#started) {
      const tag = id3v2Size(this.#buffer)
      if (tag > 0) {
        this.#skip = Math.max(0, tag - this.#buffer.length)
        this.#buffer = this.#buffer.subarray(Math.min(tag, this.#buffer.length))
      }
      if (this.#buffer.length >= 10) this.#started = true
    }

    const frames = []
    let durationMs = 0
    let info = null
    let offset = 0

    while (offset + 4 <= this.#buffer.length) {
      const header = parseFrameHeader(this.#buffer, offset)

      if (!header) {
        // resync: hunt for the next 0xFF Ex
        const next = this.#buffer.indexOf(0xff, offset + 1)
        if (next === -1) {
          offset = this.#buffer.length
          break
        }
        offset = next
        continue
      }

      if (offset + header.length > this.#buffer.length) break // frame not complete yet

      const frame = this.#buffer.subarray(offset, offset + header.length)
      offset += header.length

      if (frames.length === 0 && isXingFrame(frame)) continue // drop VBR header frame

      frames.push(frame)
      durationMs += header.durationMs
      info ??= header
    }

    this.#buffer = this.#buffer.subarray(offset)
    return { frames, durationMs, info }
  }

  /** Bytes still buffered (incomplete frame). */
  get pending() {
    return this.#buffer.length
  }

  reset() {
    this.#buffer = Buffer.alloc(0)
    this.#skip = 0
    this.#started = false
  }
}

/** Measure an in-memory MP3 (used by tests and local files). */
export function probeMp3(buffer) {
  const splitter = new Mp3FrameSplitter()
  const { frames, durationMs, info } = splitter.push(buffer)
  return { ...(info ?? {}), frames: frames.length, durationMs, bytes: buffer.length }
}

/** Build a silent-ish MP3 frame set — used as a bed while a track is loading. */
export function buildSilence(ms, { bitrate = 128, sampleRate = 44100 }: any = {}) {
  const frameMs = (1152 / sampleRate) * 1000
  const length = Math.floor((1152 / 8) * ((bitrate * 1000) / sampleRate))
  const count = Math.ceil(ms / frameMs)
  const frames = []
  for (let i = 0; i < count; i += 1) {
    const frame = Buffer.alloc(length)
    frame[0] = 0xff
    frame[1] = 0xfb // MPEG1 Layer III, no CRC
    frame[2] = 0x90 // 128 kbps, 44.1 kHz, no padding
    frame[3] = 0x64 // joint stereo, no emphasis (matches typical music streams)
    frames.push(frame)
  }
  return { frames, durationMs: count * frameMs }
}

export default { parseFrameHeader, Mp3FrameSplitter, probeMp3, id3v2Size, buildSilence }
