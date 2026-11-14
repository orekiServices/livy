/**
 * Streaming audio features — what the seam detectors, the jukebox and the RL
 * model all look at.
 *
 * One pass over the song as it is read: mono, decimated to ~22 kHz, a
 * 1024-point Hann FFT every 256 samples (86 frames a second, 11.6 ms). Each
 * frame yields
 *
 *   onset    spectral flux over 24 mel bands (log-compressed, half-wave
 *            rectified) — the envelope the beat tracker follows
 *   lowFlux  the same for the bands under ~200 Hz: where the kick is, which
 *            is how the bar's "one" is found
 *   level    frame energy in dB
 *   low/mid/high/vocal   shares of the energy by band
 *   timbre   12 DCT coefficients of the log-mel spectrum (an MFCC without
 *            the lifter) — the stand-in for The Echo Nest's timbre vector
 *   chroma   12 pitch classes, 65 Hz–2.1 kHz — the stand-in for `pitches`
 *
 * Nothing here needs the whole song: `push()` takes PCM as it arrives and the
 * arrays grow. A four minute song is ~20 000 frames and ~2.5 MB.
 */

export const FRAME = 1024
export const HOP = 256
export const MEL_BANDS = 24
export const TIMBRE = 12
export const CHROMA = 12

/** Growable Float32 storage, `width` values per row. */
export class Rows {
  width: number
  data: Float32Array
  length = 0
  constructor(width = 1, capacity = 4096) {
    this.width = width
    this.data = new Float32Array(capacity * width)
  }
  push(row: ArrayLike<number> | number) {
    if ((this.length + 1) * this.width > this.data.length) {
      const next = new Float32Array(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    if (typeof row === 'number') this.data[this.length] = row
    else this.data.set(row as ArrayLike<number>, this.length * this.width)
    this.length += 1
  }
  at(index: number): number {
    return this.data[index]
  }
  row(index: number): Float32Array {
    return this.data.subarray(index * this.width, (index + 1) * this.width)
  }
  view(): Float32Array {
    return this.data.subarray(0, this.length * this.width)
  }
}

/** In-place radix-2 FFT. */
export function fft(re: Float32Array, im: Float32Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1
    const step = (-2 * Math.PI) / size
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k += 1) {
        const wr = Math.cos(step * k)
        const wi = Math.sin(step * k)
        const a = start + k
        const b = a + half
        const xr = re[b] * wr - im[b] * wi
        const xi = re[b] * wi + im[b] * wr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
      }
    }
  }
}

const hz2mel = (hz: number) => 2595 * Math.log10(1 + hz / 700)
const mel2hz = (mel: number) => 700 * (10 ** (mel / 2595) - 1)

export class FeatureStream {
  /** Analysis rate after decimation. */
  readonly rate: number
  readonly fps: number
  readonly onset = new Rows()
  readonly lowFlux = new Rows()
  readonly level = new Rows()
  readonly low = new Rows()
  readonly high = new Rows()
  readonly vocal = new Rows()
  readonly timbre = new Rows(TIMBRE)
  readonly chroma = new Rows(CHROMA)

  #decimate: number
  #carry = 0 // partial decimation pair
  #carried = false
  #buffer = new Float32Array(FRAME * 4)
  #filled = 0
  #window = new Float32Array(FRAME)
  #re = new Float32Array(FRAME)
  #im = new Float32Array(FRAME)
  #power = new Float32Array(FRAME / 2 + 1)
  #mel: { from: number; weights: Float32Array }[] = []
  #previous = new Float32Array(MEL_BANDS)
  #current = new Float32Array(MEL_BANDS)
  #dct = new Float32Array(TIMBRE * MEL_BANDS)
  #chromaBin = new Int8Array(FRAME / 2 + 1)
  #lowBands = 0
  #bins: { low: number; vocalFrom: number; vocalTo: number; high: number }
  #timbreRow = new Float32Array(TIMBRE)
  #chromaRow = new Float32Array(CHROMA)

  readonly sampleRate: number
  constructor(sampleRate: number) {
    this.sampleRate = sampleRate
    this.#decimate = sampleRate >= 32_000 ? 2 : 1
    this.rate = sampleRate / this.#decimate
    this.fps = this.rate / HOP
    for (let i = 0; i < FRAME; i += 1) this.#window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1))

    const binHz = this.rate / FRAME
    const top = Math.min(this.rate / 2 - binHz, 10_000)
    const edges: number[] = []
    for (let i = 0; i < MEL_BANDS + 2; i += 1) edges.push(mel2hz(hz2mel(50) + ((hz2mel(top) - hz2mel(50)) * i) / (MEL_BANDS + 1)) / binHz)
    for (let band = 0; band < MEL_BANDS; band += 1) {
      const [lo, mid, hi] = [edges[band], edges[band + 1], edges[band + 2]]
      const from = Math.max(1, Math.floor(lo))
      const to = Math.min(FRAME / 2, Math.ceil(hi))
      const weights = new Float32Array(Math.max(1, to - from + 1))
      for (let bin = from; bin <= to; bin += 1) {
        const w = bin <= mid ? (bin - lo) / Math.max(1e-6, mid - lo) : (hi - bin) / Math.max(1e-6, hi - mid)
        weights[bin - from] = Math.max(0, w)
      }
      // A band narrower than one bin would otherwise weigh nothing.
      if (!weights.some((w) => w > 0)) weights[0] = 1
      this.#mel.push({ from, weights })
      if (mel2hz(hz2mel(50) + ((hz2mel(top) - hz2mel(50)) * (band + 1)) / (MEL_BANDS + 1)) < 200) this.#lowBands = band + 1
    }
    this.#lowBands = Math.max(2, this.#lowBands)

    for (let k = 0; k < TIMBRE; k += 1) {
      for (let band = 0; band < MEL_BANDS; band += 1) {
        const scale = k === 0 ? Math.sqrt(1 / MEL_BANDS) : Math.sqrt(2 / MEL_BANDS)
        this.#dct[k * MEL_BANDS + band] = scale * Math.cos((Math.PI * k * (band + 0.5)) / MEL_BANDS)
      }
    }

    for (let bin = 0; bin <= FRAME / 2; bin += 1) {
      const hz = bin * binHz
      this.#chromaBin[bin] = hz >= 65 && hz <= 2100 ? (((Math.round(12 * Math.log2(hz / 440)) % 12) + 12 + 9) % 12) : -1
    }
    this.#bins = {
      low: Math.round(180 / binHz),
      vocalFrom: Math.round(300 / binHz),
      vocalTo: Math.round(3400 / binHz),
      high: Math.round(4000 / binHz)
    }
  }

  /** Frames analysed so far. */
  get frames() {
    return this.onset.length
  }

  /** Seconds of audio a frame index corresponds to (the frame's centre). */
  timeOf(frame: number) {
    return (frame * HOP + FRAME / 2) / this.rate
  }

  /** The frame whose centre is nearest `seconds`. */
  frameAt(seconds: number) {
    return Math.max(0, Math.round((seconds * this.rate - FRAME / 2) / HOP))
  }

  /** Feed mono PCM at `sampleRate`. */
  push(mono: Float32Array) {
    let i = 0
    const n = mono.length
    while (i < n) {
      let sample: number
      if (this.#decimate === 2) {
        if (!this.#carried) {
          if (i + 1 < n) {
            sample = (mono[i] + mono[i + 1]) / 2
            i += 2
          } else {
            this.#carry = mono[i]
            this.#carried = true
            break
          }
        } else {
          sample = (this.#carry + mono[i]) / 2
          this.#carried = false
          i += 1
        }
      } else {
        sample = mono[i]
        i += 1
      }
      this.#buffer[this.#filled] = sample
      this.#filled += 1
      if (this.#filled === this.#buffer.length) this.#drain()
    }
    this.#drain()
  }

  #drain() {
    let at = 0
    while (this.#filled - at >= FRAME) {
      this.#analyse(this.#buffer.subarray(at, at + FRAME))
      at += HOP
    }
    if (at > 0) {
      this.#buffer.copyWithin(0, at, this.#filled)
      this.#filled -= at
    }
  }

  #analyse(frame: Float32Array) {
    const re = this.#re
    const im = this.#im
    let square = 0
    for (let i = 0; i < FRAME; i += 1) {
      const v = frame[i]
      square += v * v
      re[i] = v * this.#window[i]
      im[i] = 0
    }
    fft(re, im)

    const power = this.#power
    let total = 0
    let low = 0
    let vocal = 0
    let high = 0
    const chroma = this.#chromaRow.fill(0)
    for (let bin = 1; bin <= FRAME / 2; bin += 1) {
      const p = (re[bin] * re[bin] + im[bin] * im[bin]) / (FRAME * FRAME)
      power[bin] = p
      total += p
      if (bin < this.#bins.low) low += p
      if (bin >= this.#bins.vocalFrom && bin <= this.#bins.vocalTo) vocal += p
      if (bin >= this.#bins.high) high += p
      const pitch = this.#chromaBin[bin]
      if (pitch >= 0) chroma[pitch] += p
    }

    let flux = 0
    let lowFlux = 0
    const current = this.#current
    for (let band = 0; band < MEL_BANDS; band += 1) {
      const { from, weights } = this.#mel[band]
      let energy = 0
      for (let k = 0; k < weights.length; k += 1) energy += power[from + k] * weights[k]
      // dB-ish, floored: a silent frame is a floor, not minus infinity.
      const value = 10 * Math.log10(energy + 1e-10)
      current[band] = value
      const rise = value - this.#previous[band]
      if (rise > 0 && this.frames > 0) {
        flux += rise
        if (band < this.#lowBands) lowFlux += rise
      }
    }
    // Flux in a silent passage is the noise floor wandering; gate it.
    const loud = total > 1e-9 ? 1 : 0
    const timbre = this.#timbreRow
    for (let k = 0; k < TIMBRE; k += 1) {
      let sum = 0
      for (let band = 0; band < MEL_BANDS; band += 1) sum += this.#dct[k * MEL_BANDS + band] * (current[band] + 100)
      timbre[k] = sum
    }
    let peak = 0
    for (let k = 0; k < CHROMA; k += 1) peak = Math.max(peak, chroma[k])
    for (let k = 0; k < CHROMA; k += 1) chroma[k] = peak > 0 ? Math.sqrt(chroma[k] / peak) : 0

    this.onset.push((flux / MEL_BANDS) * loud)
    this.lowFlux.push((lowFlux / this.#lowBands) * loud)
    this.level.push(10 * Math.log10(square / FRAME + 1e-10))
    const safe = total > 0 ? total : 1
    this.low.push(low / safe)
    this.vocal.push(vocal / safe)
    this.high.push(high / safe)
    this.timbre.push(timbre)
    this.chroma.push(chroma)
    this.#previous.set(current)
  }
}

export default FeatureStream
