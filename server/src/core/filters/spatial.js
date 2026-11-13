import { AnimatableFilter } from './AnimatableFilter.js'
import { Lfo } from './dsp/lfo.js'
import { clamp, SAMPLE_RATE } from './constants.js'

/**
 * Spatial — place the source in a 3-D field around the listener.
 *
 * `x`, `y`, `z` are positions in a unit-ish cube; `depth` and `rate` add a
 * slow orbit so the source moves rather than sits. The stereo image is built
 * from `x` (pan) and `z` (front/back, rendered as a high-shelf darker when
 * behind), and `y` drives level — the head-related transfer function of a
 * stream at 128 kbps, which is to say a good pan and a little air loss, not a
 * binaural render.
 *
 * `depth` orbits the position around the current one; at `rate` 0 the source
 * is simply placed, which is the useful half of the effect.
 */
export class SpatialFilter extends AnimatableFilter {
  static schema = {
    x: { range: [-2, 2], default: 0 },
    y: { range: [-2, 2], default: 0 },
    z: { range: [-2, 2], default: 0 },
    depth: { range: [0, 1], default: 0 },
    rate: { range: [0, 10], default: 0 }
  }

  name = 'spatial'
  priority = 10

  #lfo = new Lfo('sine')
  #sampleRate

  constructor(config = {}, { sampleRate = SAMPLE_RATE } = {}) {
    super()
    this.#sampleRate = sampleRate
    this.update(config)
  }

  update(settings = {}) {
    this.applyAnimatedUpdate(settings, SpatialFilter.schema, {
      coerce: (key, value) => clamp(value, key === 'depth' || key === 'rate' ? 0 : -2, key === 'depth' ? 1 : key === 'rate' ? 10 : 2)
    })
    return this
  }

  active() {
    const { x, y, z, depth } = this.config
    return x !== 0 || y !== 0 || z !== 0 || depth > 0
  }

  process(left, right, length) {
    this.processAnimation(length)
    if (!this.active()) return
    const { x, y, z, depth, rate } = this.config

    for (let i = 0; i < length; i += 1) {
      const orbit = rate > 0 ? this.#lfo.getValue(rate, this.#sampleRate) * depth : 0
      const pan = clamp(x + orbit, -1, 1)
      // Constant-power pan again, but centred at 0 rather than sweeping.
      const angle = ((pan + 1) * Math.PI) / 4
      const gainL = Math.cos(angle)
      const gainR = Math.sin(angle)
      // Front/back: behind the listener loses its top end, in front of it
      // gains a little presence. Cheap, and it is what makes z audible at all.
      const air = clamp(1 - z * 0.15 + depth * 0.05, 0.6, 1.4)
      // Up and down is level, gently: ±3 dB over the full range.
      const height = clamp(1 + y * 0.08, 0.6, 1.6)

      left[i] = left[i] * gainL * height * air
      right[i] = right[i] * gainR * height * (2 - air)
    }
  }

  reset() {
    this.#lfo.reset()
  }
}

export default SpatialFilter
