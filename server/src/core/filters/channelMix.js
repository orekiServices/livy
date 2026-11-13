import { AnimatableFilter } from './AnimatableFilter.js'
import { clamp } from './constants.js'

/**
 * Channel mix — the 2×2 matrix, the simplest filter here and the one that
 * does the most work in a DJ set.
 *
 *   left'  = left·leftToLeft   + right·rightToLeft
 *   right' = left·leftToRight  + right·rightToRight
 *
 * Identity is `{1, 0, 0, 1}`. Everything else is a named effect on top of it:
 * swapping `leftToLeft`/`rightToRight` with the cross terms is a channel swap;
 * all four at 1 is mono; 2×2 at 0.5 is a −6 dB mono fold that does not clip.
 */
export class ChannelMixFilter extends AnimatableFilter {
  static schema = {
    leftToLeft: { range: [0, 1], default: 1 },
    leftToRight: { range: [0, 1], default: 0 },
    rightToLeft: { range: [0, 1], default: 0 },
    rightToRight: { range: [0, 1], default: 1 }
  }

  name = 'channelMix'
  priority = 10

  constructor(config = {}) {
    super()
    this.update(config)
  }

  update(settings = {}) {
    this.applyAnimatedUpdate(settings, ChannelMixFilter.schema, { coerce: (_, value) => clamp(value, 0, 1) })
    return this
  }

  active() {
    const { leftToLeft, leftToRight, rightToLeft, rightToRight } = this.config
    return (
      Math.abs(leftToLeft - 1) > 1e-3 ||
      Math.abs(leftToRight) > 1e-3 ||
      Math.abs(rightToLeft) > 1e-3 ||
      Math.abs(rightToRight - 1) > 1e-3
    )
  }

  process(left, right, length) {
    if (!this.isActive()) return
    const ll = this.config.leftToLeft
    const lr = this.config.leftToRight
    const rl = this.config.rightToLeft
    const rr = this.config.rightToRight
    for (let i = 0; i < length; i += 1) {
      const l = left[i]
      const r = right[i]
      left[i] = l * ll + r * rl
      right[i] = l * lr + r * rr
    }
  }
}

export default ChannelMixFilter
