/**
 * Perceptual & musical transition quality evaluator for AutoMix.
 *
 * Scores candidate transitions across 8 explicit musical dimensions so the
 * planner can compare candidates, pick the highest-quality mix, and trigger
 * a clean smart-crossfade fallback whenever no beat-matched plan clears the
 * quality bar.
 */
import { clamp } from '../dsp.ts'
import {
  harmonicCompatibility,
  rhythmSimilarity,
  type CueCandidate,
  type HarmonicMatch,
  type SectionType,
  type TrackStructure
} from './structure.ts'
import type { AutomationPlan } from './blender.ts'

export interface TransitionMetrics {
  /** Beat & downbeat synchronization + tempo stretch faithfulness (0..1). */
  beatSync: number
  /** 8-/16-/32-bar phrase alignment & structural section pairing (0..1). */
  phraseAlignment: number
  /** Camelot wheel tonal consonance (0..1). */
  harmonicCompatibility: number
  /** Vocal overlap avoidance & lyric intelligibility protection (0..1). */
  vocalIntelligibility: number
  /** Sub-bass exclusivity & frequency-band conflict avoidance (0..1). */
  spectralBalance: number
  /** BS.1770 loudness continuity across the seam (0..1). */
  loudnessContinuity: number
  /** Natural musical energy progression between sections (0..1). */
  energyProgression: number
  /** Curve smoothness, groove compatibility, and low stretch distortion (0..1). */
  perceptualSmoothness: number
}

export interface TransitionEvaluation {
  /** Weighted composite transition quality score (0..1). */
  overall: number
  metrics: TransitionMetrics
  harmonic: HarmonicMatch
  rhythmMatch: number
  warnings: string[]
  /** True when beat-matched mixing is unreliable and a smart fallback is safer. */
  fallbackRecommended: boolean
}

export interface CandidateTransitionInput {
  trackA: TrackStructure
  trackB: TrackStructure
  cueOut: CueCandidate
  cueIn: CueCandidate
  durationSec: number
  durationBars: number
  beatMatched: boolean
  stretchPercent: number
  downbeatAligned: boolean
  correlation?: number
  appliedGainDb?: number
  plan: AutomationPlan
}

const WEIGHTS: Record<keyof TransitionMetrics, number> = {
  beatSync: 0.2,
  phraseAlignment: 0.14,
  harmonicCompatibility: 0.14,
  vocalIntelligibility: 0.14,
  spectralBalance: 0.13,
  loudnessContinuity: 0.08,
  energyProgression: 0.08,
  perceptualSmoothness: 0.09
}

// Structural pairing matrix: how natural it sounds to mix out of section A into section B.
const SECTION_COMPAT: Record<SectionType, Record<SectionType, number>> = {
  outro: { intro: 1.0, breakdown: 0.9, verse: 0.82, buildup: 0.78, drop: 0.7, chorus: 0.65, outro: 0.45 },
  breakdown: { intro: 0.94, breakdown: 0.88, buildup: 0.9, verse: 0.82, drop: 0.8, chorus: 0.68, outro: 0.5 },
  verse: { intro: 0.86, breakdown: 0.8, verse: 0.7, buildup: 0.76, chorus: 0.65, drop: 0.62, outro: 0.45 },
  chorus: { intro: 0.88, breakdown: 0.84, verse: 0.72, drop: 0.7, buildup: 0.66, chorus: 0.45, outro: 0.4 },
  drop: { intro: 0.8, breakdown: 0.85, drop: 0.65, verse: 0.62, buildup: 0.55, chorus: 0.5, outro: 0.4 },
  buildup: { drop: 0.95, chorus: 0.84, intro: 0.62, breakdown: 0.58, verse: 0.52, buildup: 0.45, outro: 0.3 },
  intro: { intro: 0.65, verse: 0.6, breakdown: 0.6, buildup: 0.55, chorus: 0.5, drop: 0.5, outro: 0.35 }
}

/** Measure average smoothness of an automation curve (penalizes jagged jumps). */
function curveSmoothness(knots: number[]): number {
  if (knots.length < 3) return 1
  let totalJerk = 0
  for (let i = 1; i < knots.length - 1; i += 1) {
    const secondDiff = Math.abs(knots[i + 1] - 2 * knots[i] + knots[i - 1])
    totalJerk += secondDiff
  }
  const avgJerk = totalJerk / (knots.length - 2)
  return clamp(1 - avgJerk * 1.4, 0.1, 1)
}

/** Evaluate a candidate transition plan across all 8 musical dimensions. */
export function evaluateTransition(input: CandidateTransitionInput): TransitionEvaluation {
  const {
    trackA,
    trackB,
    cueOut,
    cueIn,
    durationBars,
    beatMatched,
    stretchPercent,
    downbeatAligned,
    plan
  } = input
  const correlation = Number.isFinite(input.correlation) ? (input.correlation as number) : 0.2
  const appliedGainDb = Number.isFinite(input.appliedGainDb) ? (input.appliedGainDb as number) : 0
  const warnings: string[] = []
  const c = plan.curves

  /* 1. Beat & downbeat synchronization ------------------------------------ */
  const conf = Math.min(trackA.bpmConfidence, trackB.bpmConfidence)
  const absStretch = Math.abs(stretchPercent)
  let beatSync: number
  if (beatMatched) {
    const stretchPenalty = absStretch <= 3 ? 0 : clamp((absStretch - 3) / 14, 0, 0.55)
    const downbeatBonus = downbeatAligned ? 0.15 : 0
    beatSync = clamp(0.45 + 0.4 * conf + downbeatBonus - stretchPenalty, 0, 1)
    if (absStretch > 9) warnings.push(`large tempo stretch (${absStretch.toFixed(1)}%)`)
  } else {
    // Non-beatmatched transition: only high if using an escape hatch (echo/wash/filter/spindown)
    const nonBeatFriendly = ['echo', 'wash', 'reverb-wash', 'filter', 'spindown', 'crossfade'].includes(plan.strategy)
    beatSync = nonBeatFriendly ? clamp(0.55 - 0.15 * conf, 0.25, 0.65) : 0.2
    if (conf > 0.45) warnings.push('tempos could not be beatmatched cleanly')
  }

  /* 2. Phrase alignment & section pairing --------------------------------- */
  const phraseBonusOut = cueOut.phraseBars >= 16 ? 1.0 : cueOut.phraseBars === 8 ? 0.92 : cueOut.phraseBars === 4 ? 0.78 : 0.45
  const phraseBonusIn = cueIn.phraseBars >= 16 ? 1.0 : cueIn.phraseBars === 8 ? 0.92 : cueIn.phraseBars === 4 ? 0.78 : 0.45
  const durIsMusicalPhrase = durationBars === 8 || durationBars === 16 || durationBars === 32 ? 1.0 : durationBars === 4 ? 0.85 : 0.6
  const sectionPair = SECTION_COMPAT[cueOut.sectionType]?.[cueIn.sectionType] ?? 0.65
  const phraseAlignment = clamp(
    0.35 * ((phraseBonusOut + phraseBonusIn) * 0.5) + 0.35 * sectionPair + 0.3 * durIsMusicalPhrase,
    0,
    1
  )

  /* 3. Harmonic compatibility (Camelot wheel) ----------------------------- */
  const harmonic = harmonicCompatibility(trackA.key, trackB.key)
  let harmonicScore = harmonic.score
  if (harmonic.relation === 'clash') {
    warnings.push(`key clash (${trackA.key.camelot} → ${trackB.key.camelot})`)
    // Short/filtered/echo/wash transitions soften a key clash better than long open blends.
    if (['echo', 'wash', 'reverb-wash', 'filter', 'spindown', 'drop', 'slam'].includes(plan.strategy)) {
      harmonicScore = clamp(harmonicScore + 0.18, 0, 1)
    }
  }

  /* 4. Vocal overlap & intelligibility ------------------------------------ */
  const vocA = cueOut.vocalFree ? Math.min(0.25, trackA.vocalDensity) : Math.max(0.55, trackA.vocalDensity)
  const vocB = cueIn.vocalFree ? Math.min(0.25, trackB.vocalDensity) : Math.max(0.55, trackB.vocalDensity)
  let vocalConflict = 0
  for (let i = 0; i < c.knots; i += 1) {
    const activeA = vocA * c.midA[i] * c.gainA[i] * (1 - 0.85 * c.vocalDuckA[i])
    const activeB = vocB * c.midB[i] * c.gainB[i] * (1 - 0.85 * c.vocalDuckB[i])
    vocalConflict += activeA * activeB
  }
  vocalConflict /= Math.max(1, c.knots)
  const vocalIntelligibility = clamp(1 - vocalConflict * 2.4, 0.1, 1)
  if (vocalIntelligibility < 0.55) warnings.push('potential vocal overlap across transition')

  /* 5. Bass & spectral balance -------------------------------------------- */
  let maxBassSum = 0
  let avgBassOverlap = 0
  let midMasking = 0
  const bassWeight = clamp((cueOut.bassDensity + cueIn.bassDensity) * 1.4, 0.25, 1)
  for (let i = 0; i < c.knots; i += 1) {
    const lA = c.lowA[i] * c.gainA[i]
    const lB = c.lowB[i] * c.gainB[i]
    const sum = lA + lB
    if (sum > maxBassSum) maxBassSum = sum
    avgBassOverlap += Math.min(lA, lB)
    const mA = c.midA[i] * c.gainA[i]
    const mB = c.midB[i] * c.gainB[i]
    midMasking += Math.max(0, mA + mB - 1.35)
  }
  avgBassOverlap /= Math.max(1, c.knots)
  midMasking /= Math.max(1, c.knots)
  const bassPenalty = Math.max(0, maxBassSum - 1.08) * 1.2 + avgBassOverlap * 0.65 * bassWeight
  const spectralBalance = clamp(1 - bassPenalty - midMasking * 0.6, 0.1, 1)
  if (maxBassSum > 1.35 && bassWeight > 0.5) warnings.push('overlapping low-end energy risk')

  /* 6. Loudness continuity ------------------------------------------------ */
  const rawGap =
    trackA.loudnessLufs != null && trackB.loudnessLufs != null ? Math.abs(trackA.loudnessLufs - trackB.loudnessLufs) : Math.abs(appliedGainDb)
  const residualGap = Math.max(0, rawGap - Math.abs(appliedGainDb))
  const loudnessContinuity = clamp(1 - residualGap / 14 - Math.abs(appliedGainDb) / 24, 0.2, 1)

  /* 7. Energy progression ------------------------------------------------- */
  // Moderate positive or matched energy feels natural; sudden massive drops
  // (except intentional breakdown/wash) feel abrupt.
  const energyDelta = cueIn.energy - cueOut.energy
  const absDelta = Math.abs(energyDelta)
  let energyProgression = clamp(1 - absDelta * 0.85, 0.25, 1)
  if (energyDelta > 0.05 && energyDelta < 0.35) energyProgression = clamp(energyProgression + 0.1, 0, 1)
  if (absDelta > 0.55) warnings.push('steep energy jump between sections')

  /* 8. Perceptual smoothness ---------------------------------------------- */
  const rhythmMatch = rhythmSimilarity(trackA.rhythmPattern, trackB.rhythmPattern)
  const corrScore = clamp((correlation + 0.4) / 1.2, 0.2, 1)
  const envSmooth =
    (curveSmoothness(c.gainA) + curveSmoothness(c.gainB) + curveSmoothness(c.lowA) + curveSmoothness(c.lowB)) / 4
  const stretchArtifactPenalty = beatMatched ? clamp(Math.max(0, absStretch - 6) / 15, 0, 0.35) : 0
  const perceptualSmoothness = clamp(
    0.35 * envSmooth + 0.3 * rhythmMatch + 0.35 * corrScore - stretchArtifactPenalty,
    0.1,
    1
  )

  const metrics: TransitionMetrics = {
    beatSync: Number(beatSync.toFixed(4)),
    phraseAlignment: Number(phraseAlignment.toFixed(4)),
    harmonicCompatibility: Number(harmonicScore.toFixed(4)),
    vocalIntelligibility: Number(vocalIntelligibility.toFixed(4)),
    spectralBalance: Number(spectralBalance.toFixed(4)),
    loudnessContinuity: Number(loudnessContinuity.toFixed(4)),
    energyProgression: Number(energyProgression.toFixed(4)),
    perceptualSmoothness: Number(perceptualSmoothness.toFixed(4))
  }

  const overall = Number(
    clamp(
      WEIGHTS.beatSync * metrics.beatSync +
        WEIGHTS.phraseAlignment * metrics.phraseAlignment +
        WEIGHTS.harmonicCompatibility * metrics.harmonicCompatibility +
        WEIGHTS.vocalIntelligibility * metrics.vocalIntelligibility +
        WEIGHTS.spectralBalance * metrics.spectralBalance +
        WEIGHTS.loudnessContinuity * metrics.loudnessContinuity +
        WEIGHTS.energyProgression * metrics.energyProgression +
        WEIGHTS.perceptualSmoothness * metrics.perceptualSmoothness,
      0,
      1
    ).toFixed(4)
  )

  const fallbackRecommended =
    (!beatMatched && (conf < 0.25 || absStretch > 12)) ||
    (overall < 0.48 && metrics.beatSync < 0.4) ||
    (harmonic.relation === 'clash' && !beatMatched)

  return {
    overall,
    metrics,
    harmonic,
    rhythmMatch: Number(rhythmMatch.toFixed(3)),
    warnings,
    fallbackRecommended
  }
}
