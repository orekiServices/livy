import { BaseFilter } from './BaseFilter.js'
import { clamp } from './constants.js'

/**
 * Timescale — speed, pitch and rate, the three knobs a DJ booth has.
 *
 * This is the one filter that *cannot* run per block: it changes how long the
 * material is, and a 250 ms block stretched by 1.1 is 227 ms, which no chain
 * of fixed-length blocks can express. The chain therefore reports it through
 * `streamRequest` and the station renders the whole segment through the
 * stretcher instead (see `renderWithStretch`).
 *
 * The three knobs compose the way a turntable's do:
 *
 *   tempo = speed × rate     how fast the track plays
 *   pitch = speed × pitch    how high it sounds
 *
 * so `speed` alone is a tape-speed change (both move together), `rate` alone
 * is a tempo change at constant pitch, and `pitch` alone shifts the key
 * without touching the beat — which is what pitch-matching two records
 * actually needs.
 */
export class TimescaleFilter extends BaseFilter {
  static schema = {
    speed: { range: [0.25, 4], default: 1 },
    pitch: { range: [0.25, 4], default: 1 },
    rate: { range: [0.25, 4], default: 1 }
  }

  name = 'timescale'
  priority = 1
  stream = true

  constructor(config = {}) {
    super()
    this.speed = clamp(config.speed ?? 1, 0.25, 4)
    this.pitch = clamp(config.pitch ?? 1, 0.25, 4)
    this.rate = clamp(config.rate ?? 1, 0.25, 4)
  }

  update(settings = {}) {
    const config = settings.timescale ?? settings
    this.speed = clamp(config.speed ?? this.speed, 0.25, 4)
    this.pitch = clamp(config.pitch ?? this.pitch, 0.25, 4)
    this.rate = clamp(config.rate ?? this.rate, 0.25, 4)
    return this
  }

  /** Tempo factor: what the beat does. */
  get tempo() {
    return this.speed * this.rate
  }

  /** Pitch factor: what the key does. */
  get key() {
    return this.speed * this.pitch
  }

  /**
   * Engaged when *any* of the three knobs moved.
   *
   * Checking `tempo !== 1 || key !== 1` would look equivalent and is not:
   * `speed: 1.05, rate: 0.952` is a pitch change at constant tempo, and the
   * chain has to know about it so `renderWithStretch` can resample.
   */
  isActive() {
    return (
      Math.abs(this.speed - 1) > 1e-4 || Math.abs(this.pitch - 1) > 1e-4 || Math.abs(this.rate - 1) > 1e-4
    )
  }

  process() {
    throw new Error('timescale: stream-level, render the segment through renderWithStretch()')
  }
}

export default TimescaleFilter
