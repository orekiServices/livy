import { AnimatableFilter } from './AnimatableFilter.js'
import { FractionalDelay } from './dsp/delay.js'
import { Lfo } from './dsp/lfo.js'
import { clamp, SAMPLE_RATE } from './constants.js'

/**
 * Vibrato — pitch modulation by moving a delay line's read head.
 *
 * Reading `d` samples back from a line that is being written at the input rate
 * plays the signal late; *moving* `d` up and down changes the pitch, because
 * the read head is travelling relative to the samples it is reading. A swing
 * of `depth` milliseconds at `frequency` Hz is a pitch wobble of roughly
 * `depth·frequency` percent, which is why the schema's depth runs to 2 ms —
 * at 5 Hz that is already a whole semitone, and more is a siren.
 *
 * The line is fractional-read: at these delays the read head lands between
 * samples most of the time, and rounding would turn a smooth vibrato into a
 * 44.1 kHz staircase.
 */
export class VibratoFilter extends AnimatableFilter {
  static schema = {
    frequency: { range: [0, 20], default: 0 },
    depth: { range: [0, 2], default: 0 }
  }

  name = 'vibrato'
  priority = 10

  #lfo = new Lfo('sine')
  #left
  #right
  #sampleRate
  #centre

  constructor(config = {}, { sampleRate = SAMPLE_RATE } = {}) {
    super()
    this.#sampleRate = sampleRate
    // 2 ms of depth plus a little slack, at the lowest sample rate we accept.
    const maxSamples = Math.ceil((sampleRate * 8) / 1000)
    this.#left = new FractionalDelay(maxSamples)
    this.#right = new FractionalDelay(maxSamples)
    this.#centre = (sampleRate * 2) / 1000
    this.update(config)
  }

  update(settings = {}) {
    this.applyAnimatedUpdate(settings, VibratoFilter.schema, {
      coerce: (key, value) => clamp(value, 0, key === 'depth' ? 2 : 20)
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
    const swing = (this.#sampleRate * depth) / 1000

    for (let i = 0; i < length; i += 1) {
      const modulation = this.#lfo.getValue(frequency, this.#sampleRate) * swing
      this.#left.push(left[i])
      this.#right.push(right[i])
      left[i] = this.#left.read(this.#centre + modulation)
      right[i] = this.#right.read(this.#centre + modulation)
    }
  }

  reset() {
    this.#lfo.reset()
    this.#left.clear()
    this.#right.clear()
  }
}

export default VibratoFilter
