/**
 * Automix — transitions the way playout systems and DJs actually do them.
 *
 * The station reader runs one crossfade behind itself: the tail of the
 * outgoing song is held back instead of aired, and when the next song starts
 * arriving both ends are decoded, analysed, mixed and re-encoded into one
 * seamless MP3 segment that goes on air in place of the seam.
 *
 * What the analysis pass does before a single sample is mixed (this is the
 * part a naive "fade out / fade in" gets wrong):
 *
 *  1. **Loudness** — ITU-R BS.1770 gated loudness of both ends, and the
 *     incoming song is gain-matched to the outgoing one for the duration of
 *     the seam, then eased back to its own level. No jump at the join.
 *  2. **Cue points** — 50 ms RMS windows give cue-in / cue-out / overlay, so
 *     the blend happens over audio, never over the digital silence at the
 *     head or tail of a file, and a long fade-out is not chopped in half.
 *  3. **Correlation** — the crossfade law is chosen from the measured
 *     correlation of the two ends: equal-gain for correlated material,
 *     equal-power for uncorrelated, interpolating aˣ + bˣ = 1 in between.
 *  4. **Beat grid + beatmatch** — spectral-flux onsets + autocorrelation give
 *     tempo and phase; the outgoing song is then time-stretched (WSOLA, pitch
 *     untouched) so it *ends at the incoming song's tempo*, the two grids are
 *     phase-locked, and the blend length is quantised to whole beats (a phrase
 *     when one fits). The incoming song is never touched, so nothing drifts
 *     after the seam.
 *  5. **Peak ceiling** — the rendered seam is held at or below −1 dBFS.
 *
 * Then one of the transition effects runs, and the DJ (if it is their turn)
 * is mixed over the top with a real sidechain ducker.
 *
 * No ffmpeg, ever: MetroS decodes (natively via libmetro when a binary is
 * there, WASM mpg123 when it is not), lamejs re-encodes and `core/dsp.js`
 * does the signal processing. If no decoder is available at all the automix
 * degrades to pass-through and the station keeps broadcasting.
 */
import { createHash } from 'node:crypto'
import { MetroFramer, decodeMp3 as metroDecode, encodeMp3 as metroEncode, analyseBeat, stretchAudio } from '../util/metro.js'
import createLogger from '../util/logger.js'
import { djLine } from './dj.js'
// `models` imports EFFECTS from this module, so it is pulled in lazily at the
// call sites below. The cycle would otherwise resolve with one side holding an
// uninitialised binding, which ESM turns into a `ReferenceError` at boot.
let djModels = null
const loadModels = async () => {
  if (djModels !== null) return djModels
  try {
    const module = await import('./models/index.js')
    djModels = module.models ?? null
  } catch {
    djModels = null
  }
  return djModels
}
import {
  DB,
  TO_DB,
  clamp,
  Biquad,
  Crossover,
  integratedLoudness,
  samplePeak,
  detectCues,
  correlation,
  fadeGains,
  exponentFor,
  estimateBeat,
  timeStretch,
  foldTempo,
  compressorGain,
  echoTail,
  brake,
  noiseSource,
  resample,
  tempoCandidates,
  selectTempoPair,
  beatGrid,
  snapCue,
  beatAlignOffset,
  tempoRelease,
  vocalActivity,
  phraseBoundary,
  bandSplit,
  phraseBlend,
  vocalAwareCurves
} from './dsp.js'

const log = createLogger('automix')

/**
 * Transitions the node can render. The seven built-ins are always present;
 * plugins append to this list with `registerEffect()` (see src/core/plugins.js),
 * which is why it is a live array rather than a frozen constant.
 */
export const EFFECTS = ['crossfade', 'bass-swap', 'filter', 'echo', 'sweep', 'spindown', 'slam', 'wash', 'roll', 'drop']
const BUILT_IN_EFFECTS = new Set(EFFECTS)

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

/* ------------------------------------------------------------------ *
 * MP3 in / MP3 out
 * ------------------------------------------------------------------ */

/**
 * Decode MP3 to float channels.
 *
 * This is the one place in the node that turns audio back into samples, and
 * it happens at every seam between two songs. MetroS does it natively when a
 * libmetro binary is present — about twice as fast as the WASM decoder, and
 * on the thread pool, so the pacer keeps ticking while a crossfade renders —
 * and falls back to the WASM decoder otherwise. `null` means "no decoder":
 * automix then passes audio through untouched rather than dropping it.
 */
export async function decodeMp3(buffer) {
  return metroDecode(buffer)
}

/**
 * Encode float channels back to MP3.
 *
 * MetroS does this natively (shine, ~100x realtime) when libmetro is
 * present and falls back to lamejs — which yields to the event loop as it
 * goes — when it is not. Either way the pacer keeps ticking underneath.
 */
export async function encodeMp3({ left, right, sampleRate, bitrate = 128 }) {
  return metroEncode({ left, right, sampleRate, bitrate })
}

export { resample }

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const monoOf = (pcm) => {
  const out = new Float32Array(pcm.left.length)
  for (let i = 0; i < out.length; i += 1) out[i] = (pcm.left[i] + pcm.right[i]) / 2
  return out
}

const sliceChannels = (pcm, from, to) => ({
  left: pcm.left.subarray(from, to),
  right: pcm.right.subarray(from, to),
  sampleRate: pcm.sampleRate,
  length: Math.max(0, to - from)
})

function fitRate(pcm, sampleRate) {
  if (!pcm || pcm.sampleRate === sampleRate) return pcm
  return {
    left: resample(pcm.left, pcm.sampleRate, sampleRate),
    right: resample(pcm.right, pcm.sampleRate, sampleRate),
    sampleRate,
    length: Math.round((pcm.length * sampleRate) / pcm.sampleRate)
  }
}

/* ------------------------------------------------------------------ *
 * Transition effects
 *
 * Every renderer writes into `left`/`right` and may read:
 *   a, b        trimmed PCM of the outgoing tail / incoming head
 *   fade        blend length in samples
 *   total       length of the rendered segment in samples
 *   gainFor(t)  crossfade gains under the chosen law
 *   beatSamples beat period (samples) of the outgoing song, 0 if unknown
 * ------------------------------------------------------------------ */

/**
 * Add a transition at runtime.
 *
 * `renderer(ctx)` receives the same context the built-ins get — `{ a, b, left,
 * right, fade, total, gainFor, sampleRate, options, beatSamples }` — and writes
 * into `left`/`right`. Built-in names cannot be replaced.
 */
export function registerEffect(name, renderer) {
  const id = String(name ?? '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{1,23}$/.test(id)) throw new Error(`Invalid effect name "${name}"`)
  if (BUILT_IN_EFFECTS.has(id)) throw new Error(`"${id}" is a built-in transition`)
  if (typeof renderer !== 'function') throw new Error('An effect needs a renderer function')
  EFFECT_RENDERERS[id] = renderer
  if (!EFFECTS.includes(id)) EFFECTS.push(id)
  return id
}

/** Remove a plugin-provided transition (built-ins are ignored). */
export function unregisterEffect(name) {
  const id = String(name ?? '').toLowerCase()
  if (BUILT_IN_EFFECTS.has(id)) return false
  delete EFFECT_RENDERERS[id]

  // `splice`, not `filter` + reassign: `EFFECTS` is exported and held by
  // reference (the model's action vector used to be `[...EFFECTS]`, and a
  // console holds the array it fetched). Mutating it in place keeps every
  // holder current, and is why removal has to be the same operation.
  //
  // The order is stable for the same reason: removing an entry must not
  // reorder the ones that remain, or anything that indexed into this array
  // starts pointing at a different transition.
  const at = EFFECTS.indexOf(id)
  if (at !== -1) EFFECTS.splice(at, 1)
  return true
}

const EFFECT_RENDERERS = {
  /** Plain blend, level-correct for the measured correlation. */
  crossfade(ctx) {
    const { a, b, left, right, fade, total, gainFor } = ctx
    for (let i = 0; i < total; i += 1) {
      const [ga, gb] = gainFor(i / fade)
      left[i] = (a.left[i] ?? 0) * ga + (b.left[i] ?? 0) * gb
      right[i] = (a.right[i] ?? 0) * ga + (b.right[i] ?? 0) * gb
    }
  },

  /**
   * Bass swap — the club workhorse. The incoming song enters with its low end
   * cut, both songs share the mids and highs, and the bass changes hands in
   * one move on a beat. Two basslines are never up at once.
   */
  'bass-swap'(ctx) {
    const { a, b, left, right, fade, total, gainFor, sampleRate, options, beatSamples } = ctx
    const split = {
      aL: new Crossover(options.crossoverHz, sampleRate),
      aR: new Crossover(options.crossoverHz, sampleRate),
      bL: new Crossover(options.crossoverHz, sampleRate),
      bR: new Crossover(options.crossoverHz, sampleRate)
    }
    const swapAt = Math.round(fade * 0.62)
    const swapLen = Math.max(1, Math.round(beatSamples || sampleRate * 0.18))

    for (let i = 0; i < total; i += 1) {
      const t = i / fade
      const [ga, gb] = gainFor(t)
      const [aLowL, aHighL] = split.aL.split(a.left[i] ?? 0)
      const [aLowR, aHighR] = split.aR.split(a.right[i] ?? 0)
      const [bLowL, bHighL] = split.bL.split(b.left[i] ?? 0)
      const [bLowR, bHighR] = split.bR.split(b.right[i] ?? 0)

      // One decisive move, one beat wide, instead of a slow low-end blend.
      const swap = clamp((i - swapAt) / swapLen, 0, 1)
      const lowA = 1 - swap
      const lowB = swap

      left[i] = aHighL * ga + bHighL * gb + aLowL * lowA + bLowL * lowB
      right[i] = aHighR * ga + bHighR * gb + aLowR * lowA + bLowR * lowB
    }
  },

  /**
   * Filter fade — the outgoing song is swept into a low-pass while the
   * incoming song opens up from behind a high-pass. Coefficients are
   * recomputed every 64 samples along an exponential (musical) frequency
   * path.
   */
  filter(ctx) {
    const { a, b, left, right, fade, total, gainFor, sampleRate } = ctx
    const nyquist = sampleRate / 2
    const lpTop = Math.min(18_000, nyquist - 500)
    const lpBottom = 320
    const hpTop = 700
    const hpBottom = 25
    const Q = 0.9
    const lp = [Biquad.lowpass(lpTop, sampleRate, Q), Biquad.lowpass(lpTop, sampleRate, Q)]
    const hp = [Biquad.highpass(hpTop, sampleRate, Q), Biquad.highpass(hpTop, sampleRate, Q)]
    const step = 64

    for (let i = 0; i < total; i += 1) {
      if (i % step === 0) {
        const t = clamp(i / fade, 0, 1)
        const cutoff = lpTop * (lpBottom / lpTop) ** t
        const opening = hpTop * (hpBottom / hpTop) ** t
        const nextLp = Biquad.lowpass(cutoff, sampleRate, Q)
        const nextHp = Biquad.highpass(opening, sampleRate, Q)
        for (const f of lp) f.set(nextLp.b0, nextLp.b1, nextLp.b2, nextLp.a1, nextLp.a2)
        for (const f of hp) f.set(nextHp.b0, nextHp.b1, nextHp.b2, nextHp.a1, nextHp.a2)
      }
      const t = i / fade
      const [ga, gb] = gainFor(t)
      // The outgoing song keeps its level until late: the filter does the work.
      const hold = clamp(1.35 * ga, 0, 1)
      left[i] = lp[0].process(a.left[i] ?? 0) * hold + hp[0].process(b.left[i] ?? 0) * gb
      right[i] = lp[1].process(a.right[i] ?? 0) * hold + hp[1].process(b.right[i] ?? 0) * gb
    }
  },

  /**
   * Echo out — the outgoing song is cut into a beat-synced delay tail that
   * rings out over the incoming song. Works between any two tempos, which is
   * why it is the universal escape hatch.
   */
  echo(ctx) {
    const { a, b, left, right, fade, total, sampleRate, beatSamples } = ctx
    const beat = beatSamples || Math.round(sampleRate * 0.5)
    const cut = Math.min(fade, Math.max(1, beat)) // dry A lasts one beat
    const delay = Math.max(1, Math.round(beat / 2))

    const dryL = new Float32Array(total)
    const dryR = new Float32Array(total)
    for (let i = 0; i < total; i += 1) {
      const g = i < cut ? 1 - i / cut : 0
      dryL[i] = (a.left[i] ?? 0) * g
      dryR[i] = (a.right[i] ?? 0) * g
    }
    const tailL = echoTail(dryL, sampleRate, { delaySamples: delay, feedback: 0.5, damping: 5000, length: total })
    const tailR = echoTail(dryR, sampleRate, { delaySamples: delay, feedback: 0.5, damping: 5000, length: total })

    // The new song comes in on the downbeat after the cut, at full level:
    // nothing else is filling the low end by then.
    const entry = Math.min(total - 1, cut)
    const ramp = Math.max(1, Math.round(sampleRate * 0.02))
    for (let i = 0; i < total; i += 1) {
      const gb = i < entry ? 0 : Math.min(1, (i - entry) / ramp)
      left[i] = tailL[i] + (b.left[i] ?? 0) * gb
      right[i] = tailR[i] + (b.right[i] ?? 0) * gb
    }
  },

  /**
   * Sweep — a resonant filtered-noise riser under the blend, peaking exactly
   * on the handover. (White noise straight into the mix is just hiss.)
   */
  sweep(ctx) {
    const { a, b, left, right, fade, total, gainFor, sampleRate } = ctx
    const rnd = noiseSource(0xa11ce)
    const bp = [Biquad.bandpass(300, sampleRate, 1.3), Biquad.bandpass(300, sampleRate, 1.3)]
    const step = 64
    const peak = DB(-16)

    for (let i = 0; i < total; i += 1) {
      const t = clamp(i / fade, 0, 1)
      if (i % step === 0) {
        const centre = 300 * (7000 / 300) ** t
        const next = Biquad.bandpass(Math.min(centre, sampleRate / 2 - 500), sampleRate, 1.3)
        for (const f of bp) f.set(next.b0, next.b1, next.b2, next.a1, next.a2)
      }
      const [ga, gb] = gainFor(t)
      const envelope = i < fade ? Math.sin(Math.PI * t) ** 2 * peak : 0
      const n = rnd()
      left[i] = (a.left[i] ?? 0) * ga + (b.left[i] ?? 0) * gb + bp[0].process(n) * envelope
      right[i] = (a.right[i] ?? 0) * ga + (b.right[i] ?? 0) * gb + bp[1].process(n * 0.8) * envelope
    }
  },

  /**
   * Spindown — tape stop: the outgoing song decelerates to a standstill over
   * about a beat, a breath of silence, then the new song lands on its own
   * downbeat.
   */
  spindown(ctx) {
    const { a, b, left, right, total, sampleRate, beatSamples } = ctx
    const brakeLen = Math.min(total - 1, Math.max(Math.round(sampleRate * 0.35), beatSamples || 0))
    const gap = Math.round(sampleRate * 0.05)
    const decay = Math.max(1, Math.round(sampleRate * 0.01))

    const bl = brake(a.left, { length: brakeLen })
    const br = brake(a.right, { length: brakeLen })
    for (let i = 0; i < brakeLen; i += 1) {
      const out = i > brakeLen - decay ? (brakeLen - i) / decay : 1
      left[i] = bl[i] * out
      right[i] = br[i] * out
    }

    const entry = Math.min(total - 1, brakeLen + gap)
    const ramp = Math.max(1, Math.round(sampleRate * 0.005)) // de-click only
    for (let i = entry; i < total; i += 1) {
      const g = Math.min(1, (i - entry) / ramp)
      left[i] = (b.left[i - entry] ?? 0) * g
      right[i] = (b.right[i - entry] ?? 0) * g
    }
  },

  /**
   * Wash — the outgoing song is pushed into a long reverb-like tail (a dense
   * pair of detuned delays with a damping filter) while it fades, so it
   * dissolves into space instead of simply getting quieter. Good between two
   * songs that share nothing: there is no moment where both are "the music".
   */
  wash(ctx) {
    const { a, b, left, right, fade, total, gainFor, sampleRate, beatSamples } = ctx
    const beat = beatSamples || Math.round(sampleRate * 0.5)

    // Feed the tail the first part of A, ducking as the wash takes over.
    const feedL = new Float32Array(total)
    const feedR = new Float32Array(total)
    const feedLen = Math.min(total, Math.round(fade * 0.55))
    for (let i = 0; i < feedLen; i += 1) {
      const g = 1 - (i / feedLen) ** 1.4
      feedL[i] = (a.left[i] ?? 0) * g
      feedR[i] = (a.right[i] ?? 0) * g
    }

    // Two delays an odd fraction apart read as a room rather than an echo.
    const shortTap = Math.max(1, Math.round(beat * 0.375))
    const longTap = Math.max(2, Math.round(beat * 0.625))
    const washL = echoTail(feedL, sampleRate, { delaySamples: shortTap, feedback: 0.62, damping: 3600, length: total })
    const washL2 = echoTail(feedL, sampleRate, { delaySamples: longTap, feedback: 0.55, damping: 2600, length: total })
    const washR = echoTail(feedR, sampleRate, { delaySamples: longTap, feedback: 0.62, damping: 3600, length: total })
    const washR2 = echoTail(feedR, sampleRate, { delaySamples: shortTap, feedback: 0.55, damping: 2600, length: total })

    for (let i = 0; i < total; i += 1) {
      const t = clamp(i / fade, 0, 1)
      const [ga, gb] = gainFor(t)
      // The dry outgoing song leaves early; the wash carries the rest.
      const dry = Math.max(0, ga - t * 0.55)
      const tail = Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 0.8 * 0.7
      left[i] = (a.left[i] ?? 0) * dry + (washL[i] * 0.6 + washL2[i] * 0.4) * tail + (b.left[i] ?? 0) * gb
      right[i] = (a.right[i] ?? 0) * dry + (washR[i] * 0.6 + washR2[i] * 0.4) * tail + (b.right[i] ?? 0) * gb
    }
  },

  /**
   * Roll — a beat-repeat that halves on the way out: the last bar of the
   * outgoing song is looped, then the loop shortens (1 beat → ½ → ¼) into
   * the handover, and the new song lands on the downbeat. Needs a tempo to
   * make sense, which is why `chooseEffect` only picks it when one is known.
   */
  roll(ctx) {
    const { a, b, left, right, fade, total, gainFor, sampleRate, beatSamples } = ctx
    const beat = beatSamples || Math.round(sampleRate * 0.5)
    const rollLen = Math.min(Math.round(beat * 4), Math.max(beat, Math.round(fade * 0.5)))
    const start = Math.max(0, Math.min(total - 1, Math.round(fade * 0.55)))
    const entry = Math.min(total - 1, start + rollLen)
    const ramp = Math.max(1, Math.round(sampleRate * 0.004))

    // Up to the roll, an ordinary blend so nothing lurches.
    for (let i = 0; i < start; i += 1) {
      const [ga, gb] = gainFor(clamp(i / fade, 0, 1))
      left[i] = (a.left[i] ?? 0) * ga + (b.left[i] ?? 0) * gb
      right[i] = (a.right[i] ?? 0) * ga + (b.right[i] ?? 0) * gb
    }

    // The loop source is the beat that was about to play.
    for (let i = start; i < entry; i += 1) {
      const into = i - start
      // 1 beat, then ½, then ¼ — each division twice as urgent as the last.
      const stage = into < rollLen * 0.5 ? 1 : into < rollLen * 0.8 ? 0.5 : 0.25
      const loop = Math.max(64, Math.round(beat * stage))
      const source = start + (into % loop)
      const fadeOut = 1 - (into / rollLen) ** 2 * 0.35
      // De-click each repeat: a couple of milliseconds at the loop seam.
      const edge = Math.min(into % loop, loop - (into % loop))
      const soft = Math.min(1, edge / ramp)
      left[i] = (a.left[source] ?? 0) * fadeOut * soft
      right[i] = (a.right[source] ?? 0) * fadeOut * soft
    }

    for (let i = entry; i < total; i += 1) {
      const j = i - entry
      const g = Math.min(1, j / ramp)
      left[i] = (b.left[j] ?? 0) * g
      right[i] = (b.right[j] ?? 0) * g
    }
  },

  /**
   * Drop — the outgoing song is filtered up and away into a beat of silence,
   * and the new song lands on its downbeat at full level. The silence is the
   * effect: on air, a held breath is louder than any crossfade.
   */
  drop(ctx) {
    const { a, b, left, right, fade, total, sampleRate, beatSamples } = ctx
    const beat = beatSamples || Math.round(sampleRate * 0.5)
    const lift = Math.min(Math.max(beat * 2, Math.round(sampleRate * 0.6)), Math.round(fade * 0.8))
    const gap = Math.max(Math.round(sampleRate * 0.12), Math.round(beat * 0.5))
    const entry = Math.min(total - 1, lift + gap)
    const ramp = Math.max(1, Math.round(sampleRate * 0.004))
    const hp = [Biquad.highpass(40, sampleRate, 0.9), Biquad.highpass(40, sampleRate, 0.9)]
    const step = 64

    for (let i = 0; i < lift; i += 1) {
      if (i % step === 0) {
        // Sweep the low end out from under it, ending thin and small.
        const t = clamp(i / lift, 0, 1)
        const cutoff = Math.min(40 * (2600 / 40) ** t, sampleRate / 2 - 500)
        const next = Biquad.highpass(cutoff, sampleRate, 0.9)
        for (const f of hp) f.set(next.b0, next.b1, next.b2, next.a1, next.a2)
      }
      const t = clamp(i / lift, 0, 1)
      const g = (1 - t) ** 0.6
      left[i] = hp[0].process(a.left[i] ?? 0) * g
      right[i] = hp[1].process(a.right[i] ?? 0) * g
    }

    for (let i = entry; i < total; i += 1) {
      const j = i - entry
      const g = Math.min(1, j / ramp)
      left[i] = (b.left[j] ?? 0) * g
      right[i] = (b.right[j] ?? 0) * g
    }
  },

  /**
   * Slam — no overlap at all: the outgoing song plays at full level to the
   * cut, which sits on a beat, and the new one starts on its first downbeat.
   * Only a 5 ms de-click ramp on each side.
   */
  slam(ctx) {
    const { a, b, left, right, fade, total, sampleRate, beatSamples } = ctx
    const beat = beatSamples || 0
    let cut = fade
    if (beat > 0) cut = Math.max(beat, Math.round(fade / beat) * beat) // land on a beat
    cut = Math.min(cut, total - 1, a.left.length)
    const ramp = Math.max(1, Math.round(sampleRate * 0.005))

    for (let i = 0; i < total; i += 1) {
      if (i < cut) {
        const g = i > cut - ramp ? (cut - i) / ramp : 1
        left[i] = (a.left[i] ?? 0) * g
        right[i] = (a.right[i] ?? 0) * g
      } else {
        const j = i - cut
        const g = Math.min(1, j / ramp)
        left[i] = (b.left[j] ?? 0) * g
        right[i] = (b.right[j] ?? 0) * g
      }
    }
  }
}

/**
 * How long should *this* blend be?
 *
 * A fixed crossfade is a compromise between two songs that never meet. What
 * a DJ actually does is hold a blend for as long as it keeps working:
 *
 *   • tempos that match, and stay matched, can run long — that is the whole
 *     pleasure of a mix;
 *   • a big tempo gap cannot, because the stretch needed to hold it grows
 *     with every bar;
 *   • two records that correlate strongly (similar key, similar texture)
 *     sit together; two that fight need to get it over with;
 *   • a hot entry wants a short blend, a slow fade-in wants a long one;
 *   • and whatever comes out is rounded to a whole number of bars, because
 *     a blend that ends off the grid sounds like a mistake.
 *
 * @returns {{ms: number, bars: number|null, why: string}}
 */
export function smartCrossfadeMs(seam = {}, options = {}) {
  const requested = options.crossfadeMs ?? DEFAULT_AUTOMIX.crossfadeMs
  const floor = options.minCrossfadeMs ?? DEFAULT_AUTOMIX.minCrossfadeMs
  const ceiling = options.maxCrossfadeMs ?? DEFAULT_AUTOMIX.maxCrossfadeMs
  if (options.smart === false) return { ms: clamp(requested, floor, ceiling), bars: null, why: 'fixed' }

  const { matched = false, tempoDelta = 99, correlation = 0, energy = 0.5, bpm = null, available = Infinity } = seam

  let factor = 1
  const reasons = []

  if (matched && tempoDelta < 1) {
    factor *= 2.2
    reasons.push('tempos locked')
  } else if (matched && tempoDelta < 3) {
    factor *= 1.5
    reasons.push('tempos close')
  } else if (tempoDelta > 12) {
    factor *= 0.55
    reasons.push('tempos far apart')
  }

  if (correlation > 0.4) {
    factor *= 1.3
    reasons.push('they sit together')
  } else if (correlation < -0.15) {
    factor *= 0.6
    reasons.push('they fight')
  }

  if (energy > 0.7) {
    factor *= 0.75
    reasons.push('hot entry')
  } else if (energy < 0.25) {
    factor *= 1.25
    reasons.push('gentle entry')
  }

  let ms = clamp(requested * factor, floor, Math.min(ceiling, available))

  // Round to bars, so the blend ends where the music does.
  let bars = null
  if (bpm && bpm > 40) {
    const barMs = (60_000 / bpm) * 4
    bars = Math.max(1, Math.round(ms / barMs))
    const rounded = bars * barMs
    if (rounded >= floor && rounded <= Math.min(ceiling, available)) ms = rounded
    else bars = null
  }

  return { ms: Math.round(ms), bars, why: reasons.length ? reasons.join(', ') : 'as configured' }
}

/* ------------------------------------------------------------------ *
 * Choosing a transition
 * ------------------------------------------------------------------ */

/**
 * What each transition needs to work, and what it is good at.
 *
 * `needsBeat`  — meaningless without a tempo (a roll with no grid is noise)
 * `needsMatch` — only convincing when the two tempos actually agree
 * `energy`     — where it sits on the gentle → dramatic axis, 0…1
 * `length`     — the shortest blend, in milliseconds, it can be rendered in
 */
export const EFFECT_TRAITS = {
  crossfade: { needsBeat: false, needsMatch: false, energy: 0.1, length: 800 },
  wash: { needsBeat: false, needsMatch: false, energy: 0.25, length: 2500 },
  filter: { needsBeat: false, needsMatch: false, energy: 0.35, length: 2000 },
  echo: { needsBeat: false, needsMatch: false, energy: 0.5, length: 1500 },
  'bass-swap': { needsBeat: true, needsMatch: true, energy: 0.45, length: 2500 },
  sweep: { needsBeat: false, needsMatch: false, energy: 0.6, length: 2500 },
  roll: { needsBeat: true, needsMatch: false, energy: 0.8, length: 2000 },
  drop: { needsBeat: true, needsMatch: false, energy: 0.85, length: 1500 },
  spindown: { needsBeat: false, needsMatch: false, energy: 0.9, length: 1200 },
  slam: { needsBeat: false, needsMatch: false, energy: 1, length: 400 }
}

/**
 * Pick the transition for *this* seam.
 *
 * A station that always does the same trick stops sounding like a DJ after
 * ten minutes, and a trick that does not fit the music sounds worse than no
 * trick at all. So: score every transition the seam can support, prefer the
 * ones that match how the two songs relate, and refuse to repeat the last
 * one when something else is nearly as good.
 *
 * @param {object} seam
 * @param {boolean} seam.beat        a tempo was found for both songs
 * @param {boolean} seam.matched     the tempos were actually matched
 * @param {number}  seam.tempoDelta  |bpm difference| after folding
 * @param {number}  seam.correlation −1…1 between the two songs at the seam
 * @param {number}  seam.fadeMs      how long the blend will be
 * @param {number}  seam.energy      0…1 loudness of the incoming song's entry
 * @param {boolean} seam.talkover    the DJ is speaking over this seam
 * @param {string}  [seam.previous]  what the last seam used
 * @param {string[]} [pool]          allowed effects (empty = all)
 */
/**
 * The model's opinion, folded into the heuristic's.
 *
 * Three rules keep a learned policy from being a liability on a live station:
 *
 *   • **The pool still excludes.** An owner who has switched off the drop does
 *     not get a drop because a model likes one; the model is a *ranker* over
 *     what the heuristic already allows, never an override of the pool.
 *   • **The margin has to be real.** A model that is 0.01 ahead of the
 *     runner-up has not decided anything, and the heuristic's own choice (which
 *     knows about `previous`, so it also varies the set) is better than a coin.
 *   • **It can only disagree within the allowed set.** With no model, a
 *     failing model, or a thin margin, `chooseEffect` answers exactly as before.
 *
 * Returns `{ effect, source, margin, model }` so the caller can report which
 * brain made the call — a transition the owner did not expect should be
 * explicable from the log.
 *
 * @param {object} seam
 * @param {string[]} [pool]
 * @param {object|null} [model] a `models.score()` result, already computed
 */
export function chooseEffectWithModel(seam = {}, pool = [], model = null) {
  const baseline = chooseEffect(seam, pool)
  if (!model || !model.best) return { effect: baseline, source: 'heuristic', margin: 0, baseline }

  const allowed = new Set(pool.length ? pool : EFFECTS)
  const ranked = model.order.filter((name) => allowed.has(name))
  if (ranked.length === 0) return { effect: baseline, source: 'heuristic', margin: 0, baseline }

  // A transition the heuristic would refuse on this seam (no beat to roll on,
  // a fade too short for a spindown) is not a candidate, however much the
  // model likes it: the renderers assume those preconditions.
  const traits = EFFECT_TRAITS[ranked[0]]
  const usable = !traits?.needsBeat || seam.beat
  const matched = !traits?.needsMatch || (seam.matched && (seam.tempoDelta ?? 99) < 3)
  const long = !traits || (seam.fadeMs ?? 6000) >= traits.length
  if (!usable || !matched || !long) return { effect: baseline, source: 'heuristic', margin: model.margin, baseline }

  // `margin` is the model's own separation between first and second choice.
  // Below it, the model has no opinion worth acting on.
  if (model.margin < 0.05) return { effect: baseline, source: 'heuristic', margin: model.margin, baseline }
  if (ranked[0] === baseline) return { effect: baseline, source: 'model', margin: model.margin, baseline, agreed: true }
  return { effect: ranked[0], source: 'model', margin: model.margin, baseline, model: model.model }
}

export function chooseEffect(seam = {}, pool = []) {
  const {
    beat = false,
    matched = false,
    tempoDelta = 99,
    correlation = 0,
    fadeMs = 6000,
    energy = 0.5,
    talkover = false,
    previous = null
  } = seam

  const allowed = (pool.length ? pool : EFFECTS).filter((name) => EFFECT_TRAITS[name])
  if (allowed.length === 0) return 'crossfade'

  // How dramatic this seam wants to be: a tight tempo match and a hot entry
  // can carry a big move; a mismatched pair of ballads cannot.
  let want = 0.35
  if (matched && tempoDelta < 2) want += 0.3
  else if (beat) want += 0.1
  if (energy > 0.6) want += 0.15
  if (energy < 0.25) want -= 0.15
  // Two songs that correlate strongly blend beautifully; leave them alone.
  if (correlation > 0.45) want -= 0.2
  // Over a voice link, anything clever fights the DJ.
  if (talkover) want -= 0.35
  want = clamp(want, 0, 1)

  const scored = allowed
    .filter((name) => {
      const traits = EFFECT_TRAITS[name]
      if (traits.needsBeat && !beat) return false
      if (traits.needsMatch && !(matched && tempoDelta < 3)) return false
      return fadeMs >= traits.length
    })
    .map((name) => {
      const traits = EFFECT_TRAITS[name]
      // Closeness to what the seam is asking for, plus a nudge for the
      // transitions that suit this particular pair.
      let score = 1 - Math.abs(traits.energy - want)
      if (matched && name === 'bass-swap') score += 0.15
      if (!beat && (name === 'wash' || name === 'filter')) score += 0.08
      if (correlation < -0.2 && name === 'crossfade') score -= 0.25 // phasey
      // Under a voice link the music should get out of the way, so anything
      // dramatic is actively penalised rather than merely unlikely.
      if (talkover) score -= traits.energy * 0.35
      if (talkover && (name === 'crossfade' || name === 'filter' || name === 'wash')) score += 0.15
      if (name === previous) score -= 0.35 // vary, unless nothing else fits
      return { name, score }
    })
    .sort((a, b) => b.score - a.score)

  if (scored.length === 0) return 'crossfade'

  // Among the near-best, choose at random so two identical-looking seams do
  // not always resolve the same way.
  const best = scored[0].score
  const shortlist = scored.filter((entry) => entry.score >= best - 0.08)
  return shortlist[Math.floor(Math.random() * shortlist.length)].name
}

/**
 * Make a rendered seam joinable.
 *
 * The seam is spliced between audio nobody rendered — the end of the last
 * song and the rest of the new one — and every effect leaves its own kind of
 * mess at the edges: a DC step from a filter, a half sample of a brake, an
 * abrupt loop end. Two milliseconds of ramp at each boundary and a DC
 * blocker across the whole block makes any transition joinable to any other,
 * which is the difference between "a mix" and "a series of edits".
 */
export function smoothEdges(left, right, sampleRate, { fadeMs = 2, dcBlock = true } = {}) {
  const n = left.length
  if (n === 0) return

  if (dcBlock) {
    // One-pole DC blocker, run over both channels in place.
    const r = 1 - 20 / sampleRate
    for (const channel of [left, right]) {
      let x1 = 0
      let y1 = 0
      for (let i = 0; i < n; i += 1) {
        const x = channel[i]
        const y = x - x1 + r * y1
        x1 = x
        y1 = y
        channel[i] = y
      }
    }
  }

  const ramp = Math.max(1, Math.min(Math.round((fadeMs / 1000) * sampleRate), Math.floor(n / 2)))
  for (let i = 0; i < ramp; i += 1) {
    // Raised cosine, not linear: a linear ramp still steps in the derivative.
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp)
    left[i] *= g
    right[i] *= g
    left[n - 1 - i] *= g
    right[n - 1 - i] *= g
  }
}

/* ------------------------------------------------------------------ *
 * Automix
 * ------------------------------------------------------------------ */

export class Automix {
  #fifo = [] // withheld tail of the song currently on air
  #fifoMs = 0
  #tail = null // { frames, track, ms } waiting for the next song
  #head = [] // first frames of the incoming song
  #headMs = 0
  #currentId = null
  #currentMs = 0
  #collecting = false
  #lastTrack = null
  #lastEffect = null
  #lastModel = null
  #breaks = 0
  #transitions = 0

  constructor(options = {}, ctx = {}) {
    this.options = { ...DEFAULT_AUTOMIX, ...options, dj: { ...DEFAULT_AUTOMIX.dj, ...(options.dj ?? {}) } }
    this.ctx = ctx
    this.log = ctx.log ?? log
    this.last = null
  }

  get enabled() {
    return this.options.enabled !== false
  }

  configure(patch = {}) {
    const next = { ...this.options, ...patch, dj: { ...this.options.dj, ...(patch.dj ?? {}) } }
    if (patch.effect && patch.effect !== AUTO_EFFECT && !EFFECTS.includes(patch.effect)) {
      throw new Error(`Unknown transition "${patch.effect}" (try: ${AUTO_EFFECT}, ${EFFECTS.join(', ')})`)
    }
    if (patch.effectPool) {
      const unknown = patch.effectPool.filter((name) => !EFFECTS.includes(name))
      if (unknown.length) throw new Error(`Unknown transition(s) in the pool: ${unknown.join(', ')}`)
    }
    this.options = next
    if (!this.enabled) this.reset()
    return this.info()
  }

  info() {
    const { enabled, crossfadeMs, curve, effect, minTrackMs, targetLufs, beatAlign, beatmatch, maxStretchPercent } = this.options
    return {
      enabled,
      crossfadeMs,
      curve,
      effect,
      effects: [...EFFECTS],
      minTrackMs,
      targetLufs,
      beatAlign,
      beatmatch,
      maxStretchPercent,
      analysePair: this.options.analysePair !== false,
      model: this.options.model !== false,
      vocalAware: this.options.vocalAware !== false,
      tempoReleaseMs: this.options.tempoReleaseMs ?? 4000,
      dj: { ...this.options.dj },
      transitions: this.#transitions,
      breaks: this.#breaks,
      pending: this.#fifoMs > 0 || Boolean(this.#tail),
      last: this.last
    }
  }

  reset() {
    this.#fifo = []
    this.#fifoMs = 0
    this.#tail = null
    this.#head = []
    this.#headMs = 0
    this.#collecting = false
    this.#currentId = null
    this.#currentMs = 0
  }

  /**
   * Feed reader frames in, get airable frames out.
   * @param {{data: Buffer, ms: number, track: object}[]} frames
   */
  async push(frames) {
    if (!this.enabled || frames.length === 0) return frames

    const out = []
    for (const frame of frames) {
      const track = frame.track
      const bypass = track?.announcement || track?.live || track?.source === 'tts'

      if (track?.id !== this.#currentId) {
        if (bypass || !this.#eligible()) {
          out.push(...this.#drain())
        } else {
          this.#tail = { frames: this.#fifo, ms: this.#fifoMs, track: this.#lastTrack ?? null }
          this.#fifo = []
          this.#fifoMs = 0
          this.#collecting = true
          this.#head = []
          this.#headMs = 0
        }
        this.#currentId = track?.id ?? null
        this.#currentMs = 0
      }

      this.#currentMs += frame.ms
      this.#lastTrack = track

      if (bypass) {
        out.push(frame)
        continue
      }

      if (this.#collecting) {
        this.#head.push(frame)
        this.#headMs += frame.ms
        if (this.#headMs >= this.#needMs()) out.push(...(await this.#renderSeam()))
        continue
      }

      // Nothing is held back until the item has run long enough to be worth
      // mixing: a station's first seconds stay instant and short idents are
      // never touched.
      if (this.#currentMs < this.options.minTrackMs) {
        out.push(frame)
        continue
      }

      this.#fifo.push(frame)
      this.#fifoMs += frame.ms
      while (this.#fifoMs > this.options.crossfadeMs) {
        const oldest = this.#fifo.shift()
        this.#fifoMs -= oldest.ms
        out.push(oldest)
      }
    }
    return out
  }

  /** Release whatever is being held (end of programme, errors, stop). */
  async flush(reason = 'flush') {
    if (!this.enabled) return []
    if (this.#collecting && this.#headMs > 0) {
      const mixed = await this.#renderSeam(reason)
      return [...mixed, ...this.#drain()]
    }
    return this.#drain()
  }

  #drain() {
    const out = []
    if (this.#tail) {
      out.push(...this.#tail.frames)
      this.#tail = null
    }
    out.push(...this.#fifo, ...this.#head)
    this.#fifo = []
    this.#fifoMs = 0
    this.#head = []
    this.#headMs = 0
    this.#collecting = false
    return out
  }

  #eligible() {
    if (this.#fifoMs <= 0) return false
    if (this.#currentMs < this.options.minTrackMs) return false
    return true
  }

  /** How much of the incoming song the seam needs before it can render. */
  #needMs() {
    const { crossfadeMs, dj, maxRenderMs } = this.options
    // Always collect a couple of seconds more than the blend needs: that is
    // the headroom the cue detector uses to trim silence off the front of the
    // next file, and what the echo/spindown tails ring out into.
    // With Smart Automix the blend can grow beyond the configured length,
    // so collect for the longest one it is allowed to choose.
    const longest = this.options.smart === false ? crossfadeMs : Math.max(crossfadeMs, this.options.maxCrossfadeMs ?? crossfadeMs)
    const base = longest + 2000
    if (!this.#djDue()) return Math.min(maxRenderMs, base)
    return Math.min(maxRenderMs, Math.max(base, dj.leadInMs + 6500 + dj.tailMs))
  }

  #djDue() {
    const dj = this.options.dj
    if (!dj?.enabled || !this.ctx.sources) return false
    return this.#transitions % Math.max(1, Number(dj.every) || 1) === 0
  }

  /* ------------------------------ rendering ------------------------------ */

  async #renderSeam(reason = 'segue') {
    const tail = this.#tail
    const head = this.#head
    this.#tail = null
    this.#head = []
    this.#headMs = 0
    this.#collecting = false

    if (!tail || head.length === 0) return [...(tail?.frames ?? []), ...head]

    const started = Date.now()
    try {
      const mixed = await this.#mix(tail, head)
      if (!mixed) return [...tail.frames, ...head]
      this.#transitions += 1
      this.last = { at: Date.now(), reason, renderMs: Date.now() - started, ...mixed.report }
      this.ctx.station?.emit?.('automix', this.last)
      this.log.info(
        `${mixed.report.effect} ${mixed.report.blendMs}ms ${mixed.report.curve}` +
          (mixed.report.beat?.matched
            ? ` beatmatched ${mixed.report.beat.bpm.toFixed(0)}→${mixed.report.beat.playedAtBpm.toFixed(0)}bpm (${mixed.report.beat.stretchPercent > 0 ? '+' : ''}${mixed.report.beat.stretchPercent}%)`
            : mixed.report.beat?.aligned
              ? ` @${mixed.report.beat.bpm.toFixed(0)}bpm`
              : '') +
          `: "${tail.track?.title ?? '?'}" → "${head[0]?.track?.title ?? '?'}"` +
          ` [match ${mixed.report.loudness.appliedDb > 0 ? '+' : ''}${mixed.report.loudness.appliedDb} dB, peak ${mixed.report.peakDb} dBFS` +
          (mixed.report.dj ? `, DJ ${mixed.report.dj.kind}` : '') +
          `, ${Date.now() - started}ms]`
      )
      return mixed.frames
    } catch (error) {
      this.log.warn(`transition failed (${error.message}); hard cut instead`)
      return [...tail.frames, ...head]
    }
  }

  /**
   * Joint tempo analysis — automix-engine's `select_tempo_pair`.
   *
   * The scalar estimator is fast and right most of the time. The cases it gets
   * wrong are exactly the ones that sound wrong: a shuffled groove whose
   * eighth notes are stronger than its quarters, or a track analysed at double
   * time because the hats are loud. Both show up as a *low confidence* on one
   * side, or as a pair that disagrees by far more than the two candidates'
   * second choices do.
   *
   * So: run it when either side is unsure, and only pay for the pair search
   * over a short window (8 s is enough for the autocorrelation to find the
   * beat; the whole track is not needed and would be slow). Returns the same
   * shape as `estimateBeat`, plus the choice it made, or null when the scalar
   * answer stands.
   */
  async #analysePair(windowA, windowB, sampleRate, beatA, beatB) {
    if (this.options.analysePair === false) return null
    if (!beatA || !beatB) return null
    if (!(beatA.bpm > 0) || !(beatB.bpm > 0)) return null

    // Two reasons to look harder, and they are the two ways the scalar
    // estimator is known to fail:
    //
    //   • it was not sure; or
    //   • the two answers are within 8 % of a power-of-two ratio. That is the
    //     octave ambiguity — 128 and 64 describe the same groove, and *both*
    //     are highly confident, so confidence alone can never catch it. A
    //     half-time estimate here is not a curiosity: it makes the beatmatch
    //     stretch by 100 %, which is rejected by `maxStretchPercent` and the
    //     two songs go out unmixed.
    const ratio = beatA.bpm / beatB.bpm
    const nearest = 2 ** Math.round(Math.log2(ratio))
    const octaveAmbiguous = Math.abs(ratio - nearest) / nearest < 0.08
    const unsure = beatA.confidence <= 0.35 || beatB.confidence <= 0.35
    if (!unsure && !octaveAmbiguous) return null

    // Four seconds, not eight. The autocorrelation only has to find lags of
    // 0.34–0.86 s (70–175 BPM), so it needs a few periods, not a phrase; at
    // four seconds each window still holds 5–11 beats of every tempo in range
    // and the candidate lists are identical to the eight-second ones on the
    // fixtures. Halving it halves the only stage that runs two analyses at
    // once, which is most of what is left of the seam's cost.
    const limit = Math.round(4 * sampleRate)
    const a = windowA.length > limit ? windowA.subarray(0, limit) : windowA
    const b = windowB.length > limit ? windowB.subarray(0, limit) : windowB
    const [candidatesA, candidatesB] = await Promise.all([
      Promise.resolve().then(() => tempoCandidates(a, sampleRate)),
      Promise.resolve().then(() => tempoCandidates(b, sampleRate))
    ])
    const pair = selectTempoPair(candidatesA, candidatesB)
    if (!pair) return null

    // A beat grid over the analysed window, phase-locked to the pair's tempo.
    const gridFor = (window, bpm, estimate) => {
      const period = (60 * sampleRate) / bpm
      const beats = beatGrid(window.length, sampleRate, bpm, estimate?.phaseSamples ?? 0)
      return {
        bpm,
        periodSamples: period,
        phaseSamples: estimate?.phaseSamples ?? 0,
        beats,
        confidence: Math.max(estimate?.confidence ?? 0, pair.compatibility < 0.01 ? 0.55 : 0.4),
        candidates: candidatesA.length,
        source: 'pair'
      }
    }

    return {
      beatA: gridFor(a, pair.bpmA, beatA),
      beatB: gridFor(b, pair.bpmB, beatB),
      bpmA: pair.bpmA,
      bpmB: pair.bpmB,
      compatibility: Number(pair.compatibility.toFixed(4)),
      score: Number(pair.score.toFixed(3))
    }
  }

  async #mix(tail, head) {
    const rawA = await decodeMp3(Buffer.concat(tail.frames.map((f) => f.data)))
    if (!rawA) return null
    const rawB = await decodeMp3(Buffer.concat(head.map((f) => f.data)))
    if (!rawB) return null

    const sampleRate = rawB.sampleRate
    const a0 = fitRate(rawA, sampleRate)
    const b0 = rawB
    const sec = (ms) => Math.round((ms / 1000) * sampleRate)
    const ms = (samples) => Math.round((samples / sampleRate) * 1000)

    /* 1. loudness (BS.1770) ------------------------------------------------ */
    const loudA = integratedLoudness([a0.left, a0.right], sampleRate)
    const loudB = integratedLoudness([b0.left, b0.right], sampleRate)

    /* 2. cue points -------------------------------------------------------- */
    const monoA = monoOf(a0)
    const monoB = monoOf(b0)
    const cuesA = detectCues(monoA, sampleRate, { integrated: loudA })
    const cuesB = detectCues(monoB, sampleRate, { integrated: loudB })

    const trim = this.options.trimSilence !== false
    const aStart = 0
    const aEnd = trim ? Math.max(sec(500), cuesA.cueOut) : a0.length
    const bStart = trim ? Math.min(cuesB.cueIn, Math.max(0, b0.length - sec(2000))) : 0
    let a = sliceChannels(a0, aStart, aEnd)
    let b = sliceChannels(b0, bStart, b0.length)
    if (a.length < sec(400) || b.length < sec(400)) return null

    /* 3. loudness match ---------------------------------------------------- */
    let matchDb = 0
    if (loudA != null && loudB != null) matchDb = clamp(loudA - loudB, -this.options.maxGainDb, this.options.maxGainDb)
    const matchGain = DB(matchDb)

    /* 4. tempo pair, beat grid + beatmatch -------------------------------- */
    // Both tempos at once, off the event loop when libmetro is there: this
    // is the stage that used to cost most of a second on a long crossfade,
    // and the pacer has to keep releasing frames while it runs.
    //
    // automix-engine's first real insight: the pair is what matters. Two
    // independent estimates plus a fold picks the wrong octave often enough
    // to hear; scoring every candidate pair for agreement (and for sitting
    // near 100 BPM, where real songs live) is the fix. The scalar estimator
    // stays as the default so the native path keeps its speed, and the pair
    // search only runs when both songs were unconfident or disagree badly.
    let beatA = null
    let beatB = null
    let pairChoice = null
    if (this.options.beatAlign) {
      ;[beatA, beatB] = await Promise.all([analyseBeat(monoA.subarray(aStart, aEnd), sampleRate), analyseBeat(monoB.subarray(bStart), sampleRate)])
      pairChoice = await this.#analysePair(monoA.subarray(aStart, aEnd), monoB.subarray(bStart), sampleRate, beatA, beatB)
      if (pairChoice?.beatA) beatA = pairChoice.beatA
      if (pairChoice?.beatB) beatB = pairChoice.beatB
    }
    const confident = Boolean(beatA && beatB && beatA.confidence > 0.25 && beatB.confidence > 0.25)

    // The grid the *rendered* seam runs on. Without beatmatching that is the
    // outgoing song's own grid; with it, the incoming song's tempo.
    let beatPeriod = confident ? beatA.periodSamples : 0
    let beatAt = (n) => (confident ? beatA.phaseSamples + n * beatA.periodSamples : 0)
    let tempoScale = 1
    let beatmatch = null
    let release = null

    if (confident && this.options.beatmatch !== false) {
      // 174 BPM against 87 BPM is the same groove at half time: fold first.
      const folded = foldTempo(beatB.bpm, beatA.bpm)
      const ratio = beatA.bpm / folded.bpm // < 1 speeds the outgoing song up
      const driftPercent = Math.abs(1 - ratio) * 100
      const limit = Number(this.options.maxStretchPercent ?? 12)

      if (driftPercent > 0.3 && driftPercent <= limit) {
        // Ride the pitch fader instead of stamping on it: the tempo change
        // eases in over two beats, then holds at the incoming song's tempo.
        const ramp = Math.round(Math.min(a.length * 0.5, beatA.periodSamples * 2 * ratio))
        const stretched = await stretchAudio([a.left, a.right], sampleRate, { stretch: ratio, rampSamples: ramp })
        a = { left: stretched.channels[0], right: stretched.channels[1], sampleRate, length: stretched.length }
        const warp = stretched.map
        tempoScale = ratio
        beatPeriod = Math.round((60 * sampleRate) / folded.bpm)
        beatAt = (n) => Math.round(warp.outputAt(beatA.phaseSamples + n * beatA.periodSamples))
        beatmatch = {
          fromBpm: Number(beatA.bpm.toFixed(2)),
          toBpm: Number(folded.bpm.toFixed(2)),
          rawBpm: Number(beatB.bpm.toFixed(2)),
          stretchPercent: Number(((ratio - 1) * 100).toFixed(2)),
          rampMs: ms(ramp)
        }

        // Tempo *release*: automix-engine returns the incoming song to its own
        // tempo over a fixed wall-clock window rather than leaving it stretched
        // for the rest of the track. This node renders only the seam, so the
        // release is reported for the rest of the song: the incoming material
        // after the seam is aired untouched, which is the same listener-side
        // result (it returns to native speed), just achieved by not processing
        // it. The map is still built, because the report is how the console
        // shows what will happen and how long it takes.
        release = tempoRelease(b.length, sampleRate, {
          fromRate: folded.bpm / beatB.bpm,
          releaseSeconds: Math.max(0.5, Number(this.options.tempoReleaseMs ?? 4000) / 1000)
        })
      }
    }

    // Phase lock: shift the incoming song by less than one beat so its grid
    // falls exactly on the (possibly warped) grid of the outgoing one.
    let alignShift = 0
    if (confident && beatPeriod > 0) {
      let n = 0
      while (beatAt(n) < 0 && n < 64) n += 1
      alignShift = beatAlignOffset(beatPeriod, beatAt(n), beatB.phaseSamples, b.length, {
        maxFraction: this.options.cueTolerance ?? 0.6
      })
      if (alignShift > 0) b = sliceChannels(b, alignShift, b.length)
    }

    /* 5. blend length ------------------------------------------------------ */
    // Two facts about the pair decide both the length and the curve: how
    // well they correlate at the seam, and how hard the incoming song
    // enters. Measured over a fixed window so the answer does not depend on
    // the blend length we are about to choose from it.
    const seamWindow = Math.min(a.length, b.length, sec(1500))
    const r = seamWindow > 0 ? correlation(monoOf(a).subarray(0, seamWindow), monoOf(b).subarray(0, seamWindow), seamWindow) : 0

    const entryWindow = Math.min(b.left.length, Math.max(1, sec(1000)))
    let entrySum = 0
    for (let i = 0; i < entryWindow; i += 1) entrySum += (b.left[i] ?? 0) ** 2
    const entryEnergy = clamp(Math.sqrt(entrySum / entryWindow) * 4, 0, 1)

    // Smart Automix: how long should *this* blend be? (see smartCrossfadeMs)
    const smart = smartCrossfadeMs(
      {
        matched: Boolean(beatmatch),
        tempoDelta: Math.abs((beatA?.bpm ?? 0) - (beatB?.bpm ?? 0)),
        correlation: r,
        energy: entryEnergy,
        bpm: beatmatch ? beatmatch.toBpm : (beatB?.bpm ?? beatA?.bpm ?? null),
        available: ms(Math.min(a.length, b.length))
      },
      this.options
    )
    let fade = Math.min(sec(smart.ms), a.length, b.length)
    // Where the outgoing song's ending actually begins (its overlay point),
    // measured in the rendered timeline — the stretch moved it.
    const endingFrom = Math.max(0, Math.round((aEnd - cuesA.overlay) * tempoScale))
    if (endingFrom > sec(400)) fade = Math.min(fade, Math.max(sec(1000), endingFrom))

    let phrase = null
    if (confident && beatPeriod > 0) {
      // Whole beats only, and a whole phrase (4 beats) when one fits inside
      // the audio we are actually holding. Rounding up and then clamping
      // would silently put the blend back off the grid, so round down.
      const available = Math.min(fade, a.length, b.length)
      if (this.options.phraseBlend !== false) {
        // automix-engine maps a fixed count of beats (32) and lets the clock
        // follow the music; a radio seam is the same idea in the other
        // direction — the *length* is a whole number of phrases and the
        // milliseconds follow. A phrase is what a listener hears as "one
        // thing", so an eight-beat blend at 80 BPM and at 140 BPM are both
        // musically the same move.
        phrase = phraseBlend({ bpm: beatmatch ? beatmatch.toBpm : beatA.bpm, availableSamples: available, sampleRate, minBeats: 8, maxBeats: 64 })
        if (phrase) fade = Math.min(phrase.samples, Math.max(sec(400), phrase.samples))
      }
      let beats = Math.max(1, Math.floor(Math.min(fade, available) / beatPeriod))
      if (beats >= 4) beats -= beats % 4
      fade = Math.round(beats * beatPeriod)
      if (phrase) phrase = { ...phrase, beats, samples: fade, phrases: beats / 4 }
    }
    if (fade < sec(400)) return null

    /* 6. the mix ----------------------------------------------------------- */
    // Curve: correlation decides unless the owner pinned one.
    const exponent = this.options.curve === 'equal-power' ? 2 : this.options.curve === 'equal-gain' ? 1 : exponentFor(r)

    // Vocal-aware shaping (automix-engine's "do not fade a lyric mid-line").
    // Without stems the honest proxy is the band-energy gate in
    // `vocalActivity`: is anything singing on the outgoing seam, and if so,
    // where does the line end? The answer changes the *shape* of the faders,
    // never the length of the blend, so a misdetection costs a slightly
    // different curve rather than a wrong transition.
    let vocal = null
    let shape = null
    if (this.options.vocalAware !== false && confident) {
      const outMono = monoOf(a)
      const inMono = monoOf(b)
      const outActive = vocalActivity(outMono.subarray(0, Math.min(outMono.length, fade)), sampleRate)
      const inActive = vocalActivity(inMono.subarray(0, Math.min(inMono.length, Math.max(fade, sec(2000)))), sampleRate)
      const boundary = outActive.active
        ? phraseBoundary(outMono, sampleRate, 0, { beats: beatGrid(outMono.length, sampleRate, (beatmatch?.toBpm ?? beatA.bpm) || 120), maxWaitMs: Math.min(1600, ms(fade) * 0.4) })
        : null
      shape = vocalAwareCurves({
        outgoingActive: outActive.active,
        incomingActive: inActive.active,
        phraseEnd: boundary?.waited ? clamp(boundary.sample / Math.max(1, fade), 0.25, 0.9) : 0.6,
        exponent
      })
      vocal = {
        outgoing: outActive.active,
        incoming: inActive.active,
        shape: shape.shape,
        phraseEndMs: boundary?.waited ? ms(boundary.sample) : null,
        why: boundary?.reason ?? (outActive.active ? 'line continues' : 'no vocal at the seam')
      }
    }
    const gainFor = shape ? (t) => [shape.aGain(t), shape.bGain(t)] : (t) => fadeGains(t, exponent)

    // Voice first: it can make the rendered segment longer than the blend.
    let voice = null
    let dj = null
    if (this.#djDue()) {
      dj = djLine({
        from: tail.track,
        to: head[0]?.track,
        station: this.ctx.station?.name ?? 'the station',
        dj: this.options.dj.name,
        listeners: this.ctx.station?.subscribers?.size ?? 0,
        index: this.#breaks
      })
      voice = await this.#speak(dj.text, sampleRate)
      if (!voice) dj = null
      else this.#breaks += 1
    }

    const voiceStart = voice ? sec(this.options.dj.leadInMs) : 0
    const needed = Math.max(fade, voice ? voiceStart + voice.length + sec(this.options.dj.tailMs) : 0)
    const total = Math.min(needed, b.length, sec(this.options.maxRenderMs))

    // Apply the match gain to the incoming song for the seam, then ease it
    // back to the song's own level so the rest of the track is untouched.
    if (matchDb !== 0) {
      const bGained = { left: new Float32Array(total), right: new Float32Array(total), sampleRate, length: total }
      const restore = Math.max(1, sec(1500))
      for (let i = 0; i < total; i += 1) {
        const back = i > total - restore ? (i - (total - restore)) / restore : 0
        const g = matchGain + (1 - matchGain) * back
        bGained.left[i] = (b.left[i] ?? 0) * g
        bGained.right[i] = (b.right[i] ?? 0) * g
      }
      b = bGained
    }

    const left = new Float32Array(total)
    const right = new Float32Array(total)

    // Which transition? Either the one the owner named, or — the default —
    // one chosen for this particular seam (see chooseEffect).
    const wanted = this.options.effect ?? AUTO_EFFECT
    const seamDescription = {
      beat: confident,
      matched: Boolean(beatmatch),
      tempoDelta: Math.abs((beatA?.bpm ?? 0) - (beatB?.bpm ?? 0)),
      correlation: r,
      fadeMs: ms(fade),
      energy: entryEnergy,
      talkover: Boolean(voice),
      previous: this.options.varyEffects === false ? null : this.#lastEffect,
      // The model's richer view of the same seam: tempos on both sides, the
      // loudness gap, vocal activity, and the time of day.
      bpmOut: beatA?.bpm ?? 0,
      bpmIn: beatB?.bpm ?? 0,
      loudnessGap: matchDb,
      vocalOut: vocal?.outgoing ? 1 : 0,
      vocalIn: vocal?.incoming ? 1 : 0,
      phraseAligned: Boolean(phrase)
    }
    let choice = { effect: chooseEffect(seamDescription, this.options.effectPool ?? []), source: 'heuristic' }
    if (wanted === AUTO_EFFECT || !EFFECT_RENDERERS[wanted]) {
      // The DJ model, when one is loaded and the owner has not turned it off.
      // A model is an *opinion*, not a requirement: `score()` returns null for
      // every failure mode, and the heuristic then answers as it always did.
      if (this.options.model !== false) {
        const host = await loadModels()
        const scored = host ? host.score(seamDescription) : null
        if (scored) choice = chooseEffectWithModel(seamDescription, this.options.effectPool ?? [], scored)
      }
      this.#lastModel = choice.model ?? null
    }
    const effect = wanted === AUTO_EFFECT || !EFFECT_RENDERERS[wanted] ? choice.effect : wanted
    this.#lastEffect = effect

    EFFECT_RENDERERS[effect]({
      a,
      b,
      left,
      right,
      fade,
      total,
      gainFor,
      sampleRate,
      options: this.options,
      beatSamples: confident ? beatPeriod : 0
    })

    /* 7. the DJ, over a real sidechain ducker ------------------------------ */
    if (voice) this.#voiceTrack({ left, right, voice, voiceStart, sampleRate })

    /* 8. make it joinable -------------------------------------------------- */
    // The seam is spliced between audio nobody rendered; every effect leaves
    // its own mess at the edges. This is what lets one transition follow
    // another without a click between them.
    smoothEdges(left, right, sampleRate)

    /* 9. peak ceiling ------------------------------------------------------ */
    const ceiling = DB(this.options.ceilingDb)
    const peak = samplePeak([left, right])
    if (peak > ceiling) {
      const g = ceiling / peak
      for (let i = 0; i < total; i += 1) {
        left[i] *= g
        right[i] *= g
      }
    }

    /* 10. back to MP3 ------------------------------------------------------ */
    const bitrate = Math.max(96, Math.min(320, head[0]?.track?.streamBitrate ?? this.options.bitrate ?? 128))
    const mp3 = await encodeMp3({ left, right, sampleRate, bitrate })
    const parsed = new MetroFramer().push(mp3)
    if (parsed.frames.length === 0) return null

    const frameMs = parsed.durationMs / parsed.frames.length
    const track = { ...head[0].track, automix: true, mixedFrom: tail.track?.title ?? null, dj: dj?.text ?? null }
    const frames = parsed.frames.map((data) => ({ data, ms: frameMs, track }))

    // Whatever of the incoming song the render did not consume is aired as it
    // arrived (plus whatever was trimmed off the front, which is silence).
    const consumedMs = ms(total + bStart + alignShift)
    let skipped = 0
    const rest = []
    for (const frame of head) {
      skipped += frame.ms
      if (skipped > consumedMs) rest.push(frame)
    }

    return {
      frames: [...frames, ...rest],
      report: {
        from: tail.track?.title ?? null,
        to: head[0]?.track?.title ?? null,
        effect,
        // Was this one chosen for the seam, or named by the owner?
        chosen: (this.options.effect ?? AUTO_EFFECT) === AUTO_EFFECT,
        // Which brain chose it, and what the other one would have picked. An
        // owner looking at a surprising transition can see the disagreement
        // rather than having to infer it.
        decision: {
          source: (this.options.effect ?? AUTO_EFFECT) === AUTO_EFFECT ? choice.source : 'owner',
          baseline: (this.options.effect ?? AUTO_EFFECT) === AUTO_EFFECT ? choice.baseline : null,
          margin: choice.margin ?? null,
          model: choice.model ?? null
        },
        entryEnergy: Number(entryEnergy.toFixed(2)),
        curve: exponent >= 1.95 ? 'equal-power' : exponent <= 1.05 ? 'equal-gain' : `blend(${exponent.toFixed(2)})`,
        correlation: Number(r.toFixed(3)),
        blendMs: ms(fade),
        // Smart Automix: what it asked for, and why.
        blend: { requestedMs: this.options.crossfadeMs, chosenMs: smart.ms, bars: smart.bars, why: smart.why },
        renderedMs: ms(total),
        loudness: {
          from: loudA == null ? null : Number(loudA.toFixed(1)),
          to: loudB == null ? null : Number(loudB.toFixed(1)),
          appliedDb: Number(matchDb.toFixed(1))
        },
        cues: { trimmedHeadMs: ms(bStart), trimmedTailMs: ms(a0.length - aEnd), endingFromMs: ms(endingFrom) },
        beat: {
          aligned: confident && alignShift > 0,
          matched: Boolean(beatmatch),
          bpm: beatA?.bpm ?? null,
          incomingBpm: beatB?.bpm ?? null,
          playedAtBpm: beatmatch ? beatmatch.toBpm : (beatA?.bpm ?? null),
          stretchPercent: beatmatch?.stretchPercent ?? 0,
          shiftMs: ms(alignShift),
          beatsInBlend: beatPeriod ? Math.round(fade / beatPeriod) : 0,
          confidence: beatA ? Number(beatA.confidence.toFixed(2)) : null,
          // Joint tempo analysis: the pair chosen, and how well it agrees.
          pair: pairChoice
            ? { bpmA: pairChoice.bpmA, bpmB: pairChoice.bpmB, compatibility: pairChoice.compatibility, source: 'pair' }
            : { source: 'scalar' },
          // Phrase-aligned blend length (automix-engine's 32-beat map, here).
          phrase: phrase ? { beats: phrase.beats, phrases: phrase.phrases, beatMs: ms(phrase.beatSamples) } : null,
          // Tempo release: how long the incoming song takes to reach native speed.
          releaseMs: release ? ms(release.releaseSamples) : null
        },
        vocal,
        peakDb: Number(TO_DB(Math.min(peak, ceiling)).toFixed(1)),
        dj: dj ? { kind: dj.kind, text: dj.text } : null
      }
    }
  }

  /**
   * Mix the DJ over the bed: the voice is compressed, the music is ducked by
   * a sidechain compressor keyed off the voice, and the bed is high-passed
   * while the line runs so the words sit in their own space.
   */
  #voiceTrack({ left, right, voice, voiceStart, sampleRate }) {
    const dj = this.options.dj
    const control = new Float32Array(left.length)
    for (let i = 0; i < voice.length; i += 1) {
      const j = voiceStart + i
      if (j >= 0 && j < control.length) control[j] = voice.data[i]
    }

    const duck = compressorGain(control, sampleRate, {
      thresholdDb: dj.thresholdDb,
      ratio: dj.ratio,
      attackMs: dj.attackMs,
      releaseMs: dj.releaseMs,
      rangeDb: Number(dj.duckDb) || -9
    })

    const bedHp = [Biquad.highpass(dj.bedHighpassHz ?? 180, sampleRate), Biquad.highpass(dj.bedHighpassHz ?? 180, sampleRate)]
    for (let i = 0; i < left.length; i += 1) {
      const gain = duck[i]
      // How much of the high-passed bed to use: only while it is ducked.
      const blend = clamp((1 - gain) / Math.max(0.001, 1 - DB(Number(dj.duckDb) || -9)), 0, 1)
      const l = left[i] * (1 - blend) + bedHp[0].process(left[i]) * blend
      const r = right[i] * (1 - blend) + bedHp[1].process(right[i]) * blend
      left[i] = l * gain + (control[i] ?? 0)
      right[i] = r * gain + (control[i] ?? 0)
    }
  }

  /** Render the DJ line through the station's TTS engine, then condition it. */
  async #speak(text, sampleRate) {
    try {
      const id = `tts:dj:${createHash('sha1').update(text).digest('hex').slice(0, 12)}`
      const opened = await this.ctx.sources.stream(
        { source: 'tts', id, title: 'DJ', artist: this.options.dj.name, text, announcement: true, duration: 0, bitrate: 128, streamable: true },
        {}
      )
      const chunks = []
      for await (const chunk of opened.stream) chunks.push(chunk)
      const pcm = await decodeMp3(Buffer.concat(chunks))
      if (!pcm) return null
      const fitted = fitRate(pcm, sampleRate)

      // Mono, de-rumbled, compressed like a voice channel, then normalised to
      // the DJ target so every line sits at the same level over the bed.
      const hp = Biquad.highpass(90, sampleRate)
      const mono = new Float32Array(fitted.left.length)
      for (let i = 0; i < mono.length; i += 1) mono[i] = hp.process((fitted.left[i] + fitted.right[i]) / 2)

      const gains = compressorGain(mono, sampleRate, { thresholdDb: -26, ratio: 3, attackMs: 2, releaseMs: 80, kneeDb: 6 })
      for (let i = 0; i < mono.length; i += 1) mono[i] *= gains[i]

      const loud = integratedLoudness([mono, mono], sampleRate)
      let gain = 1
      if (loud != null) gain = DB(clamp((this.options.dj.voiceTargetLufs ?? -14) - loud, -12, 18))
      const peak = samplePeak([mono])
      if (peak * gain > 0.89) gain = 0.89 / Math.max(1e-6, peak)
      for (let i = 0; i < mono.length; i += 1) mono[i] *= gain

      return { data: mono, length: mono.length }
    } catch (error) {
      this.log.debug(`dj voice failed: ${error.message}`)
      return null
    }
  }
}

export default Automix
