import { AnimatableFilter } from './AnimatableFilter.ts'
import { Lfo } from './dsp/lfo.ts'
import { clamp, SAMPLE_RATE } from './constants.ts'

/**
 * Rotation — a turntable's stereo rotation, the "8D audio" effect.
 *
 * One LFO drives a constant-power pan: the gains are `cos`/`sin` of the same
 * phase, so their squares sum to one and the total energy does not pump as the
 * sound swings across the stereo field. A linear pan sounds like a wobble in
 * *volume*; a constant-power pan sounds like movement, which is the whole
 * point of the effect.
 */
export class RotationFilter extends AnimatableFilter {
  declare applyAnimatedUpdate: any
  declare config: any
  declare processAnimation: any

  static schema = {
    rotationHz: { range: [0, 100], default: 0 }
  }

  name = 'rotation'
  priority = 10

  #lfo = new Lfo('sine')
  #sampleRate

  constructor(config: any = {}, { sampleRate = SAMPLE_RATE }: any = {}) {
    super()
    this.#sampleRate = sampleRate
    this.update(config)
  }

  update(settings: any = {}) {
    this.applyAnimatedUpdate(settings, RotationFilter.schema, { coerce: (_, value) => clamp(value, 0, 100) })
    return this
  }

  active() {
    return (this.config.rotationHz ?? 0) > 0.001
  }

  process(left, right, length) {
    this.processAnimation(length)
    if (!this.active()) return
    const rate = this.config.rotationHz
    for (let i = 0; i < length; i += 1) {
      this.#lfo.getValue(rate, this.#sampleRate)
      const angle = this.#lfo.phase
      // cos/sin rather than 0.5 ± wave: equal power, no level pumping.
      const gainL = Math.cos(angle) * Math.SQRT1_2 + Math.SQRT1_2
      const gainR = Math.sin(angle) * Math.SQRT1_2 + Math.SQRT1_2
      const l = left[i]
      const r = right[i]
      left[i] = l * gainL + r * (1 - gainL) * 0.25
      right[i] = r * gainR + l * (1 - gainR) * 0.25
    }
  }

  reset() {
    this.#lfo.reset()
  }
}

export default RotationFilter
