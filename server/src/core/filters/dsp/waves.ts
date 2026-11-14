/**
 * Waveform generators for LFOs.
 *
 * A table of functions rather than a `switch` in the LFO loop: the branch is
 * hoisted out of the per-sample path, which is the only place it could ever
 * matter. Phase is in radians, so every generator has the same period and a
 * `sin`-based and a `triangle`-based modulation stay in step if swapped.
 */

const TWO_PI = 2 * Math.PI

export const Waveforms = {
  sine: (phase) => Math.sin(phase),
  triangle: (phase) => {
    const x = ((phase % TWO_PI) + TWO_PI) % TWO_PI
    const unit = x / TWO_PI
    return 2 * (unit < 0.5 ? 2 * unit : 2 - 2 * unit) - 1
  },
  square: (phase) => ((((phase % TWO_PI) + TWO_PI) % TWO_PI) < Math.PI ? 1 : -1),
  sawtooth: (phase) => ((((phase % TWO_PI) + TWO_PI) % TWO_PI) / Math.PI) - 1
}

/** Waveform names, for the schema and for the console's dropdowns. */
export const WAVEFORM_NAMES = Object.keys(Waveforms)

/**
 * Resolve a waveform by name, case-insensitively, falling back to sine.
 *
 * NodeLink spells them `'SINE'`, `'SQUARE'`, `'SAWTOOTH'`, `'TRIANGLE'`; a
 * console written by hand spells them however the person typing felt. Both
 * work, because a filter that throws on `'Sine'` is a filter nobody uses.
 */
export function waveform(name = 'sine') {
  const key = String(name).toLowerCase()
  return Waveforms[key] ?? Waveforms.sine
}

export default Waveforms
