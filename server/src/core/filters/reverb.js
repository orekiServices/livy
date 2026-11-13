import { AnimatableFilter } from './AnimatableFilter.js'
import { clamp, SAMPLE_RATE } from './constants.js'
import { fx } from '../../util/fx.js'

/**
 * Reverb — a Freeverb-style network: eight parallel combs into four all-passes
 * per channel, with the right side's delay lengths offset so the two channels
 * decorrelate.
 *
 * This is the "good enough to be a room, cheap enough to run on a radio
 * stream" point in the reverb design space. A convolution reverb needs an
 * impulse response and a 2 000-tap FFT per block; a Schroeder/Freeverb
 * network is 24 delay lines and 24 multiplies, which is a rounding error next
 * to the MP3 encoder that follows it.
 *
 * The knobs are NodeLink's: `roomSize` sets the comb feedback, `damping` the
 * low-pass inside each comb, `wetLevel`/`dryLevel` the balance, `width` how
 * far apart the two channels' networks are, and `mix` the final blend. `mix`
 * and the wet/dry pair are both supported because a console may send either;
 * `mix` wins when it is non-zero, which is what a "reverb amount" slider
 * expects.
 */
const COMB_DELAYS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
const ALLPASS_DELAYS = [556, 441, 341, 225]
const STEREO_SPREAD = 23

/** The classic Freeverb input gain: ten combs summed want 0.012…0.03. */
const INPUT_GAIN = 0.015

class Comb {
  constructor(size) {
    this.buffer = new Float32Array(size)
    this.index = 0
    this.filter = 0
    this.feedback = 0.5
    this.damp = 0.5
  }

  run(input) {
    const output = this.buffer[this.index]
    this.filter = output * (1 - this.damp) + this.filter * this.damp
    this.buffer[this.index] = input + this.filter * this.feedback
    this.index = (this.index + 1) % this.buffer.length
    return output
  }

  reset() {
    this.buffer.fill(0)
    this.filter = 0
  }
}

class Allpass {
  constructor(size) {
    this.buffer = new Float32Array(size)
    this.index = 0
    this.feedback = 0.5
  }

  run(input) {
    const delayed = this.buffer[this.index]
    this.buffer[this.index] = input + delayed * this.feedback
    this.index = (this.index + 1) % this.buffer.length
    return delayed - input
  }

  reset() {
    this.buffer.fill(0)
  }
}

export class ReverbFilter extends AnimatableFilter {
  static schema = {
    roomSize: { range: [0, 1], default: 0 },
    damping: { range: [0, 1], default: 0 },
    wetLevel: { range: [0, 1], default: 0 },
    dryLevel: { range: [0, 1], default: 1 },
    width: { range: [0, 1], default: 0 },
    mix: { range: [0, 1], default: 0 }
  }

  name = 'reverb'
  priority = 13

  #sampleRate
  #left = []
  #right = []
  #allpassL = []
  #allpassR = []
  #native = null

  constructor(config = {}, { sampleRate = SAMPLE_RATE } = {}) {
    super()
    this.#sampleRate = sampleRate
    const scale = sampleRate / SAMPLE_RATE
    this.#left = COMB_DELAYS.map((size) => new Comb(Math.round(size * scale)))
    this.#right = COMB_DELAYS.map((size) => new Comb(Math.round((size + STEREO_SPREAD) * scale)))
    this.#allpassL = ALLPASS_DELAYS.map((size) => new Allpass(Math.round(size * scale)))
    this.#allpassR = ALLPASS_DELAYS.map((size) => new Allpass(Math.round((size + STEREO_SPREAD) * scale)))
    this.#native = fx?.Reverb ? new fx.Reverb(sampleRate) : null
    this.update(config)
  }

  update(settings = {}) {
    this.applyAnimatedUpdate(settings, ReverbFilter.schema, { coerce: (_, value) => clamp(value, 0, 1) })
    // Feedback stays below 0.98 or the network rings forever; Freeverb's own
    // mapping is 0.7 + 0.28 × room, which tops out just under that.
    const feedback = 0.7 + clamp(this.config.roomSize ?? 0, 0, 1) * 0.28
    const damp = clamp(this.config.damping ?? 0, 0, 1) * 0.4
    for (const comb of this.#left) {
      comb.feedback = feedback
      comb.damp = damp
    }
    for (const comb of this.#right) {
      comb.feedback = feedback
      comb.damp = damp
    }
    this.#native?.setParams(
      this.config.roomSize ?? 0,
      this.config.damping ?? 0,
      this.config.width ?? 0,
      this.config.mix > 0 ? this.config.mix : (this.config.wetLevel ?? 0),
      this.config.mix > 0 ? 1 - this.config.mix : (this.config.dryLevel ?? 1)
    )
    return this
  }

  active() {
    return (this.config.mix ?? 0) > 0.001 || (this.config.wetLevel ?? 0) > 0.001
  }

  process(left, right, length) {
    this.processAnimation(length)
    if (!this.active()) return
    const { width, wetLevel, dryLevel, mix } = this.config

    // `mix` is the console's "amount"; explicit wet/dry is for the API. When
    // both are present the amount wins, because that is what was moved last.
    const wet = mix > 0 ? mix : clamp(wetLevel, 0, 1)
    const dry = mix > 0 ? 1 - mix : clamp(dryLevel, 0, 1)
    const spread = clamp(width, 0, 1)

    if (this.#native) {
      // The animated update may have moved any of these since the last block.
      this.#native.setParams(this.config.roomSize ?? 0, this.config.damping ?? 0, spread, wet, dry)
      this.#native.process(left, right, length)
      return
    }

    for (let i = 0; i < length; i += 1) {
      const input = (left[i] + right[i]) * 0.5 * INPUT_GAIN
      let outL = 0
      let outR = 0
      for (const comb of this.#left) outL += comb.run(input)
      for (const comb of this.#right) outR += comb.run(input)
      for (const allpass of this.#allpassL) outL = allpass.run(outL)
      for (const allpass of this.#allpassR) outR = allpass.run(outR)

      // Width crossfades between one shared tail and two independent ones.
      const mid = (outL + outR) * 0.5
      outL = outL * spread + mid * (1 - spread)
      outR = outR * spread + mid * (1 - spread)

      left[i] = left[i] * dry + outL * wet
      right[i] = right[i] * dry + outR * wet
    }
  }

  reset() {
    for (const comb of this.#left) comb.reset()
    for (const comb of this.#right) comb.reset()
    for (const allpass of this.#allpassL) allpass.reset()
    for (const allpass of this.#allpassR) allpass.reset()
    this.#native?.reset()
  }
}

export default ReverbFilter
