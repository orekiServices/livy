import { AnimatableFilter } from './AnimatableFilter.ts'
import { Biquad } from './dsp/biquad.ts'
import { clamp, SAMPLE_RATE } from './constants.ts'

/**
 * Karaoke — remove the lead vocal by cancelling what the two channels share.
 *
 * The trick is old and it works for one reason: a lead vocal is almost always
 * mixed dead centre, so it is the same signal in both channels, while the
 * instruments are panned apart. Subtract one channel from the other and the
 * centre disappears — vocal gone, and so is the bass, the kick and the snare,
 * which are also centred. That is why every karaoke implementation has the
 * same two extra knobs, and why this one has them too.
 *
 * The law is NodeLink's, and it is a band split rather than a subtraction:
 *
 *   below `filterBand`  the low end is passed through **per channel**, so the
 *                       kick and the bass stay where they were panned
 *   above `filterBand`  the high band is replaced by its side signal
 *                       (`highL − highR`) scaled by `level`
 *   `monoLevel`         subtracts the mid from both channels first, which is
 *                       NodeLink's separate "mono the centre" control
 *
 * Writing it this way is the difference between a karaoke filter that leaves a
 * hole where the bass was and one that only removes the voice: the old version
 * cancelled the whole spectrum and then tried to put a band back.
 *
 * `filterBand` is the split frequency in hertz and `filterWidth` sets the
 * filter's Q as `filterBand / filterWidth` — NodeLink's units, which is why
 * the defaults are 220 and 100 rather than a pair of octave counts. A zero in
 * either one turns the split off, exactly as it does there.
 */
const MAX_OUTPUT_GAIN = 0.98

export class KaraokeFilter extends AnimatableFilter {
  declare config: any
  declare processAnimation: any

  static schema = {
    // NodeLink's defaults: full centre cancel over a 220 Hz / 100 Hz split,
    // plus the mono fold. Zeroing the levels is what makes it neutral.
    level: { range: [0, 1], default: 1, neutral: 0 },
    monoLevel: { range: [0, 1], default: 1, neutral: 0 },
    filterBand: { range: [0, 20_000], default: 220 },
    filterWidth: { range: [0, 5_000], default: 100 }
  }

  name = 'karaoke'
  priority = 10

  #sampleRate
  #filter = null
  #filterKey = ''

  constructor(config: any = {}, { sampleRate = SAMPLE_RATE }: any = {}) {
    super()
    this.#sampleRate = sampleRate
    this.update(config)
  }

  update(settings: any = {}) {
    const previous = this.#filterKey
    super.update(settings)
    const key = `${this.config.filterBand}:${this.config.filterWidth}`
    if (key !== previous) this.#rebuild()
    return this
  }

  /**
   * The band split: a low-pass and a high-pass per channel, both at the split
   * frequency, both with Q = `filterBand / filterWidth`.
   */
  #rebuild() {
    const band = clamp(this.config.filterBand ?? 220, 0, this.#sampleRate * 0.49)
    const width = clamp(this.config.filterWidth ?? 100, 0, 5_000)
    this.#filterKey = `${band}:${width}`
    if (!band || !width) {
      this.#filter = null
      return
    }
    const q = clamp(band / width, 1e-4, 20)
    const make = () => {
      const low = new Biquad()
      const high = new Biquad()
      low.lowpass(band, this.#sampleRate, q)
      high.highpass(band, this.#sampleRate, q)
      return { low, high }
    }
    this.#filter = { left: make(), right: make() }
  }

  active() {
    return (this.config.level ?? 0) > 0 || (this.config.monoLevel ?? 0) > 0
  }

  process(left, right, length) {
    this.processAnimation(length)
    const level = clamp(this.config.level ?? 0, 0, 1)
    const mono = clamp(this.config.monoLevel ?? 0, 0, 1)
    if (level === 0 && mono === 0) return
    const filter = level > 0 ? this.#filter : null

    for (let i = 0; i < length; i += 1) {
      let l = left[i]
      let r = right[i]

      // NodeLink's mono control: take the centre out of both channels before
      // the band split, so the split only ever sees what is left.
      if (mono > 0) {
        const sub = ((l + r) * 0.5) * mono
        l -= sub
        r -= sub
      }

      if (filter) {
        const lowL = filter.left.low.run(l)
        const lowR = filter.right.low.run(r)
        const highL = filter.left.high.run(l)
        const highR = filter.right.high.run(r)
        // The side signal, scaled by how much of the centre to remove. With
        // `level: 1` the high band *is* the sides; with `level: 0.5` it is
        // half sides and half original.
        const cancelled = (highL - highR) * level
        l = lowL + cancelled
        r = lowR - cancelled
      }

      left[i] = clamp(l, -MAX_OUTPUT_GAIN, MAX_OUTPUT_GAIN)
      right[i] = clamp(r, -MAX_OUTPUT_GAIN, MAX_OUTPUT_GAIN)
    }
  }

  reset() {
    this.#filter?.left.low.reset()
    this.#filter?.left.high.reset()
    this.#filter?.right.low.reset()
    this.#filter?.right.high.reset()
  }
}

export default KaraokeFilter
