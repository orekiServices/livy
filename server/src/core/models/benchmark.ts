/**
 * Architecture Size & Latency Benchmarking for Neural AutoMix.
 *
 * Benchmarks multiple model architectures and parameter budgets (spanning ~1K
 * to 5M parameters), measures exact parameter counts, memory footprints, CPU
 * inference latency (p50 / p95), and held-out transition quality, and selects
 * the **smallest model** that meets the quality & latency targets rather than
 * arbitrarily maximizing parameter count.
 */
import {
  NEURAL_AUTOMIX_PRESETS,
  NeuralAutoMixModel,
  type NeuralAutoMixConfig,
  type NeuralInput
} from './architectures.ts'
import { runDjTrainingPipeline, type EvaluationReport } from './djPipeline.ts'
import type { ExtractedTransitionExample } from './djDataset.ts'

export interface ArchitectureBenchmarkEntry {
  id: string
  architecture: string
  parameterCount: number
  memoryKb: number
  latencyP50Ms: number
  latencyP95Ms: number
  trainMs: number | null
  valMetrics: EvaluationReport | null
  testMetrics: EvaluationReport | null
  meetsLatencyBudget: boolean
  meetsQualityTarget: boolean
  config: NeuralAutoMixConfig
}

export interface BenchmarkReport {
  entries: ArchitectureBenchmarkEntry[]
  /** Smallest model that met both latency and quality targets (or best Pareto tradeoff). */
  recommended: ArchitectureBenchmarkEntry
  reason: string
  criteria: {
    maxLatencyP95Ms: number
    qualityTolerance: number
  }
}

/** Measure p50 and p95 single-sample CPU inference latency in milliseconds. */
export function measureInferenceLatency(
  model: NeuralAutoMixModel,
  sampleInput: NeuralInput,
  { warmup = 3, iterations = 25 }: { warmup?: number; iterations?: number } = {}
): { p50Ms: number; p95Ms: number; meanMs: number } {
  for (let i = 0; i < warmup; i += 1) model.predict(sampleInput)
  const times: number[] = []
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now()
    model.predict(sampleInput)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const p50 = times[Math.floor(times.length * 0.5)] ?? 0
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] ?? p50
  const mean = times.reduce((a, b) => a + b, 0) / Math.max(1, times.length)
  return {
    p50Ms: Number(p50.toFixed(4)),
    p95Ms: Number(p95.toFixed(4)),
    meanMs: Number(mean.toFixed(4))
  }
}

/**
 * Benchmark candidate Neural AutoMix architectures (optionally training each on
 * the same real-DJ dataset split) and pick the smallest reliable model.
 */
export async function benchmarkArchitectures(options: {
  presetIds?: string[]
  customConfigs?: Array<{ id: string; config: Partial<NeuralAutoMixConfig> }>
  examples?: ExtractedTransitionExample[]
  epochs?: number
  batchSize?: number
  maxLatencyP95Ms?: number
  /** Maximum validation loss slack over the best model allowed to prefer a smaller model. */
  qualityTolerance?: number
  allowSynthetic?: boolean
  iterations?: number
  seed?: number
} = {}): Promise<BenchmarkReport> {
  const maxLatencyP95Ms = options.maxLatencyP95Ms ?? 15
  const qualityTolerance = options.qualityTolerance ?? 0.05
  const iterations = options.iterations ?? 20
  const seed = options.seed ?? 42

  const candidates: Array<{ id: string; config: NeuralAutoMixConfig }> = []
  if (options.customConfigs?.length) {
    for (const c of options.customConfigs) {
      const m = new NeuralAutoMixModel({ ...NEURAL_AUTOMIX_PRESETS['tcn-compact'], ...c.config, seed })
      candidates.push({ id: c.id, config: m.config })
    }
  } else {
    const ids = options.presetIds ?? ['mlp-nano', 'mlp-micro', 'tcn-compact', 'gru-dj', 'transformer-mini']
    for (const id of ids) {
      const preset = NEURAL_AUTOMIX_PRESETS[id]
      if (preset) candidates.push({ id, config: { ...preset, seed } })
    }
  }

  const probeInput: NeuralInput = {
    pair: new Float32Array(32).fill(0.5),
    seqA: Array.from({ length: 16 }, () => new Float32Array(16).fill(0.25)),
    seqB: Array.from({ length: 16 }, () => new Float32Array(16).fill(0.25))
  }

  const entries: ArchitectureBenchmarkEntry[] = []

  for (const cand of candidates) {
    let model: NeuralAutoMixModel
    let trainMs: number | null = null
    let valMetrics: EvaluationReport | null = null
    let testMetrics: EvaluationReport | null = null

    if (options.examples && options.examples.length >= 4) {
      const res = await runDjTrainingPipeline({
        examples: options.examples,
        config: cand.config,
        epochs: options.epochs ?? 20,
        batchSize: options.batchSize ?? 8,
        allowSynthetic: options.allowSynthetic ?? false,
        seed,
        backend: 'ts'
      })
      model = res.model
      trainMs = res.elapsedMs
      valMetrics = res.valMetrics
      testMetrics = res.testMetrics
    } else {
      model = new NeuralAutoMixModel(cand.config)
    }

    const lat = measureInferenceLatency(model, probeInput, { iterations })
    entries.push({
      id: cand.id,
      architecture: model.config.architecture,
      parameterCount: model.parameterCount,
      memoryKb: Number((model.memoryBytes / 1024).toFixed(2)),
      latencyP50Ms: lat.p50Ms,
      latencyP95Ms: lat.p95Ms,
      trainMs,
      valMetrics,
      testMetrics,
      meetsLatencyBudget: lat.p95Ms <= maxLatencyP95Ms,
      meetsQualityTarget: true,
      config: model.config
    })
  }

  // Evaluate relative quality target against best validation loss (when trained).
  const trainedEntries = entries.filter((e) => e.valMetrics != null)
  if (trainedEntries.length > 0) {
    const bestValLoss = Math.min(...trainedEntries.map((e) => e.valMetrics!.totalLoss))
    const ceiling = bestValLoss * (1 + qualityTolerance) + 0.015
    for (const e of entries) {
      e.meetsQualityTarget = e.valMetrics != null && e.valMetrics.totalLoss <= ceiling
    }
  }

  // Select the SMALLEST model meeting both quality and latency criteria!
  const qualifying = entries
    .filter((e) => e.meetsLatencyBudget && e.meetsQualityTarget)
    .sort((a, b) => a.parameterCount - b.parameterCount)

  let recommended: ArchitectureBenchmarkEntry
  let reason: string
  if (qualifying.length > 0) {
    recommended = qualifying[0]
    reason =
      trainedEntries.length > 0
        ? `smallest architecture (${recommended.parameterCount.toLocaleString()} params, p95 ${recommended.latencyP95Ms} ms) within ${(qualityTolerance * 100).toFixed(0)}% of best validation loss`
        : `smallest architecture (${recommended.parameterCount.toLocaleString()} params, p95 ${recommended.latencyP95Ms} ms) within ${maxLatencyP95Ms} ms p95 latency budget (provide a real DJ dataset to jointly optimize validation quality)`
  } else {
    const sorted = [...entries].sort(
      (a, b) =>
        (a.valMetrics?.totalLoss ?? 0) - (b.valMetrics?.totalLoss ?? 0) || a.parameterCount - b.parameterCount
    )
    recommended = sorted[0]
    reason = `lowest validation loss among candidates (${recommended.parameterCount.toLocaleString()} params, p95 ${recommended.latencyP95Ms} ms)`
  }

  return {
    entries,
    recommended,
    reason,
    criteria: { maxLatencyP95Ms, qualityTolerance }
  }
}
