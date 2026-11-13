import { AnimatableFilter } from './AnimatableFilter.js'
import { FractionalDelay } from './dsp/delay.js'
import { Lfo } from './dsp/lfo.js'
import { clamp, SAMPLE_RATE } from './constants.js'

/**
 * Flanger — a very short modulated delay summed with the dry signal.
 *
 * The chorus's sibling, separated by two orders of magnitude of delay: 0.5–10
 * ms instead of 5–30 ms. At those distances the copy is not heard as a copy,
 * it is heard as a comb filter — the sum of a signal and itself a millisecond
 * later cancels at odd harmonics of 1/delay, and sweeping the delay sweeps the
 * notches. That metallic whoosh is the whole effect, which is why the mix here
 * is normally near 0.5 and why `feedback` sharpens the notches rather than
 * adding echo.
 */
export class FlangerFilter extends AnimatableFilter {
  static schema = {
    delay: { range: [0, 1], default: 0 },
    rate: { range: [0, 10], default: 0 },
    depth: { range: [0, 1], default: 0 },
    feedback: { range: [0, 1], default: 0 },
    mix: { range: [0, 1], default: 0 }
  }

  name = 'flanger'
  priority = 10

  #lfo = new Lfo('sine')
  #left
  #right
  #sampleRate

  constructor(config = {}, { sampleRate = SAMPLE_RATE } = {}) {
    super()
    this.#sampleRate = sampleRate
    const maxSamples = Math.ceil((sampleRate * 24) / 1000)
    this.#left = new FractionalDelay(maxSamples)
    this.#right = new FractionalDelay(maxSamples)
    this.update(config)
  }

  update(settings = {}) {
    this.applyAnimatedUpdate(settings, FlangerFilter.schema, {
      coerce: (key, value) => clamp(value, 0, key === 'rate' ? 10 : 1)
    })
    return this
  }

  active() {
    return (this.config.mix ?? 0) > 0.001
  }

  process(left, right, length) {
    this.processAnimation(length)
    if (!this.active()) return
    const { delay, rate, depth, feedback, mix } = this.config
    const base = (this.#sampleRate * (0.5 + delay * 4.5)) / 1000
    const swing = base * depth * 0.9

    for (let i = 0; i < length; i += 1) {
      const mod = this.#lfo.getValue(Math.max(0.02, rate), this.#sampleRate) * swing
      const wetL = this.#left.read(base + mod)
      const wetR = this.#right.read(base + mod * 0.9)
      this.#left.push(left[i] + wetL * feedback)
      this.#right.push(right[i] + wetR * feedback)
      left[i] = left[i] * (1 - mix * 0.5) + wetL * mix
      right[i] = right[i] * (1 - mix * 0.5) + wetR * mix
    }
  }

  reset() {
    this.#lfo.reset()
    this.#left.clear()
    this.#right.clear()
  }
}

export default FlangerFilter
