import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTOMIX_STRATEGIES,
  NEURAL_AUTOMIX_PRESETS,
  NeuralAutoMixHost,
  NeuralAutoMixModel,
  PAIR_FEATURE_DIM,
  SEQ_FEATURE_DIM,
  STAGE1_DIM,
  benchmarkArchitectures,
  encodeAutomationTarget,
  estimateParameters,
  listNeuralPresets,
  loadNeuralCheckpoint,
  packNeuralCheckpoint,
  unpackNeuralCheckpoint,
  type NeuralInput,
  type NeuralTarget
} from '../src/core/models/index.ts'
import { analyzeTrackStructure, buildAutomationPlan, planTransition } from '../src/core/automix/index.ts'

function makeSyntheticPairSample(seed: number, strategyIndex: number): { input: NeuralInput; target: NeuralTarget } {
  const pair = new Float32Array(PAIR_FEATURE_DIM)
  for (let i = 0; i < PAIR_FEATURE_DIM; i += 1) {
    pair[i] = Math.sin(seed * 1.7 + i * 0.43 + strategyIndex * 0.9) * 0.5 + 0.5
  }
  const makeSeq = (offset: number) =>
    Array.from({ length: 16 }, (_, t) => {
      const row = new Float32Array(SEQ_FEATURE_DIM)
      for (let d = 0; d < SEQ_FEATURE_DIM; d += 1) {
        row[d] = Math.cos((t + offset) * 0.35 + d * 0.27 + strategyIndex * 0.5) * 0.5 + 0.5
      }
      return row
    })

  const plan = buildAutomationPlan({
    strategy: AUTOMIX_STRATEGIES[strategyIndex],
    bassSwapAt: 0.4 + (strategyIndex % 4) * 0.1,
    vocalOut: strategyIndex % 2 === 0 ? 0.8 : 0.1,
    vocalIn: strategyIndex % 3 === 0 ? 0.8 : 0.1
  })
  return {
    input: { pair, seqA: makeSeq(seed), seqB: makeSeq(seed + 5) },
    target: {
      stage1: [0.75, 0.15, 0.33 + (strategyIndex % 3) * 0.2, 0.85, 0.9],
      strategyIndex,
      automation: encodeAutomationTarget(plan)
    }
  }
}

test('parameter presets span configurable budgets from ~1K up to 5M parameters', () => {
  const presets = listNeuralPresets()
  assert.ok(presets.length >= 6)
  const counts = presets.map((p) => p.estimatedParams)
  const minParams = Math.min(...counts)
  const maxParams = Math.max(...counts)
  assert.ok(minParams >= 1_000 && minParams <= 6_000, `smallest preset has ${minParams} params`)
  assert.ok(maxParams >= 1_000_000 && maxParams <= 5_000_000, `largest preset has ${maxParams} params`)

  // Verify estimateParameters matches exact instantiated parameterCount for lightweight presets.
  for (const id of ['mlp-nano', 'mlp-micro', 'tcn-compact', 'gru-dj', 'transformer-mini']) {
    const cfg = NEURAL_AUTOMIX_PRESETS[id]
    const model = new NeuralAutoMixModel(cfg)
    assert.equal(model.parameterCount, estimateParameters(cfg), `${id} param count matches estimate`)
  }
})

test('all 4 neural architectures run exact forward + backprop and measurably reduce loss', () => {
  const batch = [
    makeSyntheticPairSample(1, 0),
    makeSyntheticPairSample(2, 1),
    makeSyntheticPairSample(3, 2),
    makeSyntheticPairSample(4, 3)
  ]

  for (const presetId of ['mlp-nano', 'tcn-compact', 'gru-dj', 'transformer-mini']) {
    const cfg =
      presetId === 'transformer-mini'
        ? { ...NEURAL_AUTOMIX_PRESETS[presetId], hiddenDim: 16, numLayers: 1, numHeads: 2 } // fast unit check
        : presetId === 'gru-dj'
          ? { ...NEURAL_AUTOMIX_PRESETS[presetId], hiddenDim: 16, numLayers: 1 }
          : NEURAL_AUTOMIX_PRESETS[presetId]

    const model = new NeuralAutoMixModel(cfg)
    const before = model.trainStep(batch, { learningRate: 8e-3, weightDecay: 1e-4 })
    let after = before
    for (let step = 0; step < 18; step += 1) {
      after = model.trainStep(batch, { learningRate: 8e-3, weightDecay: 1e-4 })
    }
    assert.ok(Number.isFinite(after.totalLoss), `${presetId} loss is finite`)
    assert.ok(
      after.totalLoss < before.totalLoss * 0.85,
      `${presetId} loss decreased (${before.totalLoss.toFixed(4)} -> ${after.totalLoss.toFixed(4)})`
    )

    const pred = model.predict(batch[0].input)
    assert.equal(pred.stage1.length, STAGE1_DIM)
    assert.equal(pred.strategyProbs.length, AUTOMIX_STRATEGIES.length)
    const probSum = pred.strategyProbs.reduce((a, b) => a + b, 0)
    assert.ok(Math.abs(probSum - 1) < 1e-4, `${presetId} softmax sums to 1 (${probSum})`)
  }
})

test('LVMX v2 binary checkpoint packs, unpacks identically, and detects byte corruption', () => {
  const model = new NeuralAutoMixModel(NEURAL_AUTOMIX_PRESETS['tcn-compact'])
  const sample = makeSyntheticPairSample(7, 1)
  const predBefore = model.predict(sample.input)

  const buf = packNeuralCheckpoint(model, {
    normalization: { mean: new Array(PAIR_FEATURE_DIM).fill(0.25), std: new Array(PAIR_FEATURE_DIM).fill(0.5) },
    provenance: { dataset: 'test-dj-sets', mixCount: 3, transitionCount: 24, realDjDataOnly: true },
    metrics: { valLoss: 0.142 }
  })

  const unpacked = unpackNeuralCheckpoint(buf)
  assert.equal(unpacked.version, 2)
  assert.equal(unpacked.metadata.config.architecture, 'tcn-compact')
  assert.equal(unpacked.metadata.provenance?.realDjDataOnly, true)
  assert.ok(unpacked.digest.length === 12)

  const { model: restored } = loadNeuralCheckpoint(buf)
  const predAfter = restored.predict(sample.input)
  for (let i = 0; i < predBefore.automation.length; i += 1) {
    assert.ok(Math.abs(predBefore.automation[i] - predAfter.automation[i]) < 1e-6, `automation[${i}] preserved`)
  }

  // Flip a byte inside the payload — FNV-1a checksum must reject it!
  const corrupted = Buffer.from(buf)
  corrupted[corrupted.length - 12] ^= 0xff
  assert.throws(() => unpackNeuralCheckpoint(corrupted), /checksum mismatch/)
})

test('NeuralAutoMixHost integrates with planTransition and caches predictions', () => {
  const host = new NeuralAutoMixHost()
  const model = new NeuralAutoMixModel(NEURAL_AUTOMIX_PRESETS['mlp-nano'])
  host.setModel(model, null, 'in-memory')

  const sr = 44100
  const makeTone = (freq: number) => {
    const pcm = new Float32Array(sr * 10)
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = Math.sin((2 * Math.PI * freq * i) / sr) * 0.4
    return pcm
  }
  const sA = analyzeTrackStructure(makeTone(220), sr, { bypassCache: true })
  const sB = analyzeTrackStructure(makeTone(261.63), sr, { bypassCache: true })

  const p1 = planTransition(sA, sB, { neuralHost: host, useNeural: true, bypassCache: true })
  assert.ok(p1.neural, 'neural prediction attached to TransitionPlanResult')
  assert.ok(p1.candidates.some((c) => c.id.startsWith('neural-')), 'direct neural candidate evaluated alongside heuristic candidates')

  // Second call on host directly hits LRU prediction cache.
  const hit1 = host.predictForPair(sA, sB, { cacheKey: 'pair:test-hit' })
  const hit2 = host.predictForPair(sA, sB, { cacheKey: 'pair:test-hit' })
  assert.deepEqual(hit1, hit2)
  assert.ok(host.info().stats.cacheHits >= 1)
})

test('benchmarkArchitectures measures latency and selects the smallest qualifying model', async () => {
  const report = await benchmarkArchitectures({
    presetIds: ['mlp-nano', 'mlp-micro', 'tcn-compact'],
    maxLatencyP95Ms: 50,
    iterations: 6
  })

  assert.equal(report.entries.length, 3)
  for (const e of report.entries) {
    assert.ok(e.parameterCount >= 1000)
    assert.ok(e.latencyP50Ms >= 0 && e.latencyP95Ms >= e.latencyP50Ms)
    assert.ok(e.memoryKb > 0)
  }
  // Without training differences, all meet quality & latency, so smallest model must be chosen!
  assert.equal(report.recommended.id, 'mlp-nano', `smallest reliable model chosen: ${report.recommended.id}`)
})
