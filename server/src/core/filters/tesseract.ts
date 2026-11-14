import { AnimatableFilter } from './AnimatableFilter.ts'
import { Lfo } from './dsp/lfo.ts'
import { clamp, SAMPLE_RATE } from './constants.ts'

/**
 * Tesseract — a 4-D rotation projected back onto two channels.
 *
 * NodeLink rotates a two-channel field in a fourth dimension, which in
 * practice is two independent LFOs 90° apart driving a pan — the figure a
 * Leslie cabinet draws, and the reason it sounds like a speaker spinning
 * rather than a balance knob moving. One axis pans, the other crossfades, and
 * because the two are a quarter-cycle apart the sound traces a circle rather
 * than a line. The name is kept so a NodeLink payload round-trips.
 */
export class TesseractFilter extends AnimatableFilter {
  declare applyAnimatedUpdate: any
  declare config: any
  declare processAnimation: any

  static schema = {
    rotationHz: { range: [0, 100], default: 0 }
  }

  name = 'tesseract'
  priority = 15

  #lfo = new Lfo('sine')
  #sampleRate

  constructor(config: any = {}, { sampleRate = SAMPLE_RATE }: any = {}) {
    super()
    this.#sampleRate = sampleRate
    this.update(config)
  }

  update(settings: any = {}) {
    this.applyAnimatedUpdate(settings, TesseractFilter.schema, { coerce: (_, value) => clamp(value, 0, 100) })
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
      const a = this.#lfo.getValue(rate, this.#sampleRate)
      // The second axis, a quarter-cycle behind: one dimension pans, the other
      // crossfades, so the image moves in a circle.
      const b = Math.cos(this.#lfo.phase)
      const l = left[i]
      const r = right[i]
      left[i] = l * (0.5 + a * 0.5) + r * b * 0.5
      right[i] = r * (0.5 - a * 0.5) + l * -b * 0.5
    }
  }

  reset() {
    this.#lfo.reset()
  }
}

export default TesseractFilter
