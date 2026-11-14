import { AnimatableFilter } from './AnimatableFilter.js'
import { Allpass } from './dsp/allpass.js'
import { Lfo } from './dsp/lfo.js'
import { clamp, SAMPLE_RATE } from './constants.js'

/**
 * Phaser — cascaded all-pass stages, swept.
 *
 * Different from the flanger in a way that is easy to hear and easy to get
 * wrong: a flanger's notches are evenly spaced (a comb) and a phaser's are
 * not, because it shifts *phase* and sums, and phase is a nonlinear function
 * of frequency. That is why a phaser sounds vocal and a flanger sounds
 * metallic.
 *
 * NodeLink exposes `stages`, `minFrequency` and `maxFrequency`; the sweep is
 * geometric between the two, and the all-pass coefficient comes from the
 * classic `(tan(πf/fs) − 1)/(tan(πf/fs) + 1)` — clamped in `Allpass` so a
 * frequency at Nyquist cannot make the recursion ring.
 */
export class PhaserFilter extends AnimatableFilter {
  static schema = {
    delay: { range: [0, 1], default: 0 },
    rate: { range: [0, 10], default: 0 },
    depth: { range: [0, 1], default: 1, neutral: 0 },
    feedback: { range: [0, 0.9], default: 0 },
    mix: { range: [0, 1], default: 0.5, neutral: 0 },
    // NodeLink's floor of two stages and its 100 Hz → 2.5 kHz sweep window.
    stages: { range: [2, 8], default: 4, integer: true },
    minFrequency: { range: [20, 20_000], default: 100 },
    maxFrequency: { range: [20, 20_000], default: 2500 }
  }

  name = 'phaser'
  priority = 10

  #lfo = new Lfo('sine')
  #sampleRate
  #left = []
  #right = []
  #feedbackL = 0
  #feedbackR = 0
  #stages = 0

  constructor(config = {}, { sampleRate = SAMPLE_RATE } = {}) {
    super()
    this.#sampleRate = sampleRate
    this.update(config)
    this.#rebuildStages()
  }

  update(settings = {}) {
    this.applyAnimatedUpdate(settings, PhaserFilter.schema, {
      coerce: (key, value) => {
        if (key === 'stages') return clamp(Math.round(value), 2, 8)
        if (key === 'feedback') return clamp(value, 0, 0.9)
        if (key === 'minFrequency' || key === 'maxFrequency') return clamp(value, 20, 20_000)
        return clamp(value, 0, key === 'rate' ? 10 : 1)
      }
    })
    this.#rebuildStages()
    return this
  }

  #rebuildStages() {
    const wanted = this.config.stages ?? 4
    if (wanted === this.#stages && this.#left.length) return
    this.#stages = wanted
    this.#left = Array.from({ length: wanted }, () => new Allpass())
    this.#right = Array.from({ length: wanted }, () => new Allpass())
  }

  active() {
    const { mix, depth, rate } = this.config
    return (mix ?? 0) > 0.001 && (depth ?? 0) > 0.001 && (rate ?? 0) > 0.001
  }

  process(left, right, length) {
    this.processAnimation(length)
    if (!this.active()) return
    const { rate, depth, feedback, mix, minFrequency, maxFrequency } = this.config
    const low = Math.max(20, Math.min(minFrequency, maxFrequency))
    const high = Math.max(low + 1, Math.max(minFrequency, maxFrequency))

    for (let i = 0; i < length; i += 1) {
      // Sweep geometrically: an octave is the same distance at 200 Hz and at
      // 2 kHz, so a linear sweep would spend most of its time at the top.
      const unit = (this.#lfo.getValue(Math.max(0.02, rate), this.#sampleRate) + 1) / 2
      const frequency = low * Math.pow(high / low, unit * depth + (1 - depth) * 0.5)
      const tan = Math.tan((Math.PI * frequency) / this.#sampleRate)
      const coefficient = (tan - 1) / (tan + 1)

      let wetL = left[i] + this.#feedbackL * feedback
      let wetR = right[i] + this.#feedbackR * feedback
      for (let stage = 0; stage < this.#stages; stage += 1) {
        this.#left[stage].setCoefficient(coefficient)
        this.#right[stage].setCoefficient(coefficient)
        wetL = this.#left[stage].process(wetL)
        wetR = this.#right[stage].process(wetR)
      }
      this.#feedbackL = wetL
      this.#feedbackR = wetR

      left[i] = left[i] * (1 - mix) + wetL * mix
      right[i] = right[i] * (1 - mix) + wetR * mix
    }
  }

  reset() {
    this.#lfo.reset()
    for (const stage of this.#left) stage.reset()
    for (const stage of this.#right) stage.reset()
    this.#feedbackL = 0
    this.#feedbackR = 0
  }
}

export default PhaserFilter
