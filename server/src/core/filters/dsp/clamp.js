/**
 * Sample-domain clamping helpers.
 *
 * NodeLink works in signed 16-bit integers and clamps to [-32768, 32767].
 * Livy's chain works in Float32 and clamps to [-1, 1] — the same operation in
 * the units the encoder actually wants, one multiply away from 16-bit at the
 * boundary. Both are here so a filter can be written in either convention
 * without inventing its own `Math.max`.
 */

/** Clamp a float sample to full scale. */
export const clampSample = (sample) => (sample > 1 ? 1 : sample < -1 ? -1 : sample)

/** NodeLink's 16-bit clamp, kept for payload compatibility and tests. */
export const clamp16Bit = (sample) => Math.max(-32_768, Math.min(32_767, Math.round(sample)))

/**
 * Soft clip with `tanh` at unity, normalised so that ±1 maps to ±1.
 *
 * The nonlinear filters (distortion, phonograph's valve stage) need a limiter
 * that does not sound like a limiter: `tanh` starts bending well before it
 * reaches full scale, which is what a saturated transformer does, whereas a
 * hard clamp on the same signal is a click.
 */
export function softClip(sample) {
  return Math.tanh(sample * 1.1) / Math.tanh(1.1)
}

export default clampSample
