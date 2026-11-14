import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  NeuralAutoMixHost,
  alignTrackInMix,
  extractDjSupervision,
  groupSplitByMix,
  loadNeuralCheckpoint,
  readTransitionDataset,
  runDjTrainingPipeline,
  validateDatasetProvenance,
  writeTransitionDataset,
  type ExtractedTransitionExample
} from '../src/core/models/index.ts'
import { ThreeBandCrossover } from '../src/core/automix/blender.ts'
import { resample } from '../src/core/dsp.ts'

const SR = 22050 // compact sample rate for snappy DSP alignment unit tests

/** Synthesize a harmonically distinctive track with evolving chord progression & rhythm. */
function synthDistinctTrack(seed: number, seconds: number, chords: number[][], bpm = 124): Float32Array {
  const n = Math.floor(seconds * SR)
  const out = new Float32Array(n)
  const beatSec = 60 / bpm
  for (let i = 0; i < n; i += 1) {
    const t = i / SR
    const chordIdx = Math.floor(t / 2.0) % chords.length
    const chord = chords[chordIdx]
    let sig = 0
    for (let k = 0; k < chord.length; k += 1) {
      sig += Math.sin(2 * Math.PI * chord[k] * t + seed * 0.3) * 0.22
      sig += Math.sin(2 * Math.PI * chord[k] * 2 * t) * 0.08
    }
    const phase = t % beatSec
    const bassNote = chord[0] * 0.25 // distinct harmonic bassline per track (< 200Hz)
    const bass = Math.sin(2 * Math.PI * bassNote * t) * 0.35 + Math.sin(2 * Math.PI * bassNote * 2 * t) * 0.12
    const kick = Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-phase * 35)) * phase) * Math.exp(-phase * 28) * 0.35
    const hihat = Math.sin(2 * Math.PI * 5800 * t) * Math.exp(-((t + beatSec * 0.5) % beatSec) * 60) * 0.12
    out[i] = Math.max(-0.95, Math.min(0.95, sig + bass + kick + hihat))
  }
  return out
}

test('Subsequence-DTW aligns original tracks inside a continuous DJ mix and recovers tempo ratio + 3-band bass swap', () => {
  const trackA = synthDistinctTrack(1, 10, [
    [220, 261.63, 329.63], // Am
    [174.61, 220, 261.63], // F
    [196, 246.94, 293.66], // G
    [220, 261.63, 329.63] // Am
  ])
  const trackB = synthDistinctTrack(2, 10, [
    [261.63, 329.63, 392.0], // C
    [293.66, 349.23, 440.0], // Dm
    [164.81, 196.0, 246.94], // Em
    [261.63, 329.63, 392.0] // C
  ])

  // Render a realistic 16s DJ mix:
  //   0..6s: Track A solo (1.0x)
  //   6..10s: 4s 3-band bass-swap transition (Track B pitched up 1.05x by DJ!)
  //   10..15.5s: Track B solo (1.05x)
  const tempoRatioB = 1.05
  const trackBWarped = resample(trackB, trackB.length, Math.round(trackB.length / tempoRatioB))
  const mixStartB = Math.round(6 * SR)
  const overlapEnd = Math.round(10 * SR)
  const mixLen = mixStartB + trackBWarped.length
  const mix = new Float32Array(mixLen)

  const xoA = new ThreeBandCrossover(200, 3600, SR)
  const xoB = new ThreeBandCrossover(200, 3600, SR)

  for (let i = 0; i < mixLen; i += 1) {
    const aSample = i < trackA.length ? trackA[i] : 0
    const bIdx = i - mixStartB
    const bSample = bIdx >= 0 && bIdx < trackBWarped.length ? trackBWarped[bIdx] : 0

    if (i < mixStartB) {
      mix[i] = aSample
    } else if (i < overlapEnd) {
      const t = (i - mixStartB) / (overlapEnd - mixStartB)
      const [aLo, aMid, aHi] = xoA.split(aSample)
      const [bLo, bMid, bHi] = xoB.split(bSample)
      // Sharp bass swap at t = 0.5, smooth mid/high crossfade!
      const lA = t < 0.5 ? 1 : 0.05
      const lB = t < 0.5 ? 0.05 : 1
      const gA = Math.cos(t * Math.PI * 0.5)
      const gB = Math.sin(t * Math.PI * 0.5)
      mix[i] = aLo * lA + bLo * lB + (aMid + aHi) * gA + (bMid + bHi) * gB
    } else {
      mix[i] = bSample
    }
  }

  const alignA = alignTrackInMix({ mono: mix, sampleRate: SR }, { mono: trackA, sampleRate: SR }, { trackId: 'src-a' })
  const alignB = alignTrackInMix({ mono: mix, sampleRate: SR }, { mono: trackB, sampleRate: SR }, { trackId: 'src-b' })

  assert.ok(alignA.confidence > 0.7, `Track A alignment confidence=${alignA.confidence}`)
  assert.ok(alignB.confidence > 0.7, `Track B alignment confidence=${alignB.confidence}`)
  assert.ok(Math.abs(alignA.mixStartSec - 0) < 1.0, `Track A start=${alignA.mixStartSec}s`)
  assert.ok(Math.abs(alignB.mixStartSec - 6.0) < 1.2, `Track B start=${alignB.mixStartSec}s`)
  assert.ok(Math.abs(alignB.tempoRatio - tempoRatioB) < 0.08, `recovered DJ tempo ratio=${alignB.tempoRatio} (true ${tempoRatioB})`)

  const ex = extractDjSupervision({
    mixId: 'club-set-01',
    mix: { mono: mix, sampleRate: SR },
    trackA: { mono: trackA, sampleRate: SR, trackId: 'src-a' },
    trackB: { mono: trackB, sampleRate: SR, trackId: 'src-b' },
    alignmentA: alignA,
    alignmentB: alignB,
    license: 'CC-BY-4.0',
    djName: 'Resident DJ'
  })

  assert.ok(ex, 'extracted supervised transition example')
  assert.equal(ex.provenance.source, 'real-dj-mix')
  assert.ok(ex.diagnostics.reconstructionR2 > 0.5, `band-wise NNLS reconstruction R^2=${ex.diagnostics.reconstructionR2}`)
  assert.ok(Math.abs(ex.diagnostics.bassSwapAt - 0.5) < 0.25, `recovered bassSwapAt=${ex.diagnostics.bassSwapAt}`)
  assert.equal(ex.input.pair.length, 32)
  assert.equal(ex.target.stage1.length, 5)
})

test('strict provenance validation rejects synthetic crossfades and groupSplitByMix prevents mix leakage', () => {
  const makeEx = (mixId: string, idx: number, source: 'real-dj-mix' | 'synthetic' = 'real-dj-mix'): ExtractedTransitionExample => ({
    exampleId: `${mixId}_t${idx}`,
    mixId,
    trackAId: `a${idx}`,
    trackBId: `b${idx}`,
    provenance: { source, license: 'CC-BY-4.0', alignmentConfidence: 0.85, extractedAt: Date.now() },
    alignment: {
      mixOverlapStartSec: 60,
      mixOverlapEndSec: 76,
      trackAMixOutSec: 180,
      trackBMixInSec: 16,
      durationSec: 16,
      durationBars: 8,
      tempoRatioA: 1,
      tempoRatioB: 1,
      confidenceA: 0.9,
      confidenceB: 0.85
    },
    diagnostics: {
      observedStrategy: 'bass-swap',
      bassSwapAt: 0.5,
      bassSwapWidth: 0.12,
      residualEnergyRatio: 0.05,
      reconstructionR2: 0.92,
      vocalOverlapRatio: 0.04
    },
    input: {
      pair: new Array(32).fill(0.5),
      seqA: Array.from({ length: 16 }, () => new Array(16).fill(0.25)),
      seqB: Array.from({ length: 16 }, () => new Array(16).fill(0.25))
    },
    target: {
      stage1: [0.8, 0.1, 0.33, 0.9, 0.95],
      strategyIndex: idx % 4,
      automation: [0.5, 0.12, ...new Array(14 * 8).fill(0.5)]
    }
  })

  const mixed = [
    makeEx('mix-1', 0, 'real-dj-mix'),
    makeEx('mix-1', 1, 'real-dj-mix'),
    makeEx('mix-2', 2, 'synthetic'),
    makeEx('mix-3', 3, 'real-dj-mix')
  ]
  const checked = validateDatasetProvenance(mixed)
  assert.equal(checked.valid.length, 3)
  assert.equal(checked.rejected, 1)
  assert.match(checked.reasons[0], /rejected non-real source "synthetic"/)

  // Leak-free split across 6 distinct DJ sets
  const sixMixes: ExtractedTransitionExample[] = []
  for (let m = 0; m < 6; m += 1) {
    sixMixes.push(makeEx(`set-${m}`, m * 2))
    sixMixes.push(makeEx(`set-${m}`, m * 2 + 1))
  }
  const split = groupSplitByMix(sixMixes, { valFraction: 0.2, testFraction: 0.2, seed: 7 })
  const trainSet = new Set(split.train.map((e) => e.mixId))
  const valSet = new Set(split.val.map((e) => e.mixId))
  const testSet = new Set(split.test.map((e) => e.mixId))

  for (const id of valSet) assert.equal(trainSet.has(id), false, `mix ${id} leaked from train into val`)
  for (const id of testSet) assert.equal(trainSet.has(id), false, `mix ${id} leaked from train into test`)
})

test('runDjTrainingPipeline trains reproducibly, saves LVMX checkpoints, and reloads into NeuralAutoMixHost', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livy-dj-pipe-'))
  try {
    const dataset: ExtractedTransitionExample[] = []
    for (let m = 0; m < 5; m += 1) {
      for (let t = 0; t < 3; t += 1) {
        const strat = (m + t) % 3
        const pair = Array.from({ length: 32 }, (_, i) => Number((Math.sin(i * 0.4 + strat * 1.3 + m * 0.1) * 0.5 + 0.5).toFixed(4)))
        dataset.push({
          exampleId: `mix-${m}_tr-${t}`,
          mixId: `mix-${m}`,
          trackAId: `a-${m}-${t}`,
          trackBId: `b-${m}-${t}`,
          provenance: { source: 'real-dj-mix', license: 'CC-BY-4.0', alignmentConfidence: 0.88, extractedAt: Date.now() },
          alignment: {
            mixOverlapStartSec: 30,
            mixOverlapEndSec: 46,
            trackAMixOutSec: 160,
            trackBMixInSec: 12,
            durationSec: 16,
            durationBars: 8,
            tempoRatioA: 1,
            tempoRatioB: 1,
            confidenceA: 0.9,
            confidenceB: 0.88
          },
          diagnostics: {
            observedStrategy: strat === 0 ? 'bass-swap' : strat === 1 ? 'eq-blend' : 'filter',
            bassSwapAt: 0.45 + strat * 0.1,
            bassSwapWidth: 0.12,
            residualEnergyRatio: 0.04,
            reconstructionR2: 0.94,
            vocalOverlapRatio: 0.02
          },
          input: {
            pair,
            seqA: Array.from({ length: 16 }, () => new Array(16).fill(0.2 + strat * 0.2)),
            seqB: Array.from({ length: 16 }, () => new Array(16).fill(0.3 + strat * 0.15))
          },
          target: {
            stage1: [0.78, 0.12, 0.35 + strat * 0.15, 0.9, 0.92],
            strategyIndex: strat,
            automation: [0.45 + strat * 0.1, 0.12, ...new Array(14 * 8).fill(0.35 + strat * 0.2)]
          }
        })
      }
    }

    const jsonlPath = path.join(dir, 'dj-dataset.jsonl')
    writeTransitionDataset(jsonlPath, dataset)
    const reloaded = readTransitionDataset(jsonlPath)
    assert.equal(reloaded.length, dataset.length)

    const result = await runDjTrainingPipeline({
      datasetPath: jsonlPath,
      preset: 'mlp-nano',
      epochs: 18,
      batchSize: 4,
      learningRate: 6e-3,
      seed: 123,
      checkpointDir: path.join(dir, 'checkpoints'),
      backend: 'ts'
    })

    assert.equal(result.trained, true)
    assert.ok(result.history.length >= 4)
    assert.ok(result.history[result.history.length - 1].trainLoss < result.history[0].trainLoss)
    assert.ok(result.checkpoints.best && fs.existsSync(result.checkpoints.best))
    assert.ok(result.checkpoints.last && fs.existsSync(result.checkpoints.last))
    assert.ok(result.checkpoints.report && fs.existsSync(result.checkpoints.report))

    // Reload checkpoint from disk into NeuralAutoMixHost cleanly!
    const { model, checkpoint } = loadNeuralCheckpoint(fs.readFileSync(result.checkpoints.best))
    assert.equal(model.parameterCount, result.parameterCount)
    assert.equal(checkpoint.metadata.provenance?.realDjDataOnly, true)

    const host = new NeuralAutoMixHost()
    assert.ok(host.reload(result.checkpoints.best))
    assert.equal(host.info().loaded, true)
    assert.equal(host.info().parameters, result.parameterCount)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
