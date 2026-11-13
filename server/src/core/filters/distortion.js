import { AnimatableFilter } from './AnimatableFilter.js'
import { clampSample, softClip } from './dsp/clamp.js'
import { clamp } from './constants.js'

/**
 * Distortion — four waveshapers in one, exactly NodeLink's set.
 *
 * Each pair of knobs is `offset` (a DC bias into the shaper) and `scale` (how
 * hard it is driven), applied through a different function:
 *
 *   sin  sin(x·scale + offset)     a warm, valve-ish fold
 *   cos  cos(x·scale + offset)     harsher, asymmetric on the way in
 *   tan  tanh(x·scale + offset)    the classic saturation
 *   —    x·scale + offset          plain hard clipping, the punk option
 *
 * The final `offset` and `scale` apply after the shaper, which is what makes
 * the four usable together rather than four separate pedals: shape with `sin`,
 * then bias the result to choose which half of the wave clips.
 *
 * Neutral is every offset 0 and every scale 1 for the shapes — but note the
 * fourth pair: `offset: 0, scale: 1` bypasses, since `x·1 + 0` is `x`. The
 * filter is active when any of the eight knobs is away from neutral.
 */
export class DistortionFilter extends AnimatableFilter {
  static schema = {
    sinOffset: { range: [-1, 1], default: 0 },
    sinScale: { range: [0, 3], default: 1 },
    cosOffset: { range: [-1, 1], default: 0 },
    cosScale: { range: [0, 3], default: 1 },
    tanOffset: { range: [-1, 1], default: 0 },
    tanScale: { range: [0, 3], default: 1 },
    offset: { range: [-1, 1], default: 0 },
    scale: { range: [0, 3], default: 1 }
  }

  name = 'distortion'
  priority = 11

  constructor(config = {}) {
    super()
    this.update(config)
  }

  update(settings = {}) {
    this.applyAnimatedUpdate(settings, DistortionFilter.schema, {
      coerce: (key, value) => clamp(value, key.endsWith('Offset') || key === 'offset' ? -1 : 0, 3)
    })
    return this
  }

  active() {
    const c = this.config
    return (
      (c.offset ?? 0) !== 0 ||
      (c.sinOffset ?? 0) !== 0 ||
      (c.cosOffset ?? 0) !== 0 ||
      (c.tanOffset ?? 0) !== 0 ||
      Math.abs((c.scale ?? 1) - 1) > 1e-3 ||
      Math.abs((c.sinScale ?? 1) - 1) > 1e-3 ||
      Math.abs((c.cosScale ?? 1) - 1) > 1e-3 ||
      Math.abs((c.tanScale ?? 1) - 1) > 1e-3
    )
  }

  process(left, right, length) {
    if (!this.isActive()) return
    const { sinOffset, sinScale, cosOffset, cosScale, tanOffset, tanScale, offset, scale } = this.config

    // Precompute the branches; a per-sample `if` on eight values is the
    // difference between one waveshape table lookup and nine comparisons.
    const sin = sinOffset !== 0 || sinScale !== 1
    const cos = cosOffset !== 0 || cosScale !== 1
    const tan = tanOffset !== 0 || tanScale !== 1

    for (let i = 0; i < length; i += 1) {
      for (const channel of [left, right]) {
        let x = channel[i]
        if (sin) x = Math.sin(x * sinScale + sinOffset)
        if (cos) x = Math.cos(x * cosScale + cosOffset)
        if (tan) x = Math.tanh(x * tanScale + tanOffset)
        x = x * scale + offset
        // The shaper's own output can exceed full scale (`cos` is ±1 before
        // `scale`), so the last thing every distortion does is soft-clip.
        channel[i] = clampSample(softClip(x))
      }
    }
  }
}

export default DistortionFilter
