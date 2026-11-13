import { AnimatableFilter } from './AnimatableFilter.js'
import { Biquad } from './dsp/biquad.js'
import { clamp, SAMPLE_RATE } from './constants.js'

/**
 * Low-pass, with NodeLink's `smoothing` knob and a readable `cutoff`.
 *
 * `smoothing` is the NodeLink control: 0…100, where 1 is wide open and higher
 * closes the filter down. It is not linear — the useful part of a low-pass
 * sweep is almost all in the last octave or two — so the mapping is
 * logarithmic, and `cutoff` (20 Hz…20 kHz) is offered for anyone who would
 * rather say what they mean. When both are present, `cutoff` wins: it is the
 * explicit one.
 *
 * The filter is *recomputed per block*, not per sample. A biquad's coefficients
 * changing at 44.1 kHz would be a filter that is not a filter; per block is
 * both the correct rate for a sweep and cheap.
 */
export class LowpassFilter extends AnimatableFilter {
  static schema = {
    smoothing: { range: [0, 100], default: 1 },
    cutoff: { range: [20, 20_000], default: 20_000 },
    resonance: { range: [0, 10], default: 0 }
  }

  name = 'lowpass'
  priority = 10

  #sampleRate
  #left = new Biquad()
  #right = new Biquad()
  #current = 20_000

  constructor(config = {}, { sampleRate = SAMPLE_RATE } = {}) {
    super()
    this.#sampleRate = sampleRate
    this.update(config)
    this.#retune(this.cutoff())
  }

  update(settings = {}) {
    this.applyAnimatedUpdate(settings, LowpassFilter.schema, { coerce: (key, value) => clamp(value, 0, key === 'cutoff' ? 20_000 : 100) })
    return this
  }

  /** The cutoff the knob maps to, before any animation. */
  cutoff() {
    const { cutoff, smoothing } = this.config
    if (cutoff !== undefined && cutoff < 19_900) return clamp(cutoff, 20, 20_000)
    // smoothing 1 is open; each unit above it drops the corner by ~13 % — a
    // factor of two every five, so 5 is 10 kHz and 30 lands around 500 Hz.
    if (smoothing > 1) return clamp(20_000 * Math.pow(0.85, smoothing - 1), 20, 20_000)
    return 20_000
  }

  active() {
    return this.cutoff() < 19_900
  }

  #retune(cutoff) {
    if (Math.abs(cutoff - this.#current) < 1) return
    this.#current = cutoff
    const q = Math.SQRT1_2 + clamp(this.config.resonance ?? 0, 0, 10) * 0.15
    this.#left.lowpass(cutoff, this.#sampleRate, q)
    this.#right.copyCoefficients(this.#left)
  }

  process(left, right, length) {
    this.processAnimation(length)
    const cutoff = this.cutoff()
    if (cutoff >= 19_900) return
    this.#retune(cutoff)
    for (let i = 0; i < length; i += 1) {
      left[i] = this.#left.run(left[i])
      right[i] = this.#right.run(right[i])
    }
  }

  reset() {
    this.#left.reset()
    this.#right.reset()
    this.#current = 20_000
  }
}

export default LowpassFilter
