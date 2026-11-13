/**
 * Shared constants for the filter folder.
 *
 * Kept out of any one filter because the equaliser, the schema and the REST
 * description all need to agree on the band list, and three copies of it is
 * how a band quietly stops being adjustable.
 */

export const SAMPLE_RATE = 44_100

/**
 * Equaliser centres, in Hz — NodeLink's fifteen bands, same list, same order,
 * so `{ band: 3, gain: 0.25 }` means 100 Hz here exactly as it does there.
 */
export const EQ_BANDS = [25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10_000, 16_000]

/** Equaliser gain range: 0 is a cut to silence, 1 is flat, 3 is +9.5 dB. */
export const EQ_GAIN = { min: 0, max: 3, neutral: 1 }

/** Clamp a number, the one helper every filter needs. */
export const clamp = (value, min, max) => (value < min ? min : value > max ? max : value)

/** A finite number or a fallback — filter configs arrive from JSON. */
export const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)

/**
 * A schema entry's neutral value: its default, else the bottom of its range.
 *
 * Lives here rather than in `schema.js` because `AnimatableFilter` needs it
 * and `schema.js` imports the registry, which imports every filter — a cycle
 * that ESM resolves by handing one side an uninitialised binding.
 */
export function neutralValue(spec) {
  if (spec?.default !== undefined) return spec.default
  if (spec?.range) return spec.range[0] === 1 ? 1 : 0
  if (spec?.list) return []
  return 0
}
