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

/**
 * Equaliser gain range, in multipliers: 0 is a cut to silence, 1 is flat,
 * 2 is +6 dB. NodeLink's request gain is an offset from flat clamped to
 * [0, 2] after adding the unity multiplier, so the payload's own range is
 * [-1, 1]; the equaliser converts at the edge.
 */
export const EQ_GAIN = { min: 0, max: 2, neutral: 1 }

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
  // `neutral` is the "never configured" value, `default` is "on with no
  // parameters". They differ: NodeLink's karaoke defaults to level 1, which is
  // right for `{karaoke: true}` and wrong for a station that never asked.
  // Arrays are copied: `neutralSettings()` is handed to every station, and a
  // shared empty array would be a bug waiting for the first caller that pushes.
  if (spec?.array) return []
  if (spec?.neutral !== undefined) return Array.isArray(spec.neutral) ? [...spec.neutral] : spec.neutral
  if (spec?.default !== undefined) return Array.isArray(spec.default) ? [...spec.default] : spec.default
  if (spec?.range) return spec.range[0] === 1 ? 1 : 0
  if (spec?.list) return []
  return 0
}
