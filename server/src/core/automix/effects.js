/**
 * Choosing a transition: smart blend length, traits, the heuristic, and the
 * model folded over it. Also the edge smoothing that makes a seam joinable.
 */
import { clamp } from '../dsp.js'
import { DEFAULT_AUTOMIX, EFFECTS } from './defaults.js'

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

  const {
    matched = false,
    tempoDelta = 99,
    correlation = 0,
    energy = 0.5,
    bpm = null,
    available = Infinity,
    vocal = null
  } = seam

  let factor = 1
  const reasons = []

  if (matched && tempoDelta < 1) {
    factor *= 2.2
    reasons.push('tempos locked')
  } else if (matched && tempoDelta < 3) {
    factor *= 1.5
    reasons.push('tempos close')
  } else if (matched) {
    // Folded and holding: the grid already reconciled a wider raw gap.
    factor *= 1.15
    reasons.push('tempos folded together')
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

  // Two vocals over each other is the one thing a crossfade cannot fix: one
  // lyric in each ear reads as a mistake, not a mix. Shorten the overlap so
  // the lines hand over instead of colliding. This is a length decision, so
  // it belongs here rather than in the curve shaping below.
  if (vocal?.outgoing && vocal?.incoming) {
    factor *= 0.7
    reasons.push('vocals would clash')
  } else if (vocal?.outgoing || vocal?.incoming) {
    factor *= 0.9
    reasons.push('vocal at the seam')
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
 * `maxTempoDelta` — the largest *unmatched* tempo gap, in BPM, it survives.
 *                A roll on two records 12 BPM apart is two rolls; the grid it
 *                needs is not the one the other song is playing.
 */
export const EFFECT_TRAITS = {
  crossfade: { needsBeat: false, needsMatch: false, energy: 0.1, length: 800 },
  wash: { needsBeat: false, needsMatch: false, energy: 0.25, length: 2500 },
  filter: { needsBeat: false, needsMatch: false, energy: 0.35, length: 2000 },
  echo: { needsBeat: false, needsMatch: false, energy: 0.5, length: 1500 },
  'bass-swap': { needsBeat: true, needsMatch: true, energy: 0.45, length: 2500, maxTempoDelta: 3 },
  sweep: { needsBeat: false, needsMatch: false, energy: 0.6, length: 2500 },
  roll: { needsBeat: true, needsMatch: false, energy: 0.8, length: 2000, maxTempoDelta: 5 },
  drop: { needsBeat: true, needsMatch: false, energy: 0.85, length: 1500, maxTempoDelta: 7 },
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
  const matched = !traits?.needsMatch || Boolean(seam.matched)
  const long = !traits || (seam.fadeMs ?? 6000) >= traits.length
  const drift = seam.matched ? 0 : (seam.tempoDelta ?? 99)
  const tempoOk = traits?.maxTempoDelta == null || drift <= traits.maxTempoDelta
  if (!usable || !matched || !long || !tempoOk) return { effect: baseline, source: 'heuristic', margin: model.margin, baseline }

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
    previous = null,
    vocalOut = 0,
    vocalIn = 0
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
  // A vocal clash wants the music to get out of the way, not to perform.
  const vocalClash = vocalOut > 0.5 && vocalIn > 0.5
  const vocalSolo = (vocalOut > 0.5) !== (vocalIn > 0.5)
  if (vocalClash) want -= 0.12
  want = clamp(want, 0, 1)

  const scored = allowed
    .filter((name) => {
      const traits = EFFECT_TRAITS[name]
      if (traits.needsBeat && !beat) return false
      if (traits.needsMatch && !matched) return false
      // Only an unmatched gap disqualifies: a folded match has already
      // reconciled the two grids, whatever their raw BPM difference was.
      if (!matched && traits.maxTempoDelta != null && tempoDelta > traits.maxTempoDelta) return false
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
      // Two lyrics at once: prefer a transition that masks or filters one of
      // them. A bass-swap keeps both vocals untouched and is the worst case.
      if (vocalClash) {
        if (name === 'bass-swap' || name === 'drop' || name === 'slam' || name === 'roll') score -= 0.22
        if (name === 'filter' || name === 'echo') score += 0.12
      } else if (vocalSolo && (name === 'drop' || name === 'slam')) {
        score -= 0.1
      }
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

