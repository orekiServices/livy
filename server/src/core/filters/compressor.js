import { BaseFilter } from './BaseFilter.js'
import { clamp, SAMPLE_RATE } from './constants.js'
import { fx } from '../../util/fx.js'

/**
 * Compressor — a soft-knee downward compressor with makeup gain.
 *
 * NodeLink's parameter names are kept, including the one that surprises
 * people: `threshold` runs 0…1 where **1 means no compression at all**, and
 * `ratio` is 1 (off) to 20. A station's defaults are therefore
 * `threshold: 1, ratio: 1` and the filter is skipped entirely until an owner
 * moves one of them.
 *
 * The detector is a peak follower with separate attack and release
 * coefficients, computed per block from the schema's 0…1 attack and 0…10
 * second release. Gain is applied in dB, not as a multiplier, because that is
 * the only way a 4:1 ratio means the same thing at every level.
 *
 * A soft knee of 6 dB is fixed rather than exposed: it is the difference
 * between a compressor and a limiter, and a station that wants a limiter sets
 * the ratio high and the attack fast.
 *
 * `gain` is input drive, applied *before* the detector, and `makeupGain` is
 * output gain. The distinction matters: driving the input makes the compressor
 * work harder (and is how a quiet source is pushed into the knee), while
 * makeup only restores what the detector took away. The old implementation
 * computed both and then ignored `gain`, so a payload with `gain: 2` sounded
 * exactly like `gain: 1`.
 */
const KNEE_DB = 6

export class CompressorFilter extends BaseFilter {
  static schema = {
    // NodeLink's units: threshold and makeup in dB, attack and release in
    // seconds. `ratio: 1` is the neutral state, so a station that has never
    // touched the compressor keeps the documented defaults and still hears
    // nothing compressed.
    threshold: { range: [-60, 0], default: -24, neutral: -60 },
    ratio: { range: [1, 20], default: 4, neutral: 1 },
    attack: { range: [0.001, 1], default: 0.01 },
    release: { range: [0.01, 10], default: 0.1 },
    gain: { range: [0, 5], default: 1 },
    makeupGain: { range: [-24, 24], default: 0 }
  }

  name = 'compressor'
  priority = 11

  #threshold
  #ratio
  #attackCoefficient
  #releaseCoefficient
  #attack = 0
  #release = 0
  #makeup
  #gain
  #envelope = 0
  #gainPerSample = 1
  #native = null
  #sampleRate

  constructor(config = {}, { sampleRate = SAMPLE_RATE } = {}) {
    super()
    this.#sampleRate = sampleRate
    this.#native = fx?.Compressor ? new fx.Compressor() : null
    this.update(config)
  }

  update(settings = {}) {
    const config = settings.compressor ?? settings
    const thresholdDb = clamp(config.threshold ?? -24, -60, 0)
    this.#threshold = 10 ** (thresholdDb / 20)
    this.#ratio = clamp(config.ratio ?? 4, 1, 20)
    this.#attack = clamp(config.attack ?? 0.01, 0.001, 1)
    this.#release = clamp(config.release ?? 0.1, 0.01, 10)
    this.#gain = clamp(config.gain ?? 1, 0, 5)
    this.#makeup = 10 ** (clamp(config.makeupGain ?? 0, -24, 24) / 20)

    // NodeLink's attack and release are already seconds, and their floors
    // (1 ms and 10 ms) are what stop the gain ramp from clicking.
    const attackSeconds = this.#attack
    const releaseSeconds = this.#release
    this.#attackCoefficient = Math.exp(-1 / (attackSeconds * this.#sampleRate))
    this.#releaseCoefficient = Math.exp(-1 / (releaseSeconds * this.#sampleRate))
    // One sample at a time, so the gain ramp is smooth across block edges.
    this.#gainPerSample = 1
    this.#native?.setParams(this.#threshold, this.#ratio, attackSeconds, releaseSeconds, this.#gain, this.#makeup, this.#sampleRate)
    return this
  }

  active() {
    return this.#threshold < 0.999 && this.#ratio > 1
  }

  /**
   * Gain reduction in dB for a given input level in dB.
   * The knee is quadratic between `threshold ± knee/2`.
   */
  #reduction(inputDb) {
    const thresholdDb = 20 * Math.log10(Math.max(1e-4, this.#threshold))
    const over = inputDb - thresholdDb
    if (over <= -KNEE_DB / 2) return 0
    if (over >= KNEE_DB / 2) return over * (1 - 1 / this.#ratio)
    const t = over + KNEE_DB / 2
    return ((1 - 1 / this.#ratio) * t * t) / (2 * KNEE_DB)
  }

  process(left, right, length) {
    if (!this.active()) return
    if (this.#native) {
      this.#native.process(left, right, length)
      return
    }
    const attack = this.#attackCoefficient
    const release = this.#releaseCoefficient
    const drive = this.#gain
    const makeup = this.#makeup

    for (let i = 0; i < length; i += 1) {
      const drivenLeft = left[i] * drive
      const drivenRight = right[i] * drive
      const peak = Math.max(Math.abs(drivenLeft), Math.abs(drivenRight))
      // Peak follower: fast up, slow down, never negative.
      const coefficient = peak > this.#envelope ? attack : release
      this.#envelope = peak + coefficient * (this.#envelope - peak)

      const levelDb = 20 * Math.log10(Math.max(1e-5, this.#envelope))
      const reductionDb = this.#reduction(levelDb)
      const target = Math.pow(10, -reductionDb / 20)

      // Smooth the *gain* too, or a detector that moves in one sample steps
      // the gain and the compressor becomes a distortion pedal.
      const smoothed = target + coefficient * (this.#gainPerSample - target)
      this.#gainPerSample = smoothed

      const gain = smoothed * makeup
      left[i] = clamp(drivenLeft * gain, -1, 1)
      right[i] = clamp(drivenRight * gain, -1, 1)
    }
  }

  reset() {
    this.#envelope = 0
    this.#gainPerSample = 1
    this.#native?.reset()
  }
}

export default CompressorFilter
