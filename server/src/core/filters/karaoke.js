import { AnimatableFilter } from './AnimatableFilter.js'
import { Biquad } from './dsp/biquad.js'
import { clamp, SAMPLE_RATE } from './constants.js'

/**
 * Karaoke — remove the lead vocal by cancelling what the two channels share.
 *
 * The trick is old and it works for one reason: a lead vocal is almost always
 * mixed dead centre, so it is the same signal in both channels, while the
 * instruments are panned apart. Subtract one channel from the other and the
 * centre disappears — vocal gone, and so is the bass, the kick and the snare,
 * which are also centred. That is why every karaoke implementation has the
 * same two extra knobs, and why this one has them too:
 *
 *   `level`     how much of the centre to cancel (0…1)
 *   `monoLevel` how much of the *result* to fold back to mono, which undoes
 *               some of the stereo collapse the subtraction causes
 *   `filterBand`/`filterWidth`  re-inject the low end that the subtraction
 *               took with it, from a band-passed copy of the centred signal
 *
 * NodeLink's exact law: `left' = left − right·level`, then the mono fold, then
 * the band reinjection with the band gain clamped so the re-added bass cannot
 * push the output past full scale. That clamp (`MAX_OUTPUT_GAIN = 0.98`) is
 * the difference between a karaoke filter and a karaoke filter that clips on
 * every chorus.
 */
const MAX_OUTPUT_GAIN = 0.98

export class KaraokeFilter extends AnimatableFilter {
  static schema = {
    level: { range: [0, 1], default: 0 },
    monoLevel: { range: [0, 1], default: 0 },
    filterBand: { range: [0, 20], default: 0 },
    filterWidth: { range: [0, 20], default: 0 }
  }

  name = 'karaoke'
  priority = 10

  #sampleRate
  #filter = null
  #filterKey = ''

  constructor(config = {}, { sampleRate = SAMPLE_RATE } = {}) {
    super()
    this.#sampleRate = sampleRate
    this.update(config)
  }

  update(settings = {}) {
    const previous = this.#filterKey
    super.update(settings)
    const key = `${this.config.filterBand}:${this.config.filterWidth}`
    if (key !== previous) this.#rebuild()
    return this
  }

  /**
   * The reinstated bass band.
   *
   * `filterBand` selects a centre on a log scale from 40 Hz to 400 Hz — the
   * range where the kick and bass live — and `filterWidth` widens it from a
   * third of an octave to two. A first-order band-pass is enough: this is a
   * hint of low end under the vocal-less mix, not a crossover.
   */
  #rebuild() {
    const band = clamp(this.config.filterBand ?? 0, 0, 20)
    const width = clamp(this.config.filterWidth ?? 0, 0, 20)
    this.#filterKey = `${band}:${width}`
    if (band === 0 && width === 0) {
      this.#filter = null
      return
    }
    const centre = 40 * Math.pow(10, band / 20 + 0.05)
    const q = 0.5 + width / 8
    this.#filter = {
      centre,
      high: new Biquad(),
      low: new Biquad()
    }
    this.#filter.high.highpass(centre / (1 + q), this.#sampleRate, q)
    this.#filter.low.lowpass(Math.min(centre * (1 + q), 4000), this.#sampleRate, q)
  }

  active() {
    return (this.config.level ?? 0) > 0 || (this.config.monoLevel ?? 0) > 0
  }

  process(left, right, length) {
    const level = clamp(this.config.level ?? 0, 0, 1)
    const mono = clamp(this.config.monoLevel ?? 0, 0, 1)
    if (level === 0 && mono === 0) return

    const filter = this.#filter
    for (let i = 0; i < length; i += 1) {
      const l = left[i]
      const r = right[i]

      // Cancel the centre: the vocal is `l === r`, so it is what disappears.
      let outL = l - r * level
      let outR = r - l * level

      // Fold towards mono — the subtraction leaves the sides, and the sides
      // alone read as a hole in the middle of the mix.
      if (mono > 0) {
        const mid = (outL + outR) * 0.5
        outL = outL * (1 - mono) + mid * mono
        outR = outR * (1 - mono) + mid * mono
      }

      // Put the low end back, from the original centre, band-limited. The
      // reinjection is what stops the mix sounding like a phone call, and
      // `MAX_OUTPUT_GAIN` is what stops it clipping: the band is scaled down
      // until the louder channel plus the band still fits inside full scale.
      if (filter) {
        const centreBand = (l + r) * 0.5
        const bass = filter.low.run(filter.high.run(centreBand))
        const headroom = Math.max(0, MAX_OUTPUT_GAIN - Math.max(Math.abs(outL), Math.abs(outR)))
        const allowed = Math.max(0, Math.min(1, headroom / Math.max(1e-4, Math.abs(bass))))
        outL += bass * allowed
        outR += bass * allowed
      }

      left[i] = clamp(outL, -1, 1)
      right[i] = clamp(outR, -1, 1)
    }
  }

  reset() {
    this.#filter?.high.reset()
    this.#filter?.low.reset()
  }
}

export default KaraokeFilter
