import { AnimatableFilter } from './AnimatableFilter.ts'
import { FractionalDelay } from './dsp/delay.ts'
import { Lfo } from './dsp/lfo.ts'
import { clamp, SAMPLE_RATE } from './constants.ts'

/**
 * Chorus — one short, slowly modulated copy per channel, mixed under the dry.
 *
 * The difference between a chorus and a vibrato is only where the modulation
 * goes: a vibrato modulates the *delay of the whole signal*, a chorus leaves
 * the dry signal alone and modulates a copy, then adds it back. That is why a
 * chorus thickens and a vibrato wobbles — and why the two LFOs are
 * deliberately out of phase here (the right channel's copy lags by a quarter
 * cycle), since two identical copies summed are just a louder signal.
 *
 * `delay` is the base delay in milliseconds, as in NodeLink (1…995, default
 * `feedback` puts part of the copy back into the line for a thicker tail.
 */
export class ChorusFilter extends AnimatableFilter {
  declare applyAnimatedUpdate: any
  declare config: any
  declare processAnimation: any

  static schema = {
    delay: { range: [1, 995], default: 25 },
    rate: { range: [0, 10], default: 0 },
    depth: { range: [0, 1], default: 0 },
    feedback: { range: [0, 0.95], default: 0 },
    mix: { range: [0, 1], default: 0.5, neutral: 0 }
  }

  name = 'chorus'
  priority = 10

  #lfo = new Lfo('sine')
  #left
  #right
  #sampleRate

  constructor(config: any = {}, { sampleRate = SAMPLE_RATE }: any = {}) {
    super()
    this.#sampleRate = sampleRate
    const maxSamples = Math.ceil(sampleRate) + 8
    this.#left = new FractionalDelay(maxSamples)
    this.#right = new FractionalDelay(maxSamples)
    this.update(config)
  }

  update(settings: any = {}) {
    this.applyAnimatedUpdate(settings, ChorusFilter.schema, {
      coerce: (key, value) => {
        if (key === 'rate') return clamp(value, 0, 10)
        if (key === 'delay') return clamp(value, 1, 995)
        if (key === 'feedback') return clamp(value, 0, 0.95)
        return clamp(value, 0, 1)
      }
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
    const base = (this.#sampleRate * delay) / 1000

    for (let i = 0; i < length; i += 1) {
      const swing = this.#lfo.getValue(Math.max(0.05, rate), this.#sampleRate) * depth * base * 0.5
      // A quarter-cycle offset on the right keeps the two copies apart.
      const swingR = Math.cos(this.#lfo.phase) * depth * base * 0.5

      const wetL = this.#left.read(base + swing)
      const wetR = this.#right.read(base + swingR)
      this.#left.push(left[i] + wetL * feedback)
      this.#right.push(right[i] + wetR * feedback)

      left[i] = left[i] * (1 - mix) + wetL * mix
      right[i] = right[i] * (1 - mix) + wetR * mix
    }
  }

  reset() {
    this.#lfo.reset()
    this.#left.clear()
    this.#right.clear()
  }
}

export default ChorusFilter
