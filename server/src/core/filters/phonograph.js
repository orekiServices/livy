import { AnimatableFilter } from './AnimatableFilter.js'
import { FractionalDelay } from './dsp/delay.js'
import { Lfo } from './dsp/lfo.js'
import { clampSample } from './dsp/clamp.js'
import { clamp, SAMPLE_RATE } from './constants.js'

/**
 * Phonograph — wow, flutter, crackle, surface noise, room and microphone AGC.
 *
 * The nostalgic one. NodeLink models a record player end to end; the parts
 * that survive translation to a streaming filter are:
 *
 *   • **wow** — a slow pitch wobble (0.8 Hz default), a long vibrato swing;
 *   • **flutter** — a fast, shallow jitter at ~11 Hz, the capstan's own
 *     frequency, which is what makes a pressing sound *worn* rather than
 *     *detuned*;
 *   • **crackle** — a sparse impulse train with a decaying tail, not white
 *     noise: a record crackles, it does not hiss;
 *   • **room** — two short, differently-timed taps;
 *   • **micAgc** — a slow leveler, so a quiet pressing comes up;
 *   • **drive** — gentle valve saturation.
 *
 * The noise source is a seeded xorshift, so the same settings produce the same
 * crackle on every render and a test can assert on it. That determinism is
 * also why it is safe to run per block: no state depends on where a block
 * boundary fell.
 */
export class PhonographFilter extends AnimatableFilter {
  static schema = {
    frequency: { range: [0, 4], default: 0.8 },
    depth: { range: [0, 1], default: 0.25 },
    crackle: { range: [0, 1], default: 0.18 },
    flutter: { range: [0, 1], default: 0.18 },
    room: { range: [0, 1], default: 0.22 },
    micAgc: { range: [0, 1], default: 0.25 },
    drive: { range: [0, 1], default: 0.25 }
  }

  name = 'phonograph'
  priority = 14

  #sampleRate
  #wow = new Lfo('sine')
  #flutter = new Lfo('sine')
  #left
  #right
  #roomL
  #roomR
  #state = 0xc0ffee
  #envelope = 0

  constructor(config = {}, { sampleRate = SAMPLE_RATE, seed = 0xc0ffee } = {}) {
    super()
    this.#sampleRate = sampleRate
    this.#state = seed >>> 0
    const wowSamples = Math.ceil((sampleRate * 30) / 1000)
    this.#left = new FractionalDelay(wowSamples)
    this.#right = new FractionalDelay(wowSamples)
    this.#roomL = new FractionalDelay(Math.ceil((sampleRate * 200) / 1000))
    this.#roomR = new FractionalDelay(Math.ceil((sampleRate * 240) / 1000))
    this.update(config)
  }

  update(settings = {}) {
    this.applyAnimatedUpdate(settings, PhonographFilter.schema, { coerce: (key, value) => clamp(value, 0, key === 'frequency' ? 4 : 1) })
    return this
  }

  /** xorshift32 — same numbers on every run, no table to ship. */
  #random() {
    let x = this.#state
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    this.#state = x
    return (x / 0xffff_ffff) * 2 - 1
  }

  /**
   * "On" is not the same as "neutral" for this filter: a record player with no
   * wow, flutter or crackle is a record player that is switched off, so any of
   * the six character knobs engages it.
   */
  active() {
    return ['crackle', 'flutter', 'room', 'micAgc', 'drive', 'depth'].some((key) => (this.config[key] ?? 0) > 0.001)
  }

  process(left, right, length) {
    this.processAnimation(length)
    if (!this.active()) return
    const { frequency, depth, crackle, flutter, room, micAgc, drive } = this.config

    const baseDelay = 0.003 * this.#sampleRate
    const wowSwing = depth * 0.0025 * this.#sampleRate
    const flutterSwing = flutter * 0.0004 * this.#sampleRate
    const roomDelayL = (room * 60 + 20) * (this.#sampleRate / 1000)
    const roomDelayR = (room * 70 + 25) * (this.#sampleRate / 1000)

    for (let i = 0; i < length; i += 1) {
      const mod =
        this.#wow.getValue(frequency, this.#sampleRate) * wowSwing +
        this.#flutter.getValue(11.3, this.#sampleRate) * flutterSwing

      this.#left.push(left[i])
      this.#right.push(right[i])
      let l = this.#left.read(baseDelay + mod + wowSwing)
      let r = this.#right.read(baseDelay + mod + wowSwing)

      // Surface crackle: a sparse impulse, tailed by the room taps below.
      if (crackle > 0 && Math.abs(this.#random()) < crackle * 0.0016) {
        const pop = this.#random() * crackle * 0.5
        l += pop
        r += pop * 0.8
      }
      // A quiet continuous floor, the needle in the groove.
      if (crackle > 0) {
        const floor = this.#random() * crackle * 0.006
        l += floor
        r += floor * 0.9
      }

      // Valve drive.
      if (drive > 0) {
        const gain = 1 + drive * 6
        l = Math.tanh(l * gain) / Math.tanh(gain)
        r = Math.tanh(r * gain) / Math.tanh(gain)
      }

      // Room: two short, differently-timed taps.
      this.#roomL.push(l)
      this.#roomR.push(r)
      l = l * (1 - room * 0.4) + this.#roomL.read(roomDelayL) * room * 0.4
      r = r * (1 - room * 0.4) + this.#roomR.read(roomDelayR) * room * 0.4

      // Microphone AGC: a slow leveler. The correction is bounded hard on the
      // way *up* — a phonograph stage that can double a quiet passage is also
      // a phonograph stage that turns the needle drop into a gunshot.
      if (micAgc > 0) {
        const peak = Math.max(Math.abs(l), Math.abs(r))
        this.#envelope = this.#envelope * 0.9995 + peak * 0.0005
        const correction = clamp(0.25 / Math.max(1e-4, this.#envelope), 0.6, 1.6)
        const gain = 1 + (correction - 1) * micAgc
        l *= gain
        r *= gain
      }

      // Soft clip last, and on the loudest channel: the output stage sees the
      // signal the preamp boosted, and a figure-of-eight record player should
      // saturate both grooves equally rather than widen.
      const loudest = Math.max(Math.abs(l), Math.abs(r))
      const scale = loudest > 0.8 ? Math.tanh(loudest * 1.1) / Math.tanh(1.1) / loudest : 1
      left[i] = clampSample(l * scale)
      right[i] = clampSample(r * scale)
    }
  }

  reset() {
    this.#wow.reset()
    this.#flutter.reset()
    this.#left.clear()
    this.#right.clear()
    this.#roomL.clear()
    this.#roomR.clear()
    this.#envelope = 0
  }
}

export default PhonographFilter
