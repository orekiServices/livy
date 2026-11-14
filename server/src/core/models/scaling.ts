/**
 * Progressive Capacity Scaling: "More seams -> more transitions -> more parameters".
 *
 * Maps the volume of observed real transitions / seams to:
 *   1. **Unlocked transitions**: starts with 4 rock-solid core transitions on tiny
 *      datasets and progressively unlocks richer DJ archetypes (`eq-blend`, `echo`,
 *      `slam`, `sweep`, `spindown`, `drop`, `roll`, `stem-handoff`, `phrase-cut`,
 *      `vocal-bridge`, `tempo-ramp`, `harmonic-drop`) as real seam evidence grows.
 *   2. **Automation & search resolution**: widens continuous curve knot count
 *      (6 -> 16 knots) and candidate search breadth (6 -> 36 candidates).
 *   3. **Model parameter budgets**: monotonically scales both the v1 seam policy
 *      network (~480 -> ~22.5K params) and the v2 Neural AutoMix network
 *      (~4.1K `mlp-nano` -> ~14.4K `mlp-micro` -> ~20.9K `tcn-compact` ->
 *      ~68.4K `gru-dj` -> ~170K `transformer-mini` -> ~1.01M `transformer-medium`
 *      -> ~3.59M `transformer-xl`, always respecting the 1K–5M parameter range
 *      and mobile thermal/RAM limits).
 *
 * Scaling is always paired with held-out validation so extra parameters are
 * earned by real seam data rather than arbitrarily inflated.
 */
import { ACTIONS, FEATURES } from './features.ts'
import {
  AUTOMIX_STRATEGIES,
  NEURAL_AUTOMIX_PRESETS,
  estimateParameters,
  type AutoMixStrategy,
  type NeuralAutoMixConfig
} from './architectures.ts'

export type ScalingTierId = 'bootstrap' | 'club' | 'resident' | 'pro' | 'headliner' | 'festival' | 'master'

export interface SeamScalingTier {
  id: ScalingTierId
  label: string
  /** Minimum seams / transitions required to unlock this tier. */
  minSeams: number
  /** Transition strategies unlocked at this tier (cumulative, strictly monotonic). */
  unlockedStrategies: readonly AutoMixStrategy[]
  /** Continuous automation knot count K for curve rendering / prediction. */
  knots: number
  /** Candidate transitions explored per track pair in the planner. */
  maxCandidates: number
  /** Candidate hidden-layer shapes for the v1 seam policy trainer. */
  policyShapes: number[][]
  /** Maximum seam pairs retained for training at this tier. */
  maxPairs: number
  /** Default epochs (full / fast) for v1 policy training. */
  epochs: number
  fastEpochs: number
  /** Corresponding v2 Neural AutoMix preset ID in NEURAL_AUTOMIX_PRESETS. */
  neuralPreset: keyof typeof NEURAL_AUTOMIX_PRESETS
  /** Candidate presets benchmarked against this tier (smallest-reliable check). */
  benchmarkPresets: string[]
  description: string
}

export interface ResolvedScalingTier extends SeamScalingTier {
  seams: number
  mobileCapped: boolean
  unlockedCount: number
  totalStrategies: number
  policyParams: number
  neuralParams: number
  neuralConfig: NeuralAutoMixConfig
  nextTier: {
    id: ScalingTierId
    label: string
    minSeams: number
    seamsRemaining: number
    unlockedCount: number
    neuralParams: number
  } | null
  /** 0..1 progress toward the next tier (1 at highest unlocked tier). */
  progressToNext: number
}

/** Compute exact parameter count for a v1 MLP seam policy hidden shape. */
export function estimatePolicyParams(hidden: number[]): number {
  const widths = [FEATURES.length, ...hidden, ACTIONS.length]
  let total = 0
  for (let i = 1; i < widths.length; i += 1) {
    total += widths[i - 1] * widths[i] + widths[i]
  }
  return total
}

export const SEAM_SCALING_TIERS: readonly SeamScalingTier[] = Object.freeze([
  {
    id: 'bootstrap',
    label: 'Bootstrap',
    minSeams: 0,
    unlockedStrategies: ['crossfade', 'bass-swap', 'filter', 'wash'],
    knots: 6,
    maxCandidates: 6,
    policyShapes: [
      [16, 12],
      [20, 14]
    ],
    maxPairs: 1_500,
    epochs: 60,
    fastEpochs: 35,
    neuralPreset: 'mlp-nano',
    benchmarkPresets: ['mlp-nano'],
    description: 'Early seams: 4 safe core transitions with an ultra-lightweight ~4K-param neural head.'
  },
  {
    id: 'club',
    label: 'Club',
    minSeams: 60,
    unlockedStrategies: ['crossfade', 'bass-swap', 'filter', 'wash', 'eq-blend', 'echo', 'slam'],
    knots: 8,
    maxCandidates: 10,
    policyShapes: [
      [24, 16],
      [32, 20]
    ],
    maxPairs: 4_000,
    epochs: 90,
    fastEpochs: 45,
    neuralPreset: 'mlp-micro',
    benchmarkPresets: ['mlp-nano', 'mlp-micro'],
    description: '60+ seams: unlocks 3-band eq-blend, echo, and slam with ~14K neural parameters.'
  },
  {
    id: 'resident',
    label: 'Resident',
    minSeams: 200,
    unlockedStrategies: [
      'crossfade',
      'bass-swap',
      'filter',
      'wash',
      'eq-blend',
      'echo',
      'slam',
      'sweep',
      'spindown',
      'drop'
    ],
    knots: 8,
    maxCandidates: 14,
    policyShapes: [
      [32, 24, 16],
      [48, 24]
    ],
    maxPairs: 10_000,
    epochs: 120,
    fastEpochs: 60,
    neuralPreset: 'tcn-compact',
    benchmarkPresets: ['mlp-micro', 'tcn-compact'],
    description: '200+ seams: unlocks all 10 classic DJ transitions with a ~21K-param dilated TCN.'
  },
  {
    id: 'pro',
    label: 'Pro DJ',
    minSeams: 600,
    unlockedStrategies: [
      'crossfade',
      'bass-swap',
      'filter',
      'wash',
      'eq-blend',
      'echo',
      'slam',
      'sweep',
      'spindown',
      'drop',
      'roll',
      'stem-handoff'
    ],
    knots: 10,
    maxCandidates: 18,
    policyShapes: [
      [48, 32, 16],
      [64, 32]
    ],
    maxPairs: 18_000,
    epochs: 150,
    fastEpochs: 75,
    neuralPreset: 'gru-dj',
    benchmarkPresets: ['tcn-compact', 'gru-dj'],
    description: '600+ seams: unlocks beat-roll & 4-stem handoffs with a ~68K-param 2-layer GRU.'
  },
  {
    id: 'headliner',
    label: 'Headliner',
    minSeams: 2_000,
    unlockedStrategies: [
      'crossfade',
      'bass-swap',
      'filter',
      'wash',
      'eq-blend',
      'echo',
      'slam',
      'sweep',
      'spindown',
      'drop',
      'roll',
      'stem-handoff',
      'phrase-cut',
      'vocal-bridge'
    ],
    knots: 12,
    maxCandidates: 24,
    policyShapes: [
      [64, 48, 24],
      [96, 48, 24]
    ],
    maxPairs: 32_000,
    epochs: 180,
    fastEpochs: 90,
    neuralPreset: 'transformer-mini',
    benchmarkPresets: ['gru-dj', 'transformer-mini'],
    description: '2,000+ seams: unlocks phrase-cut & vocal-bridge transitions with a ~170K cross-attention Transformer.'
  },
  {
    id: 'festival',
    label: 'Festival',
    minSeams: 8_000,
    unlockedStrategies: [
      'crossfade',
      'bass-swap',
      'filter',
      'wash',
      'eq-blend',
      'echo',
      'slam',
      'sweep',
      'spindown',
      'drop',
      'roll',
      'stem-handoff',
      'phrase-cut',
      'vocal-bridge',
      'tempo-ramp',
      'harmonic-drop'
    ],
    knots: 14,
    maxCandidates: 30,
    policyShapes: [
      [96, 64, 32],
      [128, 64, 32]
    ],
    maxPairs: 64_000,
    epochs: 220,
    fastEpochs: 110,
    neuralPreset: 'transformer-medium',
    benchmarkPresets: ['transformer-mini', 'transformer-medium'],
    description: '8,000+ seams: unlocks all 16 transitions (+ tempo-ramp & harmonic-drop) with a ~1.0M Transformer.'
  },
  {
    id: 'master',
    label: 'Master Corpus',
    minSeams: 25_000,
    unlockedStrategies: [...AUTOMIX_STRATEGIES],
    knots: 16,
    maxCandidates: 36,
    policyShapes: [
      [128, 96, 48],
      [160, 96, 48]
    ],
    maxPairs: 120_000,
    epochs: 260,
    fastEpochs: 130,
    neuralPreset: 'transformer-xl',
    benchmarkPresets: ['transformer-medium', 'transformer-xl'],
    description: '25,000+ seams: full 16-knot automation & ~3.6M-param Transformer-XL (within 5M ceiling).'
  }
])

/** Highest tier index permitted on battery/thermal-constrained mobile (Termux) hosts. */
const MOBILE_MAX_TIER_INDEX = 2 // 'resident' (~20.9K params TCN, 10 transitions)

/**
 * Resolve the active progressive scaling tier for an observed number of seams.
 * More seams monotonically unlocks more transitions, finer automation knots,
 * wider candidate search, and larger model parameter budgets.
 */
export function resolveScalingTier(
  seams: number,
  options: { mobile?: boolean; maxNeuralParams?: number; knotsOverride?: number } = {}
): ResolvedScalingTier {
  const count = Math.max(0, Math.floor(Number(seams) || 0))
  const mobile = Boolean(options.mobile)
  const maxTierIdx = mobile ? MOBILE_MAX_TIER_INDEX : SEAM_SCALING_TIERS.length - 1

  let idx = 0
  for (let i = 0; i <= maxTierIdx; i += 1) {
    if (count >= SEAM_SCALING_TIERS[i].minSeams) idx = i
  }

  // Optional explicit upper parameter cap (e.g. strict latency-constrained deployments).
  if (options.maxNeuralParams && options.maxNeuralParams > 0) {
    while (idx > 0) {
      const cfg = NEURAL_AUTOMIX_PRESETS[SEAM_SCALING_TIERS[idx].neuralPreset]
      if (estimateParameters(cfg) <= options.maxNeuralParams) break
      idx -= 1
    }
  }

  const tier = SEAM_SCALING_TIERS[idx]
  const baseNeural = NEURAL_AUTOMIX_PRESETS[tier.neuralPreset]
  const neuralConfig: NeuralAutoMixConfig = {
    ...baseNeural,
    knots: options.knotsOverride ?? baseNeural.knots
  }
  const neuralParams = estimateParameters(neuralConfig)
  const policyParams = estimatePolicyParams(tier.policyShapes[0])

  const next = idx < maxTierIdx ? SEAM_SCALING_TIERS[idx + 1] : null
  const nextNeuralParams = next ? estimateParameters(NEURAL_AUTOMIX_PRESETS[next.neuralPreset]) : 0
  const progressToNext = next
    ? Math.max(0, Math.min(1, Number(((count - tier.minSeams) / Math.max(1, next.minSeams - tier.minSeams)).toFixed(4))))
    : 1

  return {
    ...tier,
    seams: count,
    mobileCapped: mobile && count >= SEAM_SCALING_TIERS[MOBILE_MAX_TIER_INDEX + 1].minSeams,
    unlockedCount: tier.unlockedStrategies.length,
    totalStrategies: AUTOMIX_STRATEGIES.length,
    policyParams,
    neuralParams,
    neuralConfig,
    nextTier: next
      ? {
          id: next.id,
          label: next.label,
          minSeams: next.minSeams,
          seamsRemaining: Math.max(0, next.minSeams - count),
          unlockedCount: next.unlockedStrategies.length,
          neuralParams: nextNeuralParams
        }
      : null,
    progressToNext
  }
}

/** Full scaling ladder summary suitable for CLI, owner API, and console dashboards. */
export function scalingLadderSummary(seams: number, options: { mobile?: boolean } = {}) {
  const current = resolveScalingTier(seams, options)
  return {
    seams: current.seams,
    tier: current.id,
    label: current.label,
    mobileCapped: current.mobileCapped,
    unlockedTransitions: [...current.unlockedStrategies],
    unlockedCount: current.unlockedCount,
    totalTransitions: current.totalStrategies,
    knots: current.knots,
    maxCandidates: current.maxCandidates,
    policyShapes: current.policyShapes,
    policyParams: current.policyParams,
    neuralPreset: current.neuralPreset,
    neuralArchitecture: current.neuralConfig.architecture,
    neuralParams: current.neuralParams,
    nextTier: current.nextTier,
    progressToNext: current.progressToNext,
    tiers: SEAM_SCALING_TIERS.map((t) => ({
      id: t.id,
      label: t.label,
      minSeams: t.minSeams,
      transitions: t.unlockedStrategies.length,
      knots: t.knots,
      maxCandidates: t.maxCandidates,
      policyParams: estimatePolicyParams(t.policyShapes[0]),
      neuralPreset: t.neuralPreset,
      neuralParams: estimateParameters(NEURAL_AUTOMIX_PRESETS[t.neuralPreset]),
      unlocked: current.seams >= t.minSeams
    }))
  }
}
