/**
 * Audio filter presets -> Lavalink v4 `filters` object.
 *
 * NodeLink implements the Lavalink v4 filter set (equalizer, timescale,
 * rotation, tremolo, vibrato, karaoke, distortion, channelMix, lowPass,
 * volume). Note the v4 spelling `lowPass` — v3 used `lowpass`.
 * Presets only use fields NodeLink supports by default.
 */
const eq = (bands) => bands.map(([band, gain]) => ({ band, gain }));

export const FILTER_PRESETS = {
  off: {},
  bassboost: {
    equalizer: eq([[0, 0.2], [1, 0.15], [2, 0.1], [3, 0.05]]),
  },
  treble: {
    equalizer: eq([[12, 0.15], [13, 0.12], [14, 0.1], [15, 0.08]]),
  },
  vocal: {
    equalizer: eq([[2, 0.1], [3, 0.15], [4, 0.2], [5, 0.15], [6, 0.1]]),
  },
  pop: {
    equalizer: eq([[0, -0.05], [1, 0.05], [2, 0.1], [3, 0.15], [4, 0.2], [5, 0.15], [6, 0.05]]),
  },
  soft: {
    equalizer: eq([[0, -0.1], [1, -0.05], [2, 0.05], [3, 0.1]]),
    lowPass: 0.6,
  },
  lofi: {
    equalizer: eq([[0, 0.1], [1, 0.05], [13, -0.1], [14, -0.15], [15, -0.2]]),
    lowPass: 0.7,
    tremolo: { frequency: 4, depth: 0.3 },
  },
  nightcore: {
    timescale: { speed: 1.25, pitch: 1.25, rate: 1 },
  },
  vaporwave: {
    timescale: { speed: 0.85, pitch: 0.85, rate: 1 },
    tremolo: { frequency: 3, depth: 0.4 },
  },
  '8d': {
    rotation: { rotationHz: 0.2 },
  },
  echo: {
    // NodeLink echo is exposed via the `echo` filter in newer builds;
    // fall back to a gentle tremolo+rotation combo on older ones.
    tremolo: { frequency: 2, depth: 0.5 },
    rotation: { rotationHz: 0.1 },
  },
  karaoke: {
    karaoke: { level: 1.0, monoLevel: 1.0, filterBand: 220.0, filterWidth: 100.0 },
  },
  chipmunk: {
    timescale: { speed: 1.4, pitch: 1.4, rate: 1 },
  },
  demon: {
    timescale: { speed: 0.7, pitch: 0.7, rate: 1 },
    distortion: { distortion: 0.4 },
  },
};

export const FILTER_NAMES = Object.keys(FILTER_PRESETS);

/** Resolve a preset name (case-insensitive) to its filters object, or null. */
export function resolveFilter(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  return Object.hasOwn(FILTER_PRESETS, key) ? FILTER_PRESETS[key] : null;
}
