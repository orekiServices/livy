/**
 * Transition names, the auto sentinel, and every default the engine reads.
 */
/** Livy's only supported Automix transition. */
export const EFFECTS = Object.freeze(['crossfade'])
export const BUILT_IN_EFFECTS = new Set(EFFECTS)

/**
 * `auto` is a backwards-compatible setting sentinel. Both `auto` and
 * `crossfade` render the same crossfade; `auto` can never select another effect.
 */
export const AUTO_EFFECT = 'auto'

export const DEFAULT_AUTOMIX = {
  enabled: true,
  crossfadeMs: 6000, // requested blend length (the analysis may shorten it)
  // Smart Automix: let the seam decide how long the blend should be, within
  // these bounds. Two club tracks in key can hold a thirty second blend; a
  // ballad into a rap record cannot. Off → `crossfadeMs` every time.
  smart: true,
  minCrossfadeMs: 2000,
  maxCrossfadeMs: 30_000,
  holdMs: 12_000, // outgoing tail retained for smart crossfades
  landingMs: 2500, // incoming-only landing before untouched MP3 frames resume
  curve: 'auto', // 'auto' (correlation decides) | 'equal-power' | 'equal-gain'
  // Retained for configuration compatibility; both values render a crossfade.
  effect: 'auto',
  minTrackMs: 20_000, // shorter items are aired untouched
  // Ceiling on one rendered segment. Long blends need room for the blend
  // *and* the tail on either side; the DSP that made this expensive is now
  // in Rust, so the limit is memory, not time.
  maxRenderMs: 90_000,
  bitrate: 128,
  targetLufs: -16, // seam-local loudness match target
  maxGainDb: 6, // never push a song more than this to match
  ceilingDb: -1, // peak ceiling of the rendered seam
  beatAlign: true, // land the incoming song on a beat
  beatmatch: true, // time-stretch the outgoing song to the incoming tempo
  maxStretchPercent: 12, // never stretch further than this to match
  // Legacy effect-classifier switch retained for persisted-config compatibility.
  // Automix no longer consults an effect model; crossfade is the only renderer.
  model: false,
  cueTolerance: 0.6, // a cue further than this fraction of a beat is not snapped
  tempoReleaseMs: 4000, // how long the incoming track takes to return to native tempo
  vocalAware: true, // wait for the outgoing vocal line, duck when both sing
  phraseBlend: true, // snap the blend length to whole 4-beat phrases
  crossoverHz: 200, // bass-swap low crossover
  highCrossoverHz: 3600, // 3-band Linkwitz-Riley high crossover
  // Structural analysis may explain a crossfade, but cannot change its renderer.
  intelligent: true,
  // Retired model-rendering switches; kept false for old config compatibility.
  continuousBlend: false,
  neuralAutomix: false,
  progressiveScaling: false,
  minQualityScore: 0.5,
  trimSilence: true,
  dj: {
    enabled: true,
    name: 'Ava',
    every: 3, // talk over every Nth transition
    duckDb: -9, // how far the bed drops under the voice
    thresholdDb: -32, // sidechain threshold
    ratio: 12,
    attackMs: 80,
    releaseMs: 600,
    leadInMs: 700,
    tailMs: 900,
    bedHighpassHz: 180, // clear the voice band in the bed while talking
    voiceTargetLufs: -14
  }
}

