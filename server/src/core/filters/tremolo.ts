import { AnimatableFilter } from './AnimatableFilter.ts'
import { Lfo } from './dsp/lfo.ts'
import { clamp, SAMPLE_RATE } from './constants.ts'

/**
 * Tremolo — amplitude modulation at a musical rate.
 *
 * `depth` 0 is off and 1 is full on/off; the law is `1 − depth·(1+wave)/2`,
 * so the sound dips *down* from full scale rather than swinging around it.
 * That asymmetry matters: a symmetric tremolo at depth 1 spends half its time
 * above unity and clips, and a tremolo nobody can turn up to 1 is a tremolo
 * with a hidden ceiling.
 */
export class TremoloFilter extends AnimatableFilter {
  declare applyAnimatedUpdate: any
  declare config: any
  declare processAnimation: any

  static schema = {
    frequency: { range: [0, 20], default: 0 },
    depth: { range: [0, 1], default: 0 }
  }

  name = 'tremolo'
  priority = 10

  #lfo = new Lfo('sine')
  #sampleRate

  constructor(config: any = {}, { sampleRate = SAMPLE_RATE }: any = {}) {
    super()
    this.#sampleRate = sampleRate
    this.update(config)
  }

  update(settings: any = {}) {
    this.applyAnimatedUpdate(settings, TremoloFilter.schema, {
      coerce: (key, value) => clamp(value, 0, key === 'depth' ? 1 : 20)
    })
    return this
  }

  active() {
    return (this.config.frequency ?? 0) > 0.001 && (this.config.depth ?? 0) > 0.001
  }

  process(left, right, length) {
    this.processAnimation(length)
    if (!this.active()) return
    const { frequency, depth } = this.config
    for (let i = 0; i < length; i += 1) {
      const factor = 1 - depth * ((this.#lfo.getValue(frequency, this.#sampleRate) + 1) / 2)
      left[i] *= factor
      right[i] *= factor
    }
  }

  reset() {
    this.#lfo.reset()
  }
}

export default TremoloFilter
