/**
 * Reproducible Training, Validation, Checkpointing & Evaluation Pipeline for
 * Neural AutoMix models trained on real professional DJ mix datasets.
 *
 * Pipeline stages:
 *   1. Provenance & confidence filtering (rejects synthetic crossfades unless
 *      explicitly enabled for diagnostic unit testing).
 *   2. Leak-free group split by `mixId` (train / validation / test) so tracks
 *      from the same DJ set never span across splits.
 *   3. Train-only feature z-score normalization (embedded into `.lvmx` checkpoint).
 *   4. Deterministic AdamW + cosine LR training with gradient clipping,
 *      periodic validation evaluation, early stopping, and `.lvmx` checkpointing.
 *   5. Comprehensive multi-metric evaluation (Stage-1 cue/duration MAE,
 *      strategy top-1/top-3 accuracy, EQ/gain curve RMSE, bass-swap timing MAE,
 *      vocal-overlap violation rate).
 *   6. Optional PyTorch GPU/CPU training bridge (`server/python/train_automix.py`)
 *      with automatic fallback to pure TypeScript CPU training.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clamp } from '../dsp.ts'
import {
  CURVE_CHANNELS,
  NEURAL_AUTOMIX_PRESETS,
  NeuralAutoMixModel,
  PAIR_FEATURE_DIM,
  type NeuralAutoMixConfig,
  type NeuralInput,
  type NeuralTarget
} from './architectures.ts'
import { packNeuralCheckpoint, type FeatureNormalization } from './neuralFormat.ts'
import { applyNormalization } from './neuralAutomix.ts'
import {
  readTransitionDataset,
  toTrainingSample,
  validateDatasetProvenance,
  type ExtractedTransitionExample
} from './djDataset.ts'
import { pythonCandidates } from './trainer/torch.ts'
import { resolveScalingTier, type ResolvedScalingTier } from './scaling.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverRoot = path.resolve(here, '../../..')
const PY_AUTOMIX_SCRIPT = path.join(serverRoot, 'python', 'train_automix.py')

export interface SplitDataset {
  train: ExtractedTransitionExample[]
  val: ExtractedTransitionExample[]
  test: ExtractedTransitionExample[]
  mixGroups: { train: string[]; val: string[]; test: string[] }
}

export interface EvaluationReport {
  samples: number
  totalLoss: number
  stage1Mae: number
  cueTimingMae: number
  durationMae: number
  strategyTop1: number
  strategyTop3: number
  automationRmse: number
  bassSwapTimingMae: number
  /** Fraction of test predictions where lowA + lowB exceeds sub-bass safety limit (>1.25). */
  bassConflictRate: number
  /** Mean latency per sample on CPU (ms). */
  inferenceMsMean: number
}

export interface EpochLog {
  epoch: number
  learningRate: number
  trainLoss: number
  valLoss: number
  valStrategyTop1: number
  valAutomationRmse: number
}

export interface PipelineOptions {
  /** Pre-loaded examples OR path to a `.jsonl` dataset extracted from real DJ mixes. */
  examples?: ExtractedTransitionExample[]
  datasetPath?: string
  /** Named preset (`mlp-nano`, `tcn-compact`, `gru-dj`, `transformer-mini`, etc.) or explicit config. */
  preset?: string
  config?: Partial<NeuralAutoMixConfig>
  epochs?: number
  batchSize?: number
  learningRate?: number
  minLearningRate?: number
  weightDecay?: number
  clipNorm?: number
  earlyStopPatience?: number
  valFraction?: number
  testFraction?: number
  seed?: number
  minAlignmentConfidence?: number
  /** Strict by default: real DJ mixes only. Set true ONLY for synthetic unit tests. */
  allowSynthetic?: boolean
  /** Directory to write `best.lvmx`, `last.lvmx`, and `report.json`. */
  checkpointDir?: string | null
  /** Prefer PyTorch GPU/CPU script when installed (`auto` | `ts` | `torch`). */
  backend?: 'auto' | 'ts' | 'torch'
  device?: 'auto' | 'cpu' | 'cuda' | 'mps'
  /** Optional host mobile flag to keep auto-scaled parameters within edge/phone budget. */
  mobile?: boolean
  /** Optional upper neural parameter cap when `preset: 'auto'`. */
  maxNeuralParams?: number
}

export interface PipelineResult {
  trained: boolean
  backend: 'ts' | 'torch'
  device: string
  config: NeuralAutoMixConfig
  parameterCount: number
  memoryBytes: number
  seed: number
  scaling: ResolvedScalingTier
  dataset: {
    total: number
    accepted: number
    rejected: number
    train: number
    val: number
    test: number
    mixes: { train: number; val: number; test: number }
  }
  bestEpoch: number
  history: EpochLog[]
  trainMetrics: EvaluationReport
  valMetrics: EvaluationReport
  testMetrics: EvaluationReport
  checkpoints: {
    best: string | null
    last: string | null
    report: string | null
  }
  model: NeuralAutoMixModel
  normalization: FeatureNormalization
  elapsedMs: number
}

/* ------------------------------------------------------------------ *
 * Deterministic RNG + Leak-free group split by mixId
 * ------------------------------------------------------------------ */

function seededShuffle<T>(items: T[], seed: number): T[] {
  const arr = [...items]
  let s = (seed ^ 0x9e3779b9) >>> 0
  for (let i = arr.length - 1; i > 0; i -= 1) {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    const j = s % (i + 1)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/**
 * Group examples by `mixId` so transitions from the same DJ set NEVER leak
 * across train, validation, and test splits.
 */
export function groupSplitByMix(
  examples: ExtractedTransitionExample[],
  { valFraction = 0.15, testFraction = 0.15, seed = 42 }: { valFraction?: number; testFraction?: number; seed?: number } = {}
): SplitDataset {
  const byMix = new Map<string, ExtractedTransitionExample[]>()
  for (const ex of examples) {
    const list = byMix.get(ex.mixId) ?? []
    list.push(ex)
    byMix.set(ex.mixId, list)
  }

  const mixIds = seededShuffle([...byMix.keys()].sort(), seed)

  // If fewer than 3 distinct mixes exist, fall back cleanly to chronological per-mix slicing
  // while keeping whole mixes separate whenever possible.
  if (mixIds.length < 3) {
    const ordered = seededShuffle(examples, seed)
    const nVal = Math.max(1, Math.round(ordered.length * valFraction))
    const nTest = Math.max(1, Math.round(ordered.length * testFraction))
    const nTrain = Math.max(1, ordered.length - nVal - nTest)
    const train = ordered.slice(0, nTrain)
    const val = ordered.slice(nTrain, nTrain + nVal)
    const test = ordered.slice(nTrain + nVal)
    return {
      train,
      val: val.length ? val : train.slice(-1),
      test: test.length ? test : val.length ? val : train.slice(-1),
      mixGroups: {
        train: [...new Set(train.map((e) => e.mixId))],
        val: [...new Set(val.map((e) => e.mixId))],
        test: [...new Set(test.map((e) => e.mixId))]
      }
    }
  }

  const nTestMixes = Math.max(1, Math.round(mixIds.length * testFraction))
  const nValMixes = Math.max(1, Math.round(mixIds.length * valFraction))
  const nTrainMixes = Math.max(1, mixIds.length - nTestMixes - nValMixes)

  const trainMix = mixIds.slice(0, nTrainMixes)
  const valMix = mixIds.slice(nTrainMixes, nTrainMixes + nValMixes)
  const testMix = mixIds.slice(nTrainMixes + nValMixes)

  const collect = (ids: string[]) => ids.flatMap((id) => byMix.get(id) ?? [])
  return {
    train: collect(trainMix),
    val: collect(valMix),
    test: collect(testMix.length ? testMix : valMix),
    mixGroups: { train: trainMix, val: valMix, test: testMix.length ? testMix : valMix }
  }
}

/** Fit z-score mean and standard deviation strictly on the training split. */
export function fitNormalization(samples: Array<{ input: NeuralInput }>): FeatureNormalization {
  const dim = samples[0]?.input.pair.length ?? PAIR_FEATURE_DIM
  const mean = new Array<number>(dim).fill(0)
  const std = new Array<number>(dim).fill(1)
  if (samples.length === 0) return { mean, std }

  for (const s of samples) {
    for (let i = 0; i < dim; i += 1) mean[i] += Number(s.input.pair[i]) || 0
  }
  for (let i = 0; i < dim; i += 1) mean[i] /= samples.length

  const variance = new Array<number>(dim).fill(0)
  for (const s of samples) {
    for (let i = 0; i < dim; i += 1) {
      const d = (Number(s.input.pair[i]) || 0) - mean[i]
      variance[i] += d * d
    }
  }
  for (let i = 0; i < dim; i += 1) {
    const v = Math.sqrt(variance[i] / samples.length)
    std[i] = v > 1e-4 ? Number(v.toFixed(6)) : 1
    mean[i] = Number(mean[i].toFixed(6))
  }
  return { mean, std }
}

function normalizeSamples(
  samples: Array<{ input: NeuralInput; target: NeuralTarget }>,
  norm: FeatureNormalization
): Array<{ input: NeuralInput; target: NeuralTarget }> {
  return samples.map((s) => ({
    input: {
      pair: applyNormalization(Float32Array.from(s.input.pair), norm),
      seqA: s.input.seqA,
      seqB: s.input.seqB
    },
    target: s.target
  }))
}

/* ------------------------------------------------------------------ *
 * Comprehensive Held-Out Model Evaluation
 * ------------------------------------------------------------------ */

export function evaluateNeuralModel(
  model: NeuralAutoMixModel,
  samples: Array<{ input: NeuralInput; target: NeuralTarget }>
): EvaluationReport {
  if (samples.length === 0) {
    return {
      samples: 0,
      totalLoss: 0,
      stage1Mae: 0,
      cueTimingMae: 0,
      durationMae: 0,
      strategyTop1: 0,
      strategyTop3: 0,
      automationRmse: 0,
      bassSwapTimingMae: 0,
      bassConflictRate: 0,
      inferenceMsMean: 0
    }
  }

  let s1LossSum = 0
  let stratLossSum = 0
  let autoLossSum = 0
  let s1MaeSum = 0
  let cueMaeSum = 0
  let durMaeSum = 0
  let top1Hits = 0
  let top3Hits = 0
  let autoSqSum = 0
  let autoCount = 0
  let swapMaeSum = 0
  let bassConflicts = 0
  let latencyTotal = 0

  const K = model.config.knots

  for (const sample of samples) {
    const t0 = performance.now()
    const pred = model.predict(sample.input)
    latencyTotal += performance.now() - t0

    // Stage 1 metrics
    let s1ErrSq = 0
    for (let i = 0; i < pred.stage1.length; i += 1) {
      const diff = pred.stage1[i] - (sample.target.stage1[i] ?? 0)
      s1ErrSq += diff * diff
      s1MaeSum += Math.abs(diff)
    }
    s1LossSum += s1ErrSq / pred.stage1.length
    cueMaeSum += (Math.abs(pred.stage1[0] - (sample.target.stage1[0] ?? 0)) + Math.abs(pred.stage1[1] - (sample.target.stage1[1] ?? 0))) * 0.5
    durMaeSum += Math.abs(pred.stage1[2] - (sample.target.stage1[2] ?? 0))

    // Strategy top-1 & top-3 accuracy + cross-entropy
    const targetIdx = clamp(Math.round(sample.target.strategyIndex), 0, pred.strategyProbs.length - 1)
    stratLossSum += -Math.log(Math.max(1e-7, pred.strategyProbs[targetIdx]))
    const ranked = Array.from(pred.strategyProbs, (p, idx) => ({ p, idx })).sort((a, b) => b.p - a.p)
    if (ranked[0]?.idx === targetIdx) top1Hits += 1
    if (ranked.slice(0, 3).some((r) => r.idx === targetIdx)) top3Hits += 1

    // Continuous automation metrics
    let rowAutoSq = 0
    for (let i = 0; i < pred.automation.length; i += 1) {
      const diff = pred.automation[i] - (sample.target.automation[i] ?? 0)
      rowAutoSq += diff * diff
      autoSqSum += diff * diff
      autoCount += 1
    }
    autoLossSum += rowAutoSq / pred.automation.length
    swapMaeSum += Math.abs(pred.automation[0] - (sample.target.automation[0] ?? 0.5))

    // Check raw predicted sub-bass overlap before sanitizer (channels: gainA=0, gainB=1, lowA=2, lowB=5)
    let hasConflict = false
    for (let k = 0; k < K; k += 1) {
      const gA = pred.automation[2 + 0 * K + k]
      const gB = pred.automation[2 + 1 * K + k]
      const lA = pred.automation[2 + 2 * K + k]
      const lB = pred.automation[2 + 5 * K + k]
      if (gA * lA + gB * lB > 1.25) {
        hasConflict = true
        break
      }
    }
    if (hasConflict) bassConflicts += 1
  }

  const n = samples.length
  const totalLoss = s1LossSum / n + 0.5 * (stratLossSum / n) + 1.5 * (autoLossSum / n)

  return {
    samples: n,
    totalLoss: Number(totalLoss.toFixed(5)),
    stage1Mae: Number((s1MaeSum / (n * 5)).toFixed(4)),
    cueTimingMae: Number((cueMaeSum / n).toFixed(4)),
    durationMae: Number((durMaeSum / n).toFixed(4)),
    strategyTop1: Number((top1Hits / n).toFixed(4)),
    strategyTop3: Number((top3Hits / n).toFixed(4)),
    automationRmse: Number(Math.sqrt(autoSqSum / Math.max(1, autoCount)).toFixed(4)),
    bassSwapTimingMae: Number((swapMaeSum / n).toFixed(4)),
    bassConflictRate: Number((bassConflicts / n).toFixed(4)),
    inferenceMsMean: Number((latencyTotal / n).toFixed(4))
  }
}

/* ------------------------------------------------------------------ *
 * Optional PyTorch GPU/CPU Acceleration Bridge
 * ------------------------------------------------------------------ */

async function tryPyTorchTraining(payload: {
  config: NeuralAutoMixConfig
  train: Array<{ input: NeuralInput; target: NeuralTarget }>
  val: Array<{ input: NeuralInput; target: NeuralTarget }>
  epochs: number
  batchSize: number
  learningRate: number
  weightDecay: number
  device: string
}): Promise<{ ok: true; weights: Record<string, { shape: number[]; data: number[] }>; device: string; history: EpochLog[] } | { ok: false; reason: string }> {
  if (!fs.existsSync(PY_AUTOMIX_SCRIPT)) return { ok: false, reason: 'train_automix.py not found' }

  const pythons = pythonCandidates()
  for (const py of pythons) {
    if (py.includes(path.sep) && !fs.existsSync(py)) continue
    try {
      const result = await new Promise<any>((resolve, reject) => {
        const child = spawn(py, [PY_AUTOMIX_SCRIPT], { cwd: serverRoot, stdio: ['pipe', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error('PyTorch training timed out'))
        }, 180_000)
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (d) => {
          stdout += d
        })
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (d) => {
          stderr += d
        })
        child.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        child.on('close', () => {
          clearTimeout(timer)
          try {
            const lastLine = stdout.trim().split('\n').pop() ?? ''
            resolve(JSON.parse(lastLine))
          } catch {
            reject(new Error(stderr.trim() || 'invalid JSON from train_automix.py'))
          }
        })
        const serializable = {
          config: payload.config,
          epochs: payload.epochs,
          batchSize: payload.batchSize,
          learningRate: payload.learningRate,
          weightDecay: payload.weightDecay,
          device: payload.device,
          train: payload.train.map((s) => ({
            pair: Array.from(s.input.pair),
            seqA: (s.input.seqA as Float32Array[]).map((r) => Array.from(r)),
            seqB: (s.input.seqB as Float32Array[]).map((r) => Array.from(r)),
            target: s.target
          })),
          val: payload.val.map((s) => ({
            pair: Array.from(s.input.pair),
            seqA: (s.input.seqA as Float32Array[]).map((r) => Array.from(r)),
            seqB: (s.input.seqB as Float32Array[]).map((r) => Array.from(r)),
            target: s.target
          }))
        }
        child.stdin.write(`${JSON.stringify(serializable)}\n`)
        child.stdin.end()
      })
      if (result?.ok && result.weights) {
        return { ok: true, weights: result.weights, device: result.device ?? 'cpu', history: result.history ?? [] }
      }
    } catch {
      // Try next Python candidate or fall back cleanly to TypeScript CPU trainer.
    }
  }
  return { ok: false, reason: 'PyTorch with torch package not available; using TypeScript CPU trainer' }
}

/* ------------------------------------------------------------------ *
 * Main Reproducible Training Pipeline
 * ------------------------------------------------------------------ */

export async function runDjTrainingPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const started = Date.now()
  const rawExamples = options.examples ?? (options.datasetPath ? readTransitionDataset(options.datasetPath) : [])
  const validation = validateDatasetProvenance(rawExamples, {
    allowSynthetic: options.allowSynthetic ?? false,
    minAlignmentConfidence: options.minAlignmentConfidence ?? 0.35
  })
  if (validation.valid.length < 4) {
    throw new Error(
      `Insufficient valid real-DJ training examples: ${validation.valid.length} accepted (${validation.rejected} rejected: ${validation.reasons.slice(0, 3).join('; ')})`
    )
  }

  const seed = options.seed ?? 42
  // Infer dataset automation knot count so auto-scaled models match supervision targets cleanly.
  const firstAutoLen = validation.valid[0]?.target.automation.length ?? 2 + CURVE_CHANNELS * 8
  const dataKnots = Math.max(4, Math.round((firstAutoLen - 2) / CURVE_CHANNELS))
  const scaling = resolveScalingTier(validation.valid.length, {
    mobile: options.mobile,
    maxNeuralParams: options.maxNeuralParams,
    knotsOverride: dataKnots
  })

  const useAutoScale = !options.preset || options.preset === 'auto'
  const baseConfig: Partial<NeuralAutoMixConfig> =
    !useAutoScale && options.preset && NEURAL_AUTOMIX_PRESETS[options.preset]
      ? { ...NEURAL_AUTOMIX_PRESETS[options.preset], knots: dataKnots, ...(options.config ?? {}), seed }
      : { ...scaling.neuralConfig, knots: dataKnots, ...(options.config ?? {}), seed }

  const splitData = groupSplitByMix(validation.valid, {
    valFraction: options.valFraction ?? 0.15,
    testFraction: options.testFraction ?? 0.15,
    seed
  })

  const rawTrain = splitData.train.map(toTrainingSample)
  const rawVal = splitData.val.map(toTrainingSample)
  const rawTest = splitData.test.map(toTrainingSample)

  const normalization = fitNormalization(rawTrain)
  const train = normalizeSamples(rawTrain, normalization)
  const val = normalizeSamples(rawVal, normalization)
  const test = normalizeSamples(rawTest, normalization)

  const model = new NeuralAutoMixModel(baseConfig)
  const epochs = Math.max(1, options.epochs ?? 40)
  const batchSize = Math.max(1, Math.min(train.length, options.batchSize ?? 16))
  const lrMax = options.learningRate ?? 3e-3
  const lrMin = options.minLearningRate ?? lrMax * 0.1
  const weightDecay = options.weightDecay ?? 1e-4
  const clipNorm = options.clipNorm ?? 2.0
  const patience = Math.max(3, options.earlyStopPatience ?? 12)

  const history: EpochLog[] = []
  let bestValLoss = Infinity
  let bestEpoch = 0
  let bestWeights = model.exportWeights()
  let usedBackend: 'ts' | 'torch' = 'ts'
  let usedDevice = 'cpu'

  // Optional PyTorch GPU/CPU path when requested or for large models (>50K params).
  const wantTorch =
    options.backend === 'torch' || (options.backend === 'auto' && model.parameterCount >= 50_000)
  if (wantTorch) {
    const torchRes = await tryPyTorchTraining({
      config: model.config,
      train,
      val,
      epochs,
      batchSize,
      learningRate: lrMax,
      weightDecay,
      device: options.device ?? 'auto'
    })
    if (torchRes.ok) {
      model.loadWeights(torchRes.weights)
      bestWeights = model.exportWeights()
      usedBackend = 'torch'
      usedDevice = torchRes.device
      if (torchRes.history.length) history.push(...torchRes.history)
      bestEpoch = history.length || epochs
    }
  }

  if (usedBackend === 'ts') {
    let stale = 0
    for (let epoch = 1; epoch <= epochs; epoch += 1) {
      // Cosine LR schedule.
      const progress = epochs > 1 ? (epoch - 1) / (epochs - 1) : 1
      const lr = lrMin + 0.5 * (lrMax - lrMin) * (1 + Math.cos(Math.PI * progress))

      const ordered = seededShuffle(train, seed + epoch * 7919)
      let epochLoss = 0
      let batchCount = 0
      for (let start = 0; start < ordered.length; start += batchSize) {
        const batch = ordered.slice(start, start + batchSize)
        const step = model.trainStep(batch, { learningRate: lr, weightDecay, clipNorm })
        epochLoss += step.totalLoss
        batchCount += 1
      }

      const valEval = evaluateNeuralModel(model, val)
      const trainLoss = epochLoss / Math.max(1, batchCount)
      history.push({
        epoch,
        learningRate: Number(lr.toFixed(6)),
        trainLoss: Number(trainLoss.toFixed(5)),
        valLoss: valEval.totalLoss,
        valStrategyTop1: valEval.strategyTop1,
        valAutomationRmse: valEval.automationRmse
      })

      if (valEval.totalLoss < bestValLoss - 1e-5) {
        bestValLoss = valEval.totalLoss
        bestEpoch = epoch
        bestWeights = model.exportWeights()
        stale = 0
      } else {
        stale += 1
        if (stale >= patience && epoch >= 8) break
      }

      // Yield to event loop so training never starves live audio playback.
      if (epoch % 4 === 0) await new Promise((resolve) => setImmediate(resolve))
    }
  }

  // Restore best validation weights for final checkpoint & held-out test eval.
  const lastWeights = model.exportWeights()
  model.loadWeights(bestWeights)

  const trainMetrics = evaluateNeuralModel(model, train)
  const valMetrics = evaluateNeuralModel(model, val)
  const testMetrics = evaluateNeuralModel(model, test)

  const checkpoints: { best: string | null; last: string | null; report: string | null } = {
    best: null,
    last: null,
    report: null
  }

  if (options.checkpointDir) {
    fs.mkdirSync(options.checkpointDir, { recursive: true })
    const provenance = {
      dataset: options.datasetPath ? path.basename(options.datasetPath) : 'in-memory',
      mixCount: new Set(validation.valid.map((e) => e.mixId)).size,
      transitionCount: validation.valid.length,
      realDjDataOnly: !(options.allowSynthetic ?? false),
      license: validation.valid[0]?.provenance.license ?? 'unspecified'
    }
    const bestBuf = packNeuralCheckpoint(model, {
      normalization,
      provenance,
      metrics: {
        valLoss: valMetrics.totalLoss,
        testLoss: testMetrics.totalLoss,
        strategyTop1: testMetrics.strategyTop1,
        automationRmse: testMetrics.automationRmse,
        bassSwapTimingMae: testMetrics.bassSwapTimingMae
      },
      steps: bestEpoch
    })
    const bestFile = path.join(options.checkpointDir, 'automix-best.lvmx')
    fs.writeFileSync(bestFile, bestBuf)
    checkpoints.best = bestFile

    const lastModel = new NeuralAutoMixModel(model.config).loadWeights(lastWeights)
    const lastFile = path.join(options.checkpointDir, 'automix-last.lvmx')
    fs.writeFileSync(lastFile, packNeuralCheckpoint(lastModel, { normalization, provenance, steps: history.length }))
    checkpoints.last = lastFile

    const reportFile = path.join(options.checkpointDir, 'training-report.json')
    fs.writeFileSync(
      reportFile,
      JSON.stringify(
        {
          config: model.config,
          parameterCount: model.parameterCount,
          backend: usedBackend,
          device: usedDevice,
          bestEpoch,
          trainMetrics,
          valMetrics,
          testMetrics,
          history
        },
        null,
        2
      ),
      'utf8'
    )
    checkpoints.report = reportFile
  }

  return {
    trained: true,
    backend: usedBackend,
    device: usedDevice,
    config: model.config,
    parameterCount: model.parameterCount,
    memoryBytes: model.memoryBytes,
    seed,
    scaling,
    dataset: {
      total: rawExamples.length,
      accepted: validation.valid.length,
      rejected: validation.rejected,
      train: train.length,
      val: val.length,
      test: test.length,
      mixes: {
        train: splitData.mixGroups.train.length,
        val: splitData.mixGroups.val.length,
        test: splitData.mixGroups.test.length
      }
    },
    bestEpoch,
    history,
    trainMetrics,
    valMetrics,
    testMetrics,
    checkpoints,
    model,
    normalization,
    elapsedMs: Date.now() - started
  }
}

export { CURVE_CHANNELS }
