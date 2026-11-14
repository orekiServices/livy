/**
 * Base class for every station filter.
 *
 * The contract is deliberately four methods long, and each one has a job:
 *
 *   `process(left, right, length)`  in-place audio, per block
 *   `update(settings)`              a new configuration arrived
 *   `flush()`                       any tail this filter still holds, on clear
 *   `reset()`                       start over with no state (new track)
 *
 * NodeLink adds `priority` — lower runs first — and that is here too, because
 * the order genuinely matters: a compressor after the reverb is a different
 * sound from a compressor before it, and an equaliser after a distortion is
 * the only place a tone control does anything.
 *
 * Everything is in-place Float32 for the reason the chain exists at all: a
 * block is 250 ms and is decoded and re-encoded once per pass, so an
 * allocation per block per filter is 45 000 allocations an hour per station.
 */
export class BaseFilter {
  /**
   * Lower runs earlier. The gaps are deliberate, so a new filter can slot in
   * without renumbering: 1–4 are structural, 5–9 are shaping, 10 is the
   * modulation and time-based family, 11+ are dynamics and nonlinearity.
   */
  priority = 10

  /** The key this filter reads from the payload (`equalizer`, `echo`, …). */
  name = 'base'

  /** The payload key that feeds this instance; differs for the EQ's single band. */
  payloadKey = null

  /**
   * @param {Float32Array} left
   * @param {Float32Array} right
   * @param {number} length
   */
  // eslint-disable-next-line no-unused-vars
  process(left, right, length) {
    throw new Error(`${this.name}: process() is not implemented`)
  }

  /** Apply a new configuration. Cheap: a chain update must not stall audio. */
  // eslint-disable-next-line no-unused-vars
  update(settings) {}

  /** Is this filter doing anything? An inactive filter is skipped entirely. */
  isActive() {
    return true
  }

  /**
   * A filter whose effect is *not* block-local.
   *
   * `timescale` changes the length of the material, so it cannot run inside a
   * block loop; the chain reports it and the caller renders the whole segment
   * through a stretcher. Everything else is local and runs per block.
   */
  get stream() {
    return false
  }

  /** Release any buffered tail (end of track, chain replaced). */
  flush() {
    return null
  }

  reset() {}

  destroy() {}
}

export default BaseFilter
