import { AnimatableFilter } from './AnimatableFilter.ts'
import { Biquad } from './dsp/biquad.ts'
import { fx } from '../../util/fx.ts'
import { clamp, SAMPLE_RATE } from './constants.ts'

/**
 * High-pass — the mirror of the low-pass, and the filter that does the most
 * invisible good on a station.
 *
 * Every automix transition and every talkover crosses two sources; the low end
 * of both arrives at once and sums to something that clips. A high-pass at
 * 30–60 Hz on the music bus removes rumble nobody can hear and buys 3–6 dB of
 * headroom that everybody can. `smoothing` runs the other way from the
 * low-pass: 0 is open (10 Hz), 100 is closed (about 1.2 kHz), because the two
 * knobs sit next to each other in NodeLink's payload and it would be worse to
 * have them mean opposite directions.
 */
export class HighpassFilter extends AnimatableFilter {
  declare applyAnimatedUpdate: any
  declare config: any
  declare processAnimation: any

  static schema = {
    smoothing: { range: [0, 100], default: 0 },
    cutoff: { range: [10, 20_000], default: 10 },
    resonance: { range: [0, 10], default: 0 }
  }

  name = 'highpass'
  priority = 10

  #sampleRate
  #left = new Biquad()
  #right = new Biquad()
  #native
  #current = 10

  constructor(config: any = {}, { sampleRate = SAMPLE_RATE }: any = {}) {
    super()
    this.#sampleRate = sampleRate
    this.#native = fx?.Biquad ? new fx.Biquad() : null
    this.update(config)
    this.#retune(this.cutoff())
  }

  update(settings: any = {}) {
    this.applyAnimatedUpdate(settings, HighpassFilter.schema, { coerce: (key, value) => clamp(value, 0, key === 'cutoff' ? 20_000 : 100) })
    return this
  }

  /** Smoothing 0 is open; the corner rises exponentially to ~1.2 kHz. */
  cutoff() {
    const { cutoff, smoothing } = this.config
    if (cutoff !== undefined && cutoff > 11) return clamp(cutoff, 10, 20_000)
    if (smoothing > 0) return clamp(10 * Math.pow(1.05, smoothing), 10, 20_000)
    return 10
  }

  active() {
    return this.cutoff() > 11
  }

  #retune(cutoff) {
    if (Math.abs(cutoff - this.#current) < 1) return
    this.#current = cutoff
    const q = Math.SQRT1_2 + clamp(this.config.resonance ?? 0, 0, 10) * 0.15
    this.#left.highpass(cutoff, this.#sampleRate, q)
    this.#right.copyCoefficients(this.#left)
    this.#native?.setHighpass(cutoff, this.#sampleRate, q)
  }

  process(left, right, length) {
    this.processAnimation(length)
    const cutoff = this.cutoff()
    if (cutoff <= 11) return
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
    this.#current = 10
  }
}

export default HighpassFilter
