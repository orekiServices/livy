import { AnimatableFilter } from './AnimatableFilter.ts'
import { Biquad } from './dsp/biquad.ts'
import { fx } from '../../util/fx.ts'
import { clamp, EQ_BANDS, EQ_GAIN, SAMPLE_RATE } from './constants.ts'

/**
 * The fifteen-band equaliser.
 *
 * One peaking biquad per band per channel, all bypassed when flat — a station
 * that has never touched the EQ should not pay for 30 biquads on every sample.
 *
 * `gain` is an **offset from flat**, which is NodeLink's convention: their
 * payload gain is added to a unity multiplier and clamped to [0, 2]. So
 * `{ band: 5, gain: 0.5 }` is a +3.5 dB lift at 250 Hz and `gain: -1` is a
 * kill. Internally the class keeps the multiplier (`1 + gain`), because that is
 * what the biquad wants; only the edge speaks offsets.
 *
 * Q is 1.41 — a little over an octave per band, which with these fifteen
 * centres leaves no holes between them and no more overlap than a third of an
 * octave, so moving one fader moves one region. It is also what NodeLink uses,
 * so a preset carried over sounds the same.
 *
 * `equalizerStandalone` reuses this class with a single band, which is why the
 * constructor reads `settingsKey` rather than hard-coding `'equalizer'`.
 */
export class EqualizerFilter extends AnimatableFilter {
  static schema = {
    bands: { list: { band: { range: [0, EQ_BANDS.length - 1], integer: true }, gain: { range: [-1, 1] } } }
  }

  /** A single band, for automation and for a console's fader strip. */
  static standaloneSchema = {
    band: { range: [0, EQ_BANDS.length - 1], integer: true },
    gain: { range: [-1, 1], default: 0 }
  }

  name = 'equalizer'
  priority = 5

  #gains = new Float32Array(EQ_BANDS.length).fill(EQ_GAIN.neutral)
  #bands = []
  #native = null
  #sampleRate
  #single
  #key

  constructor(config: any = {}, { sampleRate = SAMPLE_RATE, single = false, key = 'equalizer' }: any = {}) {
    super()
    this.#sampleRate = sampleRate
    this.#single = single
    this.#key = key
    if (single) {
      this.name = 'equalizerStandalone'
      this.priority = 6
    }
    this.#bands = EQ_BANDS.map((frequency, channel) => ({
      frequency,
      channel,
      left: new Biquad(),
      right: new Biquad()
    }))
    // One native section per band: it holds both channels, so the block loop
    // crosses FFI once per band instead of once per channel.
    this.#native = fx?.Biquad ? EQ_BANDS.map(() => new fx.Biquad()) : null
    this.update(config)
  }

  /** The current band multipliers, 1 = flat. */
  get gains() {
    return [...this.#gains]
  }

  update(settings: any = {}) {
    const config = this.#single
      ? { bands: [{ band: settings.band ?? settings[this.#key]?.band ?? 0, gain: settings.gain ?? settings[this.#key]?.gain ?? 0 }] }
      : (settings[this.#key] ?? settings)

    const requested = new Float32Array(EQ_BANDS.length).fill(EQ_GAIN.neutral)
    for (const band of config?.bands ?? []) {
      const index = clamp(Math.round(Number(band.band) || 0), 0, EQ_BANDS.length - 1)
      // NodeLink: multiplier = 1 + gain, clamped to [0, 2]. A band at -1 is a
      // kill rather than a phase inversion, which is why the floor is zero.
      const offset = Number(band.gain ?? 0)
      requested[index] = clamp(1 + (Number.isFinite(offset) ? offset : 0), EQ_GAIN.min, EQ_GAIN.max)
    }

    // Retune only the bands that moved: a biquad recompute is a handful of
    // trig calls, and a console that streams a fader generates a lot of them.
    for (let index = 0; index < EQ_BANDS.length; index += 1) {
      if (requested[index] === this.#gains[index]) continue
      this.#gains[index] = requested[index]
      const band = this.#bands[index]
      if (this.#gains[index] === EQ_GAIN.neutral) {
        band.left.reset()
        band.right.reset()
        this.#native?.[index]?.reset()
        continue
      }
      band.left.peaking(band.frequency, gainToDb(this.#gains[index]), this.#sampleRate)
      band.right.copyCoefficients(band.left)
      this.#native?.[index]?.setPeaking(band.frequency, gainToDb(this.#gains[index]), this.#sampleRate, 1.41)
    }
    return this
  }

  active() {
    return this.#gains.some((gain) => Math.abs(gain - EQ_GAIN.neutral) > 1e-3)
  }

  process(left, right, length) {
    // A block whose bands are all flat is the common case on a station with
    // one band lifted three tracks ago and none now: skip the loop entirely.
    if (!this.active()) return
    for (const band of this.#bands) {
      if (Math.abs(this.#gains[band.channel] - EQ_GAIN.neutral) < 1e-3) continue
      const native = this.#native?.[band.channel]
      if (native) {
        native.process(left, right, length)
        continue
      }
      for (let i = 0; i < length; i += 1) {
        left[i] = band.left.run(left[i])
        right[i] = band.right.run(right[i])
      }
    }
  }

  reset() {
    for (const band of this.#bands) {
      band.left.reset()
      band.right.reset()
    }
    for (const native of this.#native ?? []) native.reset()
  }
}

/**
 * Multiplier to decibels.
 *
 * The multiplier spans 0…2 — offset −1 is a kill, 1 is unity and 2 is
 * +6 dB — a gain of 10^(db/20) inverted, with the floor at −40 dB rather than
 * −∞ so a "killed" band does not produce `-Infinity` coefficients.
 */
export function gainToDb(gain) {
  if (gain <= 0) return -40
  return 20 * Math.log10(gain)
}

export default EqualizerFilter
