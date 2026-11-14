/**
 * Intelligent Multi-Candidate Transition Planner for AutoMix.
 *
 * Given two analysed tracks (Track A outgoing, Track B incoming):
 *   1. Identifies ranked musical mix-out and mix-in phrase cue candidates
 *      (preferring 8-, 16-, and 32-bar phrase boundaries & compatible sections).
 *   2. Optionally queries the Neural AutoMix model for Stage-1 cue/duration
 *      predictions and Stage-2 continuous automation curves.
 *   3. Generates multiple candidate transition plans across cue pairs,
 *      musical phrase durations, and dynamic DJ strategies.
 *   4. Scores every candidate with the 8-dimension Transition Quality Evaluator.
 *   5. Picks the top-ranked plan — or gracefully falls back to a musically
 *      clean smart crossfade/wash/echo when no reliable beat-matched blend
 *      exists.
 */
import { clamp, exponentFor, foldTempo } from '../dsp.ts'
import { MemoryLruCache } from '../cache.ts'
import {
  analyzeTrackStructure,
  harmonicCompatibility,
  type CueCandidate,
  type TrackStructure
} from './structure.ts'
import {
  buildAutomationPlan,
  sanitizeAutomationPlan,
  type AutomationPlan
} from './blender.ts'
import { evaluateTransition, type TransitionEvaluation } from './evaluator.ts'
import { neuralAutomix, type DecodedNeuralPlan, type NeuralAutoMixHost } from '../models/neuralAutomix.ts'
import { resolveScalingTier, type ResolvedScalingTier } from '../models/scaling.ts'

export interface CandidatePlan {
  id: string
  cueOut: CueCandidate
  cueIn: CueCandidate
  durationSec: number
  durationMs: number
  durationBars: number
  strategy: string
  beatMatched: boolean
  foldedBpm: number
  stretchPercent: number
  downbeatAligned: boolean
  plan: AutomationPlan
  evaluation: TransitionEvaluation
  rankScore: number
  isFallback: boolean
}

export interface TransitionPlanResult {
  selected: CandidatePlan
  candidates: CandidatePlan[]
  trackA: TrackStructure
  trackB: TrackStructure
  neural: DecodedNeuralPlan | null
  scaling: ResolvedScalingTier | null
  fallbackUsed: boolean
  fallbackReason: string | null
  planningMs: number
  cached: boolean
}

export interface PlanTransitionOptions {
  /** Allowed blend length bounds in milliseconds. */
  minCrossfadeMs?: number
  maxCrossfadeMs?: number
  requestedCrossfadeMs?: number
  /** Maximum available overlap duration in milliseconds (e.g. held seam buffer). */
  availableMs?: number
  /** Maximum tolerable tempo stretch percentage (default 12%). */
  maxStretchPercent?: number
  /** Waveform correlation measured at seam (-1..1). */
  correlation?: number
  /** Gain applied to match incoming loudness (dB). */
  appliedGainDb?: number
  /** Crossover frequencies (Hz). */
  lowHz?: number
  highHz?: number
  /** DJ talkover active over this seam. */
  talkover?: boolean
  /** Previously used strategy (penalized lightly to keep variety). */
  previousStrategy?: string | null
  /** Restrict strategy set if owner pinned an effectPool. */
  allowedStrategies?: string[]
  /** Optional custom NeuralAutoMixHost (defaults to global `neuralAutomix`). */
  neuralHost?: NeuralAutoMixHost | null
  /** Enable neural predictions when a model is loaded (default true). */
  useNeural?: boolean
  /** Minimum quality score required to keep a beat-matched transition (default 0.50). */
  minBeatMatchQuality?: number
  /** Optional cache key to memoize full transition plan. */
  cacheKey?: string
  bypassCache?: boolean
  /** Prefer continuous blending strategies when stems are provided. */
  hasStems?: boolean
  /**
   * Optional observed seam count enabling progressive capacity scaling:
   * more seams -> more unlocked transitions & wider candidate search.
   */
  seamCount?: number
  /** Enforce unlocked strategy set from `resolveScalingTier(seamCount)`. */
  progressiveScaling?: boolean
}

const planCache = new MemoryLruCache({
  name: 'automix-plan',
  maxEntries: 256,
  ttlMs: 15 * 60_000
})

export function clearPlanCache(): void {
  planCache.clear()
}

export function planCacheStats() {
  return planCache.stats()
}

/** Choose musically valid phrase bar counts (4 / 8 / 16 / 32) that fit available duration. */
function candidateBarCounts(bpm: number, minMs: number, maxMs: number, preferredBars?: number): number[] {
  const barMs = bpm > 40 ? (60_000 / bpm) * 4 : 2000
  const standard = [8, 16, 32, 4]
  const valid: number[] = []
  for (const bars of standard) {
    const ms = bars * barMs
    if (ms >= minMs * 0.85 && ms <= maxMs * 1.05) valid.push(bars)
  }
  if (preferredBars && !valid.includes(preferredBars)) {
    const ms = preferredBars * barMs
    if (ms >= minMs * 0.8 && ms <= maxMs * 1.05) valid.unshift(preferredBars)
  }
  if (valid.length === 0) {
    const nearest = Math.max(1, Math.min(32, Math.round(clamp(maxMs * 0.6, minMs, maxMs) / barMs)))
    valid.push(nearest)
  }
  return valid.slice(0, 3)
}

/** Pick contextually appropriate strategies to evaluate for this track pair. */
function candidateStrategies(params: {
  beatMatched: boolean
  harmonicScore: number
  vocalClash: boolean
  vocalOut: boolean
  vocalIn: boolean
  energyDelta: number
  stretchPercent: number
  talkover: boolean
  hasStems: boolean
  neuralStrategy?: string | null
  allowed?: string[]
  maxStrategies?: number
}): string[] {
  const pool = new Set<string>()
  if (params.neuralStrategy) pool.add(params.neuralStrategy)
  if (params.hasStems && params.beatMatched) pool.add('stem-handoff')

  if (params.talkover) {
    pool.add('crossfade')
    pool.add('eq-blend')
    pool.add('filter')
  } else if (params.beatMatched) {
    pool.add('eq-blend')
    pool.add('bass-swap')
    pool.add('phrase-cut')
    if (params.vocalClash || (params.vocalOut && !params.vocalIn)) {
      pool.add('vocal-bridge')
    }
    if (Math.abs(params.stretchPercent) >= 3) {
      pool.add('tempo-ramp')
    }
    if (params.harmonicScore >= 0.85 && params.energyDelta >= 0.1) {
      pool.add('harmonic-drop')
    }
    if (params.vocalClash || params.harmonicScore < 0.65) {
      pool.add('filter')
      pool.add('echo')
    }
    if (params.energyDelta < -0.2 || params.harmonicScore < 0.5) {
      pool.add('wash')
    }
    if (params.harmonicScore >= 0.8 && !params.vocalClash) {
      pool.add('crossfade')
    }
  } else {
    pool.add('crossfade')
    pool.add('wash')
    pool.add('filter')
    pool.add('echo')
  }

  let list = [...pool]
  if (params.allowed && params.allowed.length > 0) {
    const allowSet = new Set(params.allowed)
    const filtered = list.filter((s) => allowSet.has(s))
    if (filtered.length > 0) list = filtered
  }
  return list.slice(0, Math.max(4, params.maxStrategies ?? 7))
}

/**
 * Plan the optimal transition between Track A and Track B by generating,
 * scoring, and ranking multiple musical candidates (with graceful smart fallback).
 */
export function planTransition(
  trackA: TrackStructure,
  trackB: TrackStructure,
  options: PlanTransitionOptions = {}
): TransitionPlanResult {
  const started = performance.now()
  const cacheKey =
    options.cacheKey ??
    `${trackA.bpm}:${trackB.bpm}:${trackA.key.camelot}:${trackB.key.camelot}:${trackA.durationSec}:${trackB.durationSec}:${options.availableMs ?? 0}:${options.previousStrategy ?? ''}:${options.talkover ? 1 : 0}`

  if (!options.bypassCache) {
    const hit = planCache.get(cacheKey) as TransitionPlanResult | undefined
    if (hit) return { ...hit, cached: true }
  }

  const minMs = Math.max(800, options.minCrossfadeMs ?? 2000)
  const maxMs = Math.max(minMs, Math.min(options.maxCrossfadeMs ?? 30_000, options.availableMs ?? 30_000))
  const maxStretch = options.maxStretchPercent ?? 12
  const correlation = clamp(options.correlation ?? 0, -1, 1)
  const appliedGainDb = options.appliedGainDb ?? 0
  const lowHz = options.lowHz ?? 200
  const highHz = options.highHz ?? 3600
  const talkover = Boolean(options.talkover)
  const exponent = exponentFor(correlation)

  // Tempo relationship & beatmatch feasibility.
  const confidentTempo = trackA.bpm > 40 && trackB.bpm > 40 && trackA.bpmConfidence >= 0.25 && trackB.bpmConfidence >= 0.25
  const folded = confidentTempo ? foldTempo(trackB.bpm, trackA.bpm) : { bpm: trackB.bpm || trackA.bpm || 120, factor: 1 }
  const stretchRatio = confidentTempo ? trackA.bpm / Math.max(1, folded.bpm) : 1
  const stretchPercent = Number(((stretchRatio - 1) * 100).toFixed(2))
  const canBeatMatch = confidentTempo && Math.abs(stretchPercent) <= maxStretch
  const workingBpm = canBeatMatch ? folded.bpm : trackB.bpm > 40 ? trackB.bpm : trackA.bpm > 40 ? trackA.bpm : 120

  // Optional Neural AutoMix inference (CPU-fast, cached).
  const host = options.neuralHost === undefined ? neuralAutomix : options.neuralHost
  const neural =
    options.useNeural !== false && host?.active
      ? host.predictForPair(trackA, trackB, {
          correlation,
          talkover,
          exponent,
          beatMatched: canBeatMatch,
          lowHz,
          highHz
        })
      : null

  const harmonic = harmonicCompatibility(trackA.key, trackB.key)
  const vocalClash = trackA.vocalDensity > 0.38 && trackB.vocalDensity > 0.38

  // Select top cue candidates from Track A (mix-out) and Track B (mix-in).
  const outCues = trackA.mixOutCandidates.slice(0, 3)
  const inCues = trackB.mixInCandidates.slice(0, 3)
  if (outCues.length === 0) {
    outCues.push({
      role: 'mix-out',
      timeSec: Math.max(0, trackA.durationSec - Math.min(trackA.durationSec * 0.4, (options.requestedCrossfadeMs ?? 6000) / 1000)),
      sample: 0,
      beatIndex: 0,
      barIndex: 0,
      phraseBars: 1,
      sectionType: 'outro',
      score: 0.5,
      vocalFree: trackA.vocalDensity < 0.3,
      energy: trackA.meanEnergy,
      bassDensity: trackA.bassDensity,
      reason: 'tail fallback'
    })
  }
  if (inCues.length === 0) {
    inCues.push({
      role: 'mix-in',
      timeSec: 0,
      sample: 0,
      beatIndex: 0,
      barIndex: 0,
      phraseBars: 1,
      sectionType: 'intro',
      score: 0.5,
      vocalFree: trackB.vocalDensity < 0.3,
      energy: trackB.meanEnergy,
      bassDensity: trackB.bassDensity,
      reason: 'head fallback'
    })
  }

  // Progressive scaling ("more seams -> more transitions -> more parameters"):
  // when seamCount is supplied, progressively widen unlocked transition strategies,
  // automation knot count, and candidate search breadth.
  const scaling =
    options.seamCount != null && Number.isFinite(options.seamCount)
      ? resolveScalingTier(options.seamCount)
      : null
  const useProgressiveGate = Boolean(scaling && options.progressiveScaling !== false)
  const effectiveAllowed = (() => {
    if (useProgressiveGate && scaling) {
      const unlocked = new Set<string>(scaling.unlockedStrategies)
      if (options.allowedStrategies && options.allowedStrategies.length > 0) {
        const both = options.allowedStrategies.filter((s) => unlocked.has(s))
        return both.length > 0 ? both : options.allowedStrategies
      }
      return [...unlocked]
    }
    return options.allowedStrategies
  })()

  const barOptions = candidateBarCounts(workingBpm, minMs, maxMs, neural?.durationBars)
  const strategies = candidateStrategies({
    beatMatched: canBeatMatch,
    harmonicScore: harmonic.score,
    vocalClash,
    vocalOut: trackA.vocalDensity > 0.42,
    vocalIn: trackB.vocalDensity > 0.42,
    energyDelta: trackB.meanEnergy - trackA.meanEnergy,
    stretchPercent: canBeatMatch ? stretchPercent : 0,
    talkover,
    hasStems: Boolean(options.hasStems),
    neuralStrategy: neural?.strategy ?? null,
    allowed: effectiveAllowed,
    maxStrategies: scaling ? Math.max(4, Math.min(10, scaling.unlockedCount)) : 7
  })

  const candidates: CandidatePlan[] = []
  let seqId = 0

  for (const cueOut of outCues) {
    for (const cueIn of inCues) {
      const downbeatAligned = cueOut.beatIndex % 4 === cueIn.beatIndex % 4
      const localVocOut = cueOut.vocalFree ? Math.min(0.25, trackA.vocalDensity) : Math.max(0.55, trackA.vocalDensity)
      const localVocIn = cueIn.vocalFree ? Math.min(0.25, trackB.vocalDensity) : Math.max(0.55, trackB.vocalDensity)

      for (const bars of barOptions) {
        const barMs = workingBpm > 40 ? (60_000 / workingBpm) * 4 : 2000
        const durationMs = Math.round(clamp(bars * barMs, minMs, maxMs))
        const durationSec = Number((durationMs / 1000).toFixed(3))
        // Swap bass on a bar boundary near the musical midpoint (e.g., bar 4 of 8, bar 8 of 16).
        const swapBar = Math.max(1, Math.round(bars * 0.55))
        const bassSwapAt = clamp(swapBar / Math.max(1, bars), 0.35, 0.75)
        const bassSwapWidth = clamp(1 / Math.max(4, bars * 4), 0.05, 0.18)

        for (const strategy of strategies) {
          const basePlan = buildAutomationPlan({
            strategy,
            exponent,
            bassSwapAt,
            bassSwapWidth,
            vocalOut: localVocOut,
            vocalIn: localVocIn,
            vocalPhraseEnd: localVocOut > 0.45 ? 0.62 : 0.5,
            harmonicScore: harmonic.score,
            beatMatched: canBeatMatch,
            lowHz,
            highHz,
            knots: scaling?.knots,
            source: 'planner'
          })

          const evaluation = evaluateTransition({
            trackA,
            trackB,
            cueOut,
            cueIn,
            durationSec,
            durationBars: bars,
            beatMatched: canBeatMatch,
            stretchPercent: canBeatMatch ? stretchPercent : 0,
            downbeatAligned,
            correlation,
            appliedGainDb,
            plan: basePlan
          })

          // Variety nudge: avoid repeating the exact same strategy back-to-back unless clearly better.
          const repeatPenalty = options.previousStrategy && strategy === options.previousStrategy ? 0.05 : 0
          // Neural strategy prior boost when model is loaded and confident.
          const neuralStratProb = neural?.strategyOrder.find((s) => s.strategy === strategy)?.probability ?? 0
          const neuralBoost = neural ? neuralStratProb * 0.08 * clamp(neural.predictedQuality, 0.2, 1) : 0
          const rankScore = Number(clamp(evaluation.overall + neuralBoost - repeatPenalty, 0, 1).toFixed(4))

          candidates.push({
            id: `cand-${++seqId}`,
            cueOut,
            cueIn,
            durationSec,
            durationMs,
            durationBars: bars,
            strategy,
            beatMatched: canBeatMatch,
            foldedBpm: Number(workingBpm.toFixed(2)),
            stretchPercent: canBeatMatch ? stretchPercent : 0,
            downbeatAligned,
            plan: basePlan,
            evaluation,
            rankScore,
            isFallback: false
          })
        }
      }
    }
  }

  // Also include the direct Neural AutoMix continuous automation candidate when loaded!
  if (neural) {
    const cueOut = outCues[Math.min(outCues.length - 1, Math.floor(neural.mixOutOffset * outCues.length))]
    const cueIn = inCues[Math.min(inCues.length - 1, Math.floor(neural.mixInOffset * inCues.length))]
    const barMs = workingBpm > 40 ? (60_000 / workingBpm) * 4 : 2000
    const durationMs = Math.round(clamp(neural.durationBars * barMs, minMs, maxMs))
    const durationSec = Number((durationMs / 1000).toFixed(3))
    const neuralPlan = sanitizeAutomationPlan({
      ...neural.automationPlan,
      exponent,
      drumSyncDuck: canBeatMatch,
      lowHz,
      highHz,
      source: 'neural'
    })
    const evaluation = evaluateTransition({
      trackA,
      trackB,
      cueOut,
      cueIn,
      durationSec,
      durationBars: neural.durationBars,
      beatMatched: canBeatMatch,
      stretchPercent: canBeatMatch ? stretchPercent : 0,
      downbeatAligned: cueOut.beatIndex % 4 === cueIn.beatIndex % 4,
      correlation,
      appliedGainDb,
      plan: neuralPlan
    })
    const rankScore = Number(clamp(evaluation.overall + 0.04 * neural.predictedQuality, 0, 1).toFixed(4))
    candidates.push({
      id: `neural-${++seqId}`,
      cueOut,
      cueIn,
      durationSec,
      durationMs,
      durationBars: neural.durationBars,
      strategy: neural.strategy,
      beatMatched: canBeatMatch,
      foldedBpm: Number(workingBpm.toFixed(2)),
      stretchPercent: canBeatMatch ? stretchPercent : 0,
      downbeatAligned: cueOut.beatIndex % 4 === cueIn.beatIndex % 4,
      plan: neuralPlan,
      evaluation,
      rankScore,
      isFallback: false
    })
  }

  candidates.sort((a, b) => b.rankScore - a.rankScore || b.evaluation.overall - a.evaluation.overall)
  let selected = candidates[0]
  let fallbackUsed = false
  let fallbackReason: string | null = null

  // Graceful smart fallback whenever beatmatching isn't reliable or quality is too low.
  const minQuality = options.minBeatMatchQuality ?? 0.5
  const needsFallback =
    !selected ||
    !canBeatMatch ||
    selected.evaluation.fallbackRecommended ||
    selected.evaluation.overall < minQuality

  if (needsFallback) {
    fallbackUsed = true
    if (!confidentTempo) fallbackReason = 'low beat confidence — using smooth smart crossfade'
    else if (Math.abs(stretchPercent) > maxStretch) {
      fallbackReason = `tempo gap (${Math.abs(stretchPercent).toFixed(1)}% > ${maxStretch}%) — using musical non-stretched fallback`
    } else if (harmonic.relation === 'clash') {
      fallbackReason = `key clash (${trackA.key.camelot} → ${trackB.key.camelot}) — using filtered wash handoff`
    } else {
      fallbackReason = `candidate score ${selected?.evaluation.overall.toFixed(2) ?? '0'} below threshold ${minQuality}`
    }

    // Choose the cleanest non-beatmatched transition:
    // - key clash or high vocal clash → filtered reverb wash or echo out
    // - otherwise → gentle equal-power smart crossfade with vocal protection
    const fbStrategy =
      harmonic.relation === 'clash' || vocalClash
        ? 'wash'
        : Math.abs(trackB.meanEnergy - trackA.meanEnergy) > 0.35
          ? 'filter'
          : 'crossfade'
    const fbMs = Math.round(clamp(options.requestedCrossfadeMs ?? 4000, minMs, Math.min(maxMs, 6000)))
    const fbPlan = buildAutomationPlan({
      strategy: fbStrategy,
      exponent,
      bassSwapAt: 0.5,
      bassSwapWidth: 0.22,
      vocalOut: trackA.vocalDensity,
      vocalIn: trackB.vocalDensity,
      harmonicScore: harmonic.score,
      beatMatched: false,
      lowHz,
      highHz,
      source: 'fallback'
    })
    const fbEval = evaluateTransition({
      trackA,
      trackB,
      cueOut: outCues[0],
      cueIn: inCues[0],
      durationSec: Number((fbMs / 1000).toFixed(3)),
      durationBars: Math.max(1, Math.round(fbMs / 2000)),
      beatMatched: false,
      stretchPercent: 0,
      downbeatAligned: false,
      correlation,
      appliedGainDb,
      plan: fbPlan
    })
    selected = {
      id: 'smart-fallback',
      cueOut: outCues[0],
      cueIn: inCues[0],
      durationSec: Number((fbMs / 1000).toFixed(3)),
      durationMs: fbMs,
      durationBars: Math.max(1, Math.round(fbMs / 2000)),
      strategy: fbStrategy,
      beatMatched: false,
      foldedBpm: Number(workingBpm.toFixed(2)),
      stretchPercent: 0,
      downbeatAligned: false,
      plan: fbPlan,
      evaluation: fbEval,
      rankScore: fbEval.overall,
      isFallback: true
    }
  }

  const maxReturned = scaling ? Math.max(6, scaling.maxCandidates) : 12
  const topCandidates = candidates.slice(0, maxReturned)
  const neuralCand = candidates.find((c) => c.id.startsWith('neural-'))
  if (neuralCand && !topCandidates.includes(neuralCand)) {
    topCandidates.push(neuralCand)
  }

  const result: TransitionPlanResult = {
    selected,
    candidates: topCandidates,
    trackA,
    trackB,
    neural,
    scaling,
    fallbackUsed,
    fallbackReason,
    planningMs: Number((performance.now() - started).toFixed(2)),
    cached: false
  }

  if (!options.bypassCache) planCache.set(cacheKey, result)
  return result
}

/** Convenience wrapper: analyse raw mono PCM buffers (cached) and plan the transition. */
export function planTransitionFromAudio(
  monoA: Float32Array,
  monoB: Float32Array,
  sampleRate: number,
  options: PlanTransitionOptions & {
    cacheKeyA?: string
    cacheKeyB?: string
    channelsA?: Float32Array[]
    channelsB?: Float32Array[]
    knownBeatA?: { bpm?: number; confidence?: number; phaseSamples?: number } | null
    knownBeatB?: { bpm?: number; confidence?: number; phaseSamples?: number } | null
  } = {}
): TransitionPlanResult {
  const trackA = analyzeTrackStructure(monoA, sampleRate, {
    cacheKey: options.cacheKeyA,
    channels: options.channelsA,
    knownBeat: options.knownBeatA,
    bypassCache: options.bypassCache
  })
  const trackB = analyzeTrackStructure(monoB, sampleRate, {
    cacheKey: options.cacheKeyB,
    channels: options.channelsB,
    knownBeat: options.knownBeatB,
    bypassCache: options.bypassCache
  })
  return planTransition(trackA, trackB, options)
}
