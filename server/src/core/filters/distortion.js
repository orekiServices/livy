import { AnimatableFilter } from './AnimatableFilter.js'
import { Biquad } from './dsp/biquad.js'
import { clampSample, softClip } from './dsp/clamp.js'
import { clamp, SAMPLE_RATE } from './constants.js'
import { fx } from '../../util/fx.js'

/** Four times the stream rate: enough headroom for the harmonics a shaper makes. */
const OVERSAMPLE = 4

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
 * **Oversampling.** A waveshaper is a harmonic generator, and at 44.1 kHz the
 * harmonics above Nyquist fold back into the audible band as inharmonic
 * whistling — the reason a cheap distortion sounds gritty rather than warm.
 * The shaper runs at 4× the stream rate and a Butterworth low-pass at 0.45×
 * the stream rate sits before decimation, so the harmonics are filtered where
 * they belong instead of aliasing back. Linear interpolation is enough on the
 * way up; the post-filter is what does the work on the way down. The native
 * MetroFX kernel implements the same topology.
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

  #lowpassL
  #lowpassR
  #previousL = 0
  #previousR = 0
  #native = null
  #sampleRate

  constructor(config = {}, { sampleRate = SAMPLE_RATE } = {}) {
    super()
    // Anti-imaging/anti-aliasing at the oversampled rate. 0.45× the *stream*
    // rate leaves a little room below its Nyquist; running the biquad at 4×
    // keeps its own warping and phase well away from the audio band.
    this.#lowpassL = new Biquad().lowpass(sampleRate * 0.45, sampleRate * OVERSAMPLE)
    this.#lowpassR = new Biquad().lowpass(sampleRate * 0.45, sampleRate * OVERSAMPLE)
    this.#sampleRate = sampleRate
    this.#native = fx?.Distortion ? new fx.Distortion(sampleRate, OVERSAMPLE) : null
    this.update(config)
  }

  update(settings = {}) {
    this.applyAnimatedUpdate(settings, DistortionFilter.schema, {
      coerce: (key, value) => clamp(value, key.endsWith('Offset') || key === 'offset' ? -1 : 0, 3)
    })
    this.#syncNative()
    return this
  }

  #syncNative() {
    if (!this.#native) return
    const c = this.config
    this.#native.setParams(
      c.sinOffset ?? 0,
      c.sinScale ?? 1,
      c.cosOffset ?? 0,
      c.cosScale ?? 1,
      c.tanOffset ?? 0,
      c.tanScale ?? 1,
      c.offset ?? 0,
      c.scale ?? 1
    )
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
    if (this.#native) {
      // Animation can change the knobs every block; keep the kernel in step.
      this.#syncNative()
      this.#native.process(left, right, length)
      return
    }
    const { sinOffset, sinScale, cosOffset, cosScale, tanOffset, tanScale, offset, scale } = this.config

    // Precompute the branches; a per-sample `if` on eight values is the
    // difference between one waveshape table lookup and nine comparisons.
    const sin = sinOffset !== 0 || sinScale !== 1
    const cos = cosOffset !== 0 || cosScale !== 1
    const tan = tanOffset !== 0 || tanScale !== 1

    const shape = (input) => {
      let x = input
      if (sin) x = Math.sin(x * sinScale + sinOffset)
      if (cos) x = Math.cos(x * cosScale + cosOffset)
      if (tan) x = Math.tanh(x * tanScale + tanOffset)
      x = x * scale + offset
      // The shaper's own output can exceed full scale (`cos` is ±1 before
      // `scale`), so the last thing every distortion does is soft-clip.
      return softClip(x)
    }

    for (let i = 0; i < length; i += 1) {
      const targetL = left[i]
      const targetR = right[i]
      let outL = this.#previousL
      let outR = this.#previousR
      for (let step = 1; step <= OVERSAMPLE; step += 1) {
        const t = step / OVERSAMPLE
        // Linear interpolation is a coarse upsampler, but the filter below is
        // what removes what the extra images and the shaper put above Nyquist.
        outL = this.#lowpassL.run(shape(this.#previousL + (targetL - this.#previousL) * t))
        outR = this.#lowpassR.run(shape(this.#previousR + (targetR - this.#previousR) * t))
      }
      this.#previousL = targetL
      this.#previousR = targetR
      left[i] = clampSample(outL)
      right[i] = clampSample(outR)
    }
  }

  reset() {
    this.#lowpassL.reset()
    this.#lowpassR.reset()
    this.#previousL = 0
    this.#previousR = 0
    this.#native?.reset()
  }
}

export default DistortionFilter
