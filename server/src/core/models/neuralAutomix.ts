/**
 * Neural AutoMix runtime interface:
 *   • Builds the 32-dim pair feature vector + Track A/B beat sequences from
 *     TrackStructure pairs
 *   • Encodes & decodes Stage 1 (cue/duration/tempo) and Stage 2 (strategy +
 *     14-channel continuous automation curves) to/from `AutomationPlan`
 *   • Runs lightweight CPU inference with LRU prediction caching
 *   • Loads active `.lvmx` checkpoints without ever breaking playback if absent
 */
import fs from 'node:fs'
import path from 'node:path'
import createLogger from '../../util/logger.ts'
import { clamp, foldTempo } from '../dsp.ts'
import { MemoryLruCache } from '../cache.ts'
import {
  harmonicCompatibility,
  rhythmSimilarity,
  type SectionType,
  type TrackStructure
} from '../automix/structure.ts'
import {
  DEFAULT_KNOTS,
  sanitizeAutomationPlan,
  type AutomationCurves,
  type AutomationPlan
} from '../automix/blender.ts'
import {
  AUTOMIX_STRATEGIES,
  CURVE_CHANNELS,
  NeuralAutoMixModel,
  PAIR_FEATURE_DIM,
  SEQ_FEATURE_DIM,
  normalizeSequence,
  type AutoMixStrategy,
  type NeuralInput,
  type NeuralPrediction
} from './architectures.ts'
import { loadNeuralCheckpoint, type FeatureNormalization, type UnpackedCheckpoint } from './neuralFormat.ts'
import { modelDirs } from './storage/local.ts'

const log = createLogger('neural-automix')

const SECTION_INDEX: Record<SectionType, number> = {
  intro: 0,
  verse: 1,
  chorus: 2,
  buildup: 3,
  breakdown: 4,
  drop: 5,
  outro: 6
}

export const PAIR_FEATURE_NAMES: readonly string[] = Object.freeze([
  'bpmA',
  'bpmB',
  'bpmFoldedRatio',
  'bpmRatioLog',
  'stretchPercentAbs',
  'bpmConfMin',
  'harmonicScore',
  'camelotDist',
  'keyConfMin',
  'rhythmSimilarity',
  'grooveA',
  'grooveB',
  'energyA',
  'energyB',
  'energyDelta',
  'energyTrendA',
  'energyTrendB',
  'bassA',
  'bassB',
  'bassDiff',
  'vocalA',
  'vocalB',
  'vocalClash',
  'loudnessGap',
  'correlation',
  'cueOutScore',
  'cueInScore',
  'cueOutSectionNorm',
  'cueInSectionNorm',
  'cueOutPhraseNorm',
  'cueInPhraseNorm',
  'talkover'
])

/** Build the 32-dim pair feature vector describing Track A → Track B. */
export function extractPairFeatures(
  trackA: TrackStructure,
  trackB: TrackStructure,
  context: {
    correlation?: number
    talkover?: boolean
    cueOutIdx?: number
    cueInIdx?: number
  } = {}
): Float32Array {
  const bpmA = trackA.bpm > 0 ? trackA.bpm : 120
  const bpmB = trackB.bpm > 0 ? trackB.bpm : 120
  const folded = foldTempo(bpmB, bpmA)
  const ratio = bpmA / Math.max(1, folded.bpm)
  const stretchAbs = Math.abs(1 - ratio) * 100
  const harm = harmonicCompatibility(trackA.key, trackB.key)
  const rhythmSim = rhythmSimilarity(trackA.rhythmPattern, trackB.rhythmPattern)
  const loudGap =
    trackA.loudnessLufs != null && trackB.loudnessLufs != null ? trackA.loudnessLufs - trackB.loudnessLufs : 0
  const cueOut = trackA.mixOutCandidates[context.cueOutIdx ?? 0] ?? trackA.mixOutCandidates[0]
  const cueIn = trackB.mixInCandidates[context.cueInIdx ?? 0] ?? trackB.mixInCandidates[0]

  const out = new Float32Array(PAIR_FEATURE_DIM)
  out[0] = clamp(bpmA / 200, 0, 1)
  out[1] = clamp(bpmB / 200, 0, 1)
  out[2] = clamp(ratio, 0.5, 2)
  out[3] = clamp(Math.log2(Math.max(0.25, ratio)), -1, 1)
  out[4] = clamp(stretchAbs / 20, 0, 1)
  out[5] = clamp(Math.min(trackA.bpmConfidence, trackB.bpmConfidence), 0, 1)
  out[6] = harm.score
  out[7] = clamp(harm.camelotDistance / 6, 0, 1)
  out[8] = clamp(Math.min(trackA.key.confidence, trackB.key.confidence), 0, 1)
  out[9] = rhythmSim
  out[10] = trackA.grooveStrength
  out[11] = trackB.grooveStrength
  out[12] = trackA.meanEnergy
  out[13] = trackB.meanEnergy
  out[14] = clamp(trackB.meanEnergy - trackA.meanEnergy, -1, 1)
  out[15] = trackA.energyTrend
  out[16] = trackB.energyTrend
  out[17] = trackA.bassDensity
  out[18] = trackB.bassDensity
  out[19] = clamp(trackB.bassDensity - trackA.bassDensity, -1, 1)
  out[20] = trackA.vocalDensity
  out[21] = trackB.vocalDensity
  out[22] = trackA.vocalDensity > 0.35 && trackB.vocalDensity > 0.35 ? 1 : 0
  out[23] = clamp(loudGap / 18, -1, 1)
  out[24] = clamp(context.correlation ?? 0, -1, 1)
  out[25] = cueOut?.score ?? 0.5
  out[26] = cueIn?.score ?? 0.5
  out[27] = cueOut ? SECTION_INDEX[cueOut.sectionType] / 6 : 1
  out[28] = cueIn ? SECTION_INDEX[cueIn.sectionType] / 6 : 0
  out[29] = cueOut ? clamp(cueOut.phraseBars / 32, 0, 1) : 0.25
  out[30] = cueIn ? clamp(cueIn.phraseBars / 32, 0, 1) : 0.25
  out[31] = context.talkover ? 1 : 0
  return out
}

/** Extract tail beat sequence of Track A and head beat sequence of Track B. */
export function extractTrackSequences(
  trackA: TrackStructure,
  trackB: TrackStructure,
  seqLen = 16
): { seqA: Float32Array[]; seqB: Float32Array[] } {
  const tailA = trackA.beatSequence.slice(-seqLen)
  const headB = trackB.beatSequence.slice(0, seqLen)
  return {
    seqA: normalizeSequence(tailA, seqLen, SEQ_FEATURE_DIM),
    seqB: normalizeSequence(headB, seqLen, SEQ_FEATURE_DIM)
  }
}

/** Apply stored z-score normalization stats to a pair vector (inference/eval). */
export function applyNormalization(pair: Float32Array, norm?: FeatureNormalization | null): Float32Array {
  if (!norm || norm.mean.length !== pair.length || norm.std.length !== pair.length) return pair
  const out = new Float32Array(pair.length)
  for (let i = 0; i < pair.length; i += 1) {
    const s = norm.std[i] > 1e-6 ? norm.std[i] : 1
    out[i] = clamp((pair[i] - norm.mean[i]) / s, -5, 5)
  }
  return out
}

/** Encode an AutomationPlan into the flat Stage-2 target vector `[bassSwapAt, bassSwapWidth, ...14*K]`. */
export function encodeAutomationTarget(plan: AutomationPlan, knots = DEFAULT_KNOTS): number[] {
  const c = plan.curves
  const resampleKnots = (arr: number[]) => {
    const out: number[] = []
    for (let k = 0; k < knots; k += 1) {
      const idx = knots > 1 ? (k * (arr.length - 1)) / (knots - 1) : 0
      const i0 = Math.floor(idx)
      const i1 = Math.min(arr.length - 1, i0 + 1)
      const f = idx - i0
      out.push((arr[i0] ?? 0) * (1 - f) + (arr[i1] ?? 0) * f)
    }
    return out
  }
  return [
    plan.bassSwapAt,
    plan.bassSwapWidth,
    ...resampleKnots(c.gainA),
    ...resampleKnots(c.gainB),
    ...resampleKnots(c.lowA),
    ...resampleKnots(c.midA),
    ...resampleKnots(c.highA),
    ...resampleKnots(c.lowB),
    ...resampleKnots(c.midB),
    ...resampleKnots(c.highB),
    ...resampleKnots(c.vocalDuckA),
    ...resampleKnots(c.vocalDuckB),
    ...resampleKnots(c.filterA),
    ...resampleKnots(c.filterB),
    ...resampleKnots(c.reverbSendA),
    ...resampleKnots(c.delaySendA)
  ]
}

export interface DecodedNeuralPlan {
  mixOutOffset: number
  mixInOffset: number
  durationBars: 4 | 8 | 16 | 32
  tempoBlendStrength: number
  predictedQuality: number
  strategy: AutoMixStrategy
  strategyConfidence: number
  strategyOrder: Array<{ strategy: AutoMixStrategy; probability: number }>
  automationPlan: AutomationPlan
}

/** Decode Stage-1 and Stage-2 neural outputs into a safe, musical AutomationPlan. */
export function decodeNeuralPrediction(
  pred: NeuralPrediction,
  knots = DEFAULT_KNOTS,
  options: { exponent?: number; beatMatched?: boolean; lowHz?: number; highHz?: number } = {}
): DecodedNeuralPlan {
  const [mixOutOffset, mixInOffset, durNorm, tempoBlendStrength, predictedQuality] = pred.stage1

  // Map normalized duration to standard musical phrase counts: 4, 8, 16, or 32 bars.
  const durationBars: 4 | 8 | 16 | 32 =
    durNorm < 0.25 ? 4 : durNorm < 0.58 ? 8 : durNorm < 0.84 ? 16 : 32

  const ranked = AUTOMIX_STRATEGIES.map((strategy, i) => ({
    strategy,
    probability: Number((pred.strategyProbs[i] ?? 0).toFixed(4))
  })).sort((a, b) => b.probability - a.probability)

  const strategy = ranked[0].strategy
  const strategyConfidence = Number(clamp(ranked[0].probability - (ranked[1]?.probability ?? 0), 0, 1).toFixed(4))

  const vec = pred.automation
  const slice = (ch: number) => Array.from(vec.subarray(2 + ch * knots, 2 + (ch + 1) * knots), (v) => Number(v.toFixed(4)))
  const curves: AutomationCurves = {
    knots,
    gainA: slice(0),
    gainB: slice(1),
    lowA: slice(2),
    midA: slice(3),
    highA: slice(4),
    lowB: slice(5),
    midB: slice(6),
    highB: slice(7),
    vocalDuckA: slice(8),
    vocalDuckB: slice(9),
    filterA: slice(10),
    filterB: slice(11),
    reverbSendA: slice(12),
    delaySendA: slice(13)
  }

  const automationPlan = sanitizeAutomationPlan({
    strategy,
    curves,
    bassSwapAt: Number(clamp(vec[0], 0.2, 0.85).toFixed(3)),
    bassSwapWidth: Number(clamp(vec[1], 0.04, 0.35).toFixed(3)),
    exponent: options.exponent ?? 2,
    drumSyncDuck: options.beatMatched !== false,
    lowHz: options.lowHz ?? 200,
    highHz: options.highHz ?? 3600,
    source: 'neural'
  })

  return {
    mixOutOffset: Number(mixOutOffset.toFixed(3)),
    mixInOffset: Number(mixInOffset.toFixed(3)),
    durationBars,
    tempoBlendStrength: Number(tempoBlendStrength.toFixed(3)),
    predictedQuality: Number(predictedQuality.toFixed(3)),
    strategy,
    strategyConfidence,
    strategyOrder: ranked,
    automationPlan
  }
}

/* ------------------------------------------------------------------ *
 * Neural AutoMix Runtime Host (checkpoint loader + prediction cache)
 * ------------------------------------------------------------------ */

export class NeuralAutoMixHost {
  #model: NeuralAutoMixModel | null = null
  #checkpoint: UnpackedCheckpoint | null = null
  #file: string | null = null
  #loaded = false
  #cache = new MemoryLruCache({ name: 'neural-automix-pred', maxEntries: 512, ttlMs: 30 * 60_000 })
  #stats = { predictions: 0, cacheHits: 0, lastLatencyMs: 0 }

  /** Load an in-memory trained model directly (used by pipeline, tests, or API). */
  setModel(model: NeuralAutoMixModel | null, checkpoint: UnpackedCheckpoint | null = null, file: string | null = null): void {
    this.#model = model
    this.#checkpoint = checkpoint
    this.#file = file
    this.#loaded = true
    this.#cache.clear()
  }

  /** Locate and load `automix.lvmx` (or `LIVY_AUTOMIX_MODEL`) from disk. */
  reload(explicitPath?: string): NeuralAutoMixModel | null {
    this.#loaded = true
    const candidates: string[] = []
    if (explicitPath) candidates.push(explicitPath)
    if (process.env.LIVY_AUTOMIX_MODEL) candidates.push(process.env.LIVY_AUTOMIX_MODEL)
    for (const dir of modelDirs()) {
      candidates.push(path.join(dir, 'automix.lvmx'))
      candidates.push(path.join(dir, 'automix-best.lvmx'))
    }

    for (const file of candidates) {
      if (!file || !fs.existsSync(file)) continue
      try {
        const buf = fs.readFileSync(file)
        const { model, checkpoint } = loadNeuralCheckpoint(buf)
        this.#model = model
        this.#checkpoint = checkpoint
        this.#file = file
        this.#cache.clear()
        log.info(
          `loaded neural automix ${path.basename(file)} (${model.config.architecture}, ${model.parameterCount} params, ${checkpoint.digest})`
        )
        return model
      } catch (error: any) {
        log.warn(`could not load neural automix checkpoint ${file}: ${error.message}`)
      }
    }
    this.#model = null
    this.#checkpoint = null
    this.#file = null
    return null
  }

  get active(): NeuralAutoMixModel | null {
    if (!this.#loaded) this.reload()
    return this.#model
  }

  /** Run cached CPU inference for a Track A → Track B pair. */
  predictForPair(
    trackA: TrackStructure,
    trackB: TrackStructure,
    options: {
      cacheKey?: string
      correlation?: number
      talkover?: boolean
      exponent?: number
      beatMatched?: boolean
      lowHz?: number
      highHz?: number
    } = {}
  ): DecodedNeuralPlan | null {
    const model = this.active
    if (!model) return null

    const key =
      options.cacheKey ??
      `${this.#checkpoint?.digest ?? 'mem'}:${trackA.bpm}:${trackB.bpm}:${trackA.key.camelot}:${trackB.key.camelot}:${trackA.durationSec}:${trackB.durationSec}:${Math.round((options.correlation ?? 0) * 100)}`
    const cached = this.#cache.get(key) as DecodedNeuralPlan | undefined
    if (cached) {
      this.#stats.cacheHits += 1
      return cached
    }

    const t0 = performance.now()
    const rawPair = extractPairFeatures(trackA, trackB, {
      correlation: options.correlation,
      talkover: options.talkover
    })
    const pair = applyNormalization(rawPair, this.#checkpoint?.metadata.normalization)
    const { seqA, seqB } = extractTrackSequences(trackA, trackB, model.config.seqLen)
    const input: NeuralInput = { pair, seqA, seqB }
    const pred = model.predict(input)
    const decoded = decodeNeuralPrediction(pred, model.config.knots, {
      exponent: options.exponent,
      beatMatched: options.beatMatched,
      lowHz: options.lowHz,
      highHz: options.highHz
    })

    this.#stats.lastLatencyMs = Number((performance.now() - t0).toFixed(3))
    this.#stats.predictions += 1
    this.#cache.set(key, decoded)
    return decoded
  }

  info() {
    const model = this.active
    return {
      loaded: Boolean(model),
      file: this.#file ? path.basename(this.#file) : null,
      architecture: model?.config.architecture ?? null,
      parameters: model?.parameterCount ?? 0,
      memoryBytes: model?.memoryBytes ?? 0,
      digest: this.#checkpoint?.digest ?? null,
      provenance: this.#checkpoint?.metadata.provenance ?? null,
      metrics: this.#checkpoint?.metadata.metrics ?? null,
      stats: { ...this.#stats },
      cache: this.#cache.stats()
    }
  }
}

export const neuralAutomix = new NeuralAutoMixHost()
export { CURVE_CHANNELS }
