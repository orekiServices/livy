/**
 * Crossfade policy: choose a safe, musical blend length and keep the edges
 * joinable. Transition effects other than a crossfade are intentionally not
 * part of Livy's Automix registry.
 */
import { clamp } from '../dsp/index.ts'
import { DEFAULT_AUTOMIX, EFFECTS } from './defaults.ts'

/**
 * How long should this crossfade last?
 *
 * This is a small deterministic policy over the seam's tempo, correlation,
 * energy and vocal activity. The learned outcome model can refine the length
 * later, but it cannot change the transition type.
 */
export function smartCrossfadeMs(seam: any = {}, options: any = {}) {
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
  const reasons: string[] = []

  if (matched && tempoDelta < 1) {
    factor *= 2.2
    reasons.push('tempos locked')
  } else if (matched && tempoDelta < 3) {
    factor *= 1.5
    reasons.push('tempos close')
  } else if (matched) {
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

  if (vocal?.outgoing && vocal?.incoming) {
    factor *= 0.7
    reasons.push('vocals would clash')
  } else if (vocal?.outgoing || vocal?.incoming) {
    factor *= 0.9
    reasons.push('vocal at the seam')
  }

  let ms = clamp(requested * factor, floor, Math.min(ceiling, available))
  let bars: number | null = null
  if (bpm && bpm > 40) {
    const barMs = (60_000 / bpm) * 4
    bars = Math.max(1, Math.round(ms / barMs))
    const rounded = bars * barMs
    if (rounded >= floor && rounded <= Math.min(ceiling, available)) ms = rounded
    else bars = null
  }

  return { ms: Math.round(ms), bars, why: reasons.length ? reasons.join(', ') : 'as configured' }
}

/** The only supported transition's traits. */
export const EFFECT_TRAITS = Object.freeze({
  crossfade: { needsBeat: false, needsMatch: false, energy: 0.1, length: 400 }
})

/** A crossfade is always the safe answer; no model can select an effect. */
export function chooseEffect(_seam: any = {}, _pool: any = []) {
  return 'crossfade'
}

/** The learned model ranks blend outcomes, not transition effects. */
export function chooseEffectWithModel(_seam: any = {}, _pool: any = [], _model: any = null) {
  return { effect: 'crossfade', source: 'crossfade-only', margin: 0, baseline: 'crossfade' }
}

/** The transition ranking API now has one possible result. */
export function rankEffects(_seam: any = {}, pool: any = []) {
  if (pool.length && !pool.includes('crossfade')) return []
  return [{ name: 'crossfade', score: 1 }]
}

/** Reject old transition names even when a stale model or config mentions one. */
export function effectUsable(name: string, _seam?: any) {
  return name === 'crossfade'
}

/**
 * Make a rendered seam joinable. The renderer calls this before joining the
 * result to the untouched programme; a DC blocker plus optional raised-cosine
 * edge ramps avoid clicks without fading the seam itself to silence.
 */
export function smoothEdges(left: Float32Array, right: Float32Array, sampleRate: number, { fadeMs = 2, dcBlock = true }: any = {}) {
  const n = left.length
  if (n === 0) return

  if (dcBlock) {
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

  if (!(fadeMs > 0)) return
  const ramp = Math.max(1, Math.min(Math.round((fadeMs / 1000) * sampleRate), Math.floor(n / 2)))
  for (let i = 0; i < ramp; i += 1) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp)
    left[i] *= g
    right[i] *= g
    left[n - 1 - i] *= g
    right[n - 1 - i] *= g
  }
}

export { EFFECTS }
