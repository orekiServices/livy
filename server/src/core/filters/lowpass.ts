import { AnimatableFilter } from './AnimatableFilter.ts'
import { Biquad } from './dsp/biquad.ts'
import { fx } from '../../util/fx.ts'
import { clamp, SAMPLE_RATE } from './constants.ts'

/**
 * Low-pass, with NodeLink's `smoothing` knob and a readable `cutoff`.
 *
 * `smoothing` is the NodeLink control: 1…100, where 1 is wide open and higher
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
  declare applyAnimatedUpdate: any
  declare config: any
  declare processAnimation: any

  static schema = {
    smoothing: { range: [1, 100], default: 1 },
    cutoff: { range: [20, 20_000], default: 20_000 },
    resonance: { range: [0, 10], default: 0 }
  }

  name = 'lowpass'
  priority = 10

  #sampleRate
  #left = new Biquad()
  #right = new Biquad()
  #native
  #current = 20_000

  constructor(config: any = {}, { sampleRate = SAMPLE_RATE }: any = {}) {
    super()
    this.#sampleRate = sampleRate
    this.#native = fx?.Biquad ? new fx.Biquad() : null
    this.update(config)
    this.#retune(this.cutoff())
  }

  update(settings: any = {}) {
    this.applyAnimatedUpdate(settings, LowpassFilter.schema, { coerce: (key, value) => clamp(value, 0, key === 'cutoff' ? 20_000 : 100) })
    return this
  }

  /** The cutoff the knob maps to, before any animation. */
  cutoff() {
    const { cutoff, smoothing } = this.config
    if (cutoff !== undefined && cutoff < 19_900) return clamp(cutoff, 20, 20_000)
    // NodeLink's law: cutoff = 20 kHz / smoothing, so 2 is 10 kHz, 10 is
    // 2 kHz, 40 is 500 Hz and the floor is 200 Hz. It is the same curve as
    // their log-scaled slider, written without the log.
    if (smoothing > 1) return clamp(20_000 / smoothing, 200, 20_000)
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
    this.#native?.setLowpass(cutoff, this.#sampleRate, q)
  }

  process(left, right, length) {
    this.processAnimation(length)
    const cutoff = this.cutoff()
    if (cutoff >= 19_900) return
    this.#retune(cutoff)
    if (this.#native) {
      this.#native.process(left, right, length)
      return
    }
    for (let i = 0; i < length; i += 1) {
      left[i] = this.#left.run(left[i])
      right[i] = this.#right.run(right[i])
    }
  }

  reset() {
    this.#left.reset()
    this.#right.reset()
    this.#native?.reset()
    this.#current = 20_000
  }
}

export default LowpassFilter
