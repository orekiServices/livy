#!/usr/bin/env bun
/**
 * Reproducible CLI for Neural AutoMix dataset extraction, training, evaluation,
 * and architecture size/latency benchmarking.
 *
 * Usage:
 *   bun scripts/train-automix.ts extract   --manifest <mix.json> --out <dataset.jsonl>
 *   bun scripts/train-automix.ts train     --dataset <dataset.jsonl> [--preset tcn-compact] [--epochs 40] [--out checkpoints/]
 *   bun scripts/train-automix.ts benchmark [--dataset <dataset.jsonl>] [--presets mlp-nano,mlp-micro,tcn-compact,gru-dj,transformer-mini]
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  extractDatasetFromManifest,
  readTransitionDataset,
  writeTransitionDataset,
  type DjMixManifest
} from '../src/core/models/djDataset.ts'
import { runDjTrainingPipeline } from '../src/core/models/djPipeline.ts'
import { benchmarkArchitectures } from '../src/core/models/benchmark.ts'
import { listNeuralPresets } from '../src/core/models/architectures.ts'

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string> } {
  const cmd = argv[0] ?? 'help'
  const flags: Record<string, string> = {}
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i += 1
      } else {
        flags[key] = 'true'
      }
    }
  }
  return { cmd, flags }
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2))

  if (cmd === 'presets') {
    for (const p of listNeuralPresets()) {
      console.log(
        `${p.id.padEnd(20)} ${p.config.architecture.padEnd(18)} ${String(p.estimatedParams).padStart(10)} params  ${p.description}`
      )
    }
    return
  }

  if (cmd === 'extract') {
    const manifestPath = flags.manifest
    const outPath = flags.out
    if (!manifestPath || !outPath) {
      console.error('Usage: bun scripts/train-automix.ts extract --manifest <mix.json> --out <dataset.jsonl>')
      process.exit(1)
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as DjMixManifest
    const examples = await extractDatasetFromManifest(manifest, {
      minAlignmentConfidence: flags.minConfidence ? Number(flags.minConfidence) : 0.45
    })
    writeTransitionDataset(outPath, examples)
    console.log(`Extracted ${examples.length} real DJ transition(s) from ${manifest.mixId} -> ${outPath}`)
    return
  }

  if (cmd === 'train') {
    const datasetPath = flags.dataset
    if (!datasetPath) {
      console.error('Usage: bun scripts/train-automix.ts train --dataset <dataset.jsonl> [--preset tcn-compact] [--out <dir>]')
      process.exit(1)
    }
    const result = await runDjTrainingPipeline({
      datasetPath,
      preset: flags.preset ?? 'tcn-compact',
      epochs: flags.epochs ? Number(flags.epochs) : 40,
      batchSize: flags.batch ? Number(flags.batch) : 16,
      learningRate: flags.lr ? Number(flags.lr) : 3e-3,
      seed: flags.seed ? Number(flags.seed) : 42,
      checkpointDir: flags.out ?? path.resolve('data/models/automix'),
      backend: (flags.backend as 'auto' | 'ts' | 'torch') ?? 'auto'
    })
    console.log(
      JSON.stringify(
        {
          preset: flags.preset ?? 'tcn-compact',
          architecture: result.config.architecture,
          parameterCount: result.parameterCount,
          backend: result.backend,
          device: result.device,
          bestEpoch: result.bestEpoch,
          valMetrics: result.valMetrics,
          testMetrics: result.testMetrics,
          checkpoints: result.checkpoints,
          elapsedMs: result.elapsedMs
        },
        null,
        2
      )
    )
    return
  }

  if (cmd === 'benchmark') {
    const presetIds = flags.presets ? flags.presets.split(',').map((s) => s.trim()) : undefined
    const examples = flags.dataset ? readTransitionDataset(flags.dataset) : undefined
    const report = await benchmarkArchitectures({
      presetIds,
      examples,
      epochs: flags.epochs ? Number(flags.epochs) : 20,
      maxLatencyP95Ms: flags.maxLatencyMs ? Number(flags.maxLatencyMs) : 15
    })
    console.log(
      JSON.stringify(
        {
          recommended: {
            id: report.recommended.id,
            architecture: report.recommended.architecture,
            parameterCount: report.recommended.parameterCount,
            latencyP95Ms: report.recommended.latencyP95Ms,
            valLoss: report.recommended.valMetrics?.totalLoss ?? null
          },
          reason: report.reason,
          entries: report.entries.map((e) => ({
            id: e.id,
            architecture: e.architecture,
            params: e.parameterCount,
            memKb: e.memoryKb,
            p50Ms: e.latencyP50Ms,
            p95Ms: e.latencyP95Ms,
            valLoss: e.valMetrics?.totalLoss ?? null,
            strategyTop1: e.valMetrics?.strategyTop1 ?? null,
            meetsLatency: e.meetsLatencyBudget,
            meetsQuality: e.meetsQualityTarget
          }))
        },
        null,
        2
      )
    )
    return
  }

  console.log('Commands: presets | extract | train | benchmark')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
