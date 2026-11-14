import { AnimatableFilter } from './AnimatableFilter.js'
import { DelayLine } from './dsp/delay.js'
import { clamp, SAMPLE_RATE } from './constants.js'

/**
 * Echo — a plain feedback delay, with a filter in the loop.
 *
 * The feedback path is low-passed at 4 kHz, which is the single change that
 * separates an echo that repeats from an echo that accumulates: without it
 * every repetition adds its own high end back into the line and after six
 * passes the tail is a pile of hiss. With it, the repeats get darker as they
 * get quieter, which is what a real room does.
 *
 * `delay` is milliseconds (0…2000), which is NodeLink's unit, and a delay of
 * zero means off rather than a one-sample comb — the schema's neutral state.
 */
export class EchoFilter extends AnimatableFilter {
  static schema = {
    delay: { range: [0, 2000], default: 0 },
    feedback: { range: [0, 1], default: 0 },
    mix: { range: [0, 1], default: 0 }
  }

  name = 'echo'
  priority = 12

  #left
  #right
  #sampleRate
  #dampedL = 0
  #dampedR = 0

  constructor(config = {}, { sampleRate = SAMPLE_RATE } = {}) {
    super()
    this.#sampleRate = sampleRate
    const maxSamples = Math.ceil(sampleRate * 2) + 2
    this.#left = new DelayLine(maxSamples)
    this.#right = new DelayLine(maxSamples)
    this.update(config)
  }

  update(settings = {}) {
    this.applyAnimatedUpdate(settings, EchoFilter.schema, {
      coerce: (key, value) => clamp(value, 0, key === 'delay' ? 2000 : 1)
    })
    return this
  }

  active() {
    return (this.config.mix ?? 0) > 0.001 && (this.config.delay ?? 0) >= 1
  }

  process(left, right, length) {
    this.processAnimation(length)
    if (!this.active()) return
    const { delay, feedback, mix } = this.config
    const samples = Math.max(1, Math.round((delay * this.#sampleRate) / 1000))
    const damp = 0.25 // one-pole low-pass in the feedback loop

    for (let i = 0; i < length; i += 1) {
      const repeatL = this.#left.read(samples)
      const repeatR = this.#right.read(samples)
      this.#dampedL += damp * (repeatL - this.#dampedL)
      this.#dampedR += damp * (repeatR - this.#dampedR)

      this.#left.push(left[i] + this.#dampedL * feedback)
      this.#right.push(right[i] + this.#dampedR * feedback)

      left[i] = left[i] * (1 - mix * 0.4) + repeatL * mix
      right[i] = right[i] * (1 - mix * 0.4) + repeatR * mix
    }
  }

  reset() {
    this.#left.clear()
    this.#right.clear()
    this.#dampedL = 0
    this.#dampedR = 0
  }
}

export default EchoFilter
