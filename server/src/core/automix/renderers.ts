/**
 * The ten built-in transitions, and the registry plugins extend.
 */
import { clamp } from '../dsp.ts'
import {
  Biquad,
  Crossover,
  DB,
  brake,
  echoTail,
  noiseSource
} from '../dsp.ts'
import { BUILT_IN_EFFECTS, EFFECTS } from './defaults.ts'

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

export const EFFECT_RENDERERS = {
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

