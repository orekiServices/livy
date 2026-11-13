/**
 * Transition names, the auto sentinel, and every default the engine reads.
 */
/**
 * Transitions the node can render. The seven built-ins are always present;
 * plugins append to this list with `registerEffect()` (see src/core/plugins.js),
 * which is why it is a live array rather than a frozen constant.
 */
export const EFFECTS = ['crossfade', 'bass-swap', 'filter', 'echo', 'sweep', 'spindown', 'slam', 'wash', 'roll', 'drop']
export const BUILT_IN_EFFECTS = new Set(EFFECTS)

/**
 * `auto` is not a renderer: it is the instruction "you choose", and the
 * choice is made per seam by `chooseEffect()` below. It sits outside
 * `EFFECTS` so plugins cannot shadow it and `registerEffect` cannot remove it.
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
  curve: 'auto', // 'auto' (correlation decides) | 'equal-power' | 'equal-gain'
  // 'auto' lets the mix pick a transition per seam from what the two songs
  // are actually doing; name one to use it every time.
  effect: 'auto',
  // When picking automatically, only choose from these (empty = all of them).
  effectPool: [],
  // Never play the same transition twice in a row — a station that always
  // does the same trick stops sounding like a DJ after ten minutes.
  varyEffects: true,
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
  // Seam analysis, after automix-engine: choose a tempo *pair* rather than two
  // independent tempos, snap cues to the beat grid, and release the tempo back
  // to native over a fixed window instead of switching at the seam.
  analysePair: true,
  // The learned DJ policy, when one is in models/. `false` pins the heuristic,
  // which is what a station owner who wants predictable sets will choose.
  model: true,
  cueTolerance: 0.6, // a cue further than this fraction of a beat is not snapped
  tempoReleaseMs: 4000, // how long the incoming track takes to return to native tempo
  vocalAware: true, // wait for the outgoing vocal line, duck when both sing
  phraseBlend: true, // snap the blend length to whole 4-beat phrases
  crossoverHz: 200, // bass-swap crossover
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

