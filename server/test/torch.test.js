/**
 * The optional PyTorch trainer.
 *
 * Two things are being tested. The first is the decision: `auto` must be able
 * to say *why* it stayed in JavaScript, and must never start an interpreter
 * to be told that. The second is the contract with `python/train.py` — weights
 * that load into a real `Network`, in the same layer order, measuring the same
 * accuracy — because a model trained in Python and read in JavaScript is
 * exactly the place where a silent transpose bug lives.
 *
 * The tests that need torch skip when it is not installed; a node without
 * Python is a supported configuration, not a failure.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { ACTIONS, FEATURES } from '../src/core/models/features.js'
import { Network } from '../src/core/models/network.js'
import { planTorch, pythonCandidates, torchStatus, trainWithTorch, stopTorch, trainBackend } from '../src/core/models/trainer/torch.js'
import { trainModels } from '../src/core/models/trainer/index.js'
import { tmpdir } from './helpers.js'

/** A rule the network can learn from these 16 columns and 10 outputs. */
function separable(rows = 120) {
  const pairs = []
  for (let index = 0; index < rows; index += 1) {
    const x = Array.from({ length: FEATURES.length }, (_, column) => Math.sin((index + 1) * (column + 3)) * 0.9)
    const y = new Array(ACTIONS.length).fill(0)
    // Three classes from the sign of two columns: trivially separable, so a
    // correct exporter reaches ~1.0 and a transposed one sits at chance.
    const klass = x[0] > 0 ? (x[1] > 0 ? 0 : 1) : 2
    y[klass] = 1
    pairs.push({ x, y })
  }
  return pairs
}

const accuracy = (network, pairs) =>
  pairs.filter(({ x, y }) => network.predict(x).indexOf(Math.max(...network.predict(x))) === y.indexOf(1)).length / pairs.length

test('planTorch prefers JavaScript for small CPUs and PyTorch where it pays', () => {
  // A few hundred seams and 700 parameters: the in-process loop is faster.
  assert.equal(planTorch({ rows: 300, parameters: 700 }).use, false)
  assert.match(planTorch({ rows: 300, parameters: 700 }).reason, /JavaScript is faster/)

  // A GPU always wins, whatever the size.
  assert.deepEqual(
    { use: planTorch({ rows: 10, parameters: 100, device: 'cuda' }).use },
    { use: true }
  )
  // A big log: batching rows into BLAS calls is the point.
  assert.equal(planTorch({ rows: 12_000, parameters: 700 }).use, true)
  // A wide model the JS loop would crawl through.
  assert.equal(planTorch({ rows: 500, parameters: 9000 }).use, true)
  // And an explicit request is honoured even when it is not obviously faster.
  assert.equal(planTorch({ backend: 'torch', rows: 100, parameters: 700 }).use, true)
  assert.equal(planTorch({ backend: 'js', rows: 50_000, parameters: 9000, device: 'cuda' }).use, false)
})

test('the backend can be chosen from the environment, and "js" never spawns Python', async () => {
  assert.equal(trainBackend({ LIVY_TRAIN_BACKEND: 'js' }), 'js')
  assert.equal(trainBackend({ LIVY_TRAIN_BACKEND: 'torch' }), 'torch')
  assert.equal(trainBackend({ LIVY_TRAIN_BACKEND: 'nonsense' }), 'auto')
  assert.equal(trainBackend({}), 'auto')

  const status = await torchStatus({ env: { LIVY_PYTHON: 'off' } })
  assert.equal(status.available, false)
  assert.match(status.reason, /LIVY_PYTHON=off/)
  assert.ok(pythonCandidates({ LIVY_PYTHON: 'off' }).every((name) => !name.includes('off')))
})

test('recency weights reach the interpreter: the heavy row decides', async (t) => {
  const status = await torchStatus({ fresh: true })
  if (!status.available) return t.skip(`no PyTorch here (${status.reason})`)

  // One row, two contradictory opinions about it. The weight is the only thing
  // that says which way the fit should go, so a trainer that dropped `w` would
  // answer the same in both runs.
  const x = new Array(FEATURES.length).fill(0.25)
  const label = (index) => {
    const y = new Array(ACTIONS.length).fill(0)
    y[index] = 1
    return y
  }
  const slam = ACTIONS.indexOf('slam')
  const crossfade = ACTIONS.indexOf('crossfade')
  // The trainer will not wake the interpreter for two rows, so the rest of the
  // set is inert filler: same features, zero weight, no vote.
  const filler = Array.from({ length: 10 }, () => ({ x, y: new Array(ACTIONS.length).fill(0), w: 0 }))
  const rows = [...filler, { x, y: label(slam), w: 1 }, { x, y: label(crossfade), w: 0.02 }]
  const flipped = [...filler, { x, y: label(slam), w: 0.02 }, { x, y: label(crossfade), w: 1 }]

  const run = async (train) => {
    const result = await trainWithTorch({ train, jobs: [{ shape: [8], seed: 771 }], epochs: 120, learningRate: 0.02, batch: 2, maxSteps: 800 })
    assert.equal(result.available, true, result.reason)
    const output = Array.from(result.results[0].network.predict(x))
    return output.indexOf(Math.max(...output))
  }
  assert.equal(await run(rows), slam, 'the heavily weighted label wins')
  assert.equal(await run(flipped), crossfade, 'and the same rows with the weights swapped win the other way')
}, { timeout: 120_000 })

test('the torch worker trains a network this build can load', async (t) => {
  const status = await torchStatus({ fresh: true })
  if (!status.available) return t.skip(`no PyTorch here (${status.reason})`)

  const pairs = separable(160)
  const result = await trainWithTorch({
    train: pairs.slice(0, 120),
    jobs: [{ shape: [24, 16], seed: 24301 }],
    epochs: 200,
    learningRate: 0.01,
    batch: 16,
    maxSteps: 2000
  })
  assert.equal(result.available, true, result.reason)
  assert.equal(result.results.length, 1)

  const trained = result.results[0]
  const network = trained.network
  assert.ok(network instanceof Network)
  assert.deepEqual(Array.from(network.shape), [FEATURES.length, 24, 16, ACTIONS.length])
  assert.equal(network.parameterCount, FEATURES.length * 24 + 24 * 16 + 16 * ACTIONS.length + (24 + 16 + ACTIONS.length))
  // The weights are real numbers, not a transposed mess of NaNs.
  for (const layer of network.weights) for (const value of layer) assert.ok(Number.isFinite(value))
  assert.ok(trained.steps > 100, `it took ${trained.steps} steps`)
  assert.ok(trained.ms > 0)

  // The rule is separable, so a correct export reaches it and a transposed one
  // does not: this is the assertion the file exists for.
  assert.ok(accuracy(network, pairs) > 0.95, `held-out accuracy ${accuracy(network, pairs)}`)
  assert.equal(result.device, status.device)
}, { timeout: 120_000 })

test('a training run reports which backend trained it, and falls back when PyTorch is off', async (t) => {
  const status = await torchStatus({ fresh: true })
  const file = path.join(tmpdir('livy-torch-'), 'seams.jsonl')
  const lines = []
  for (let index = 0; index < 200; index += 1) {
    const x = Array.from({ length: FEATURES.length }, (_, column) => Math.sin((index + 1) * (column + 3)) * 0.9)
    const klass = x[0] > 0 ? (x[1] > 0 ? 0 : 1) : 2
    lines.push(
      JSON.stringify({
        effect: ACTIONS[klass],
        outcome: 'completed',
        bpmOut: 80 + (index % 60),
        bpmIn: 80 + (index % 40),
        energy: 0.5 + x[0] / 4,
        energyIn: 0.5 + x[1] / 4,
        correlation: x[2],
        fadeMs: 6000,
        hour: index % 24
      })
    )
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`)

  if (!status.available) {
    const report = await trainModels({ file, backend: 'torch', count: 1, activate: false, saveDir: path.join(tmpdir('livy-torch-'), 'models') })
    assert.equal(report.trained, true)
    assert.equal(report.torch.available, false)
    assert.equal(report.backend, 'cpu', 'the JavaScript trainer trains anyway')
    return t.skip(`no PyTorch here (${status.reason}); the fallback was checked instead`)
  }

  const report = await trainModels({ file, backend: 'torch', count: 1, activate: false, saveDir: path.join(tmpdir('livy-torch-'), 'models') })
  assert.equal(report.trained, true, report.reason)
  assert.equal(report.torch.used, true)
  assert.equal(report.torch.available, true)
  assert.equal(report.backend, 'torch')
  assert.equal(report.candidates[0].backend, 'torch')
  assert.equal(report.candidates[0].torch.device, status.device)
  assert.ok(report.ms >= 0)
}, { timeout: 180_000 })

test('a broken interpreter is a fallback, not a crash', async (t) => {
  const bogus = path.join(tmpdir('livy-torch-'), 'python')
  fs.writeFileSync(bogus, '#!/bin/sh\nexit 3\n', { mode: 0o755 })
  stopTorch()
  const previous = process.env.LIVY_PYTHON
  process.env.LIVY_PYTHON = bogus
  try {
    // A path that exists but is not Python is tried and skipped: whatever
    // answers is a real interpreter, and the bogus one never becomes the
    // chosen one.
    const status = await torchStatus({ fresh: true })
    assert.notEqual(status.interpreter, bogus)
    if (status.available) assert.match(status.interpreter, /python/)
  } finally {
    if (previous === undefined) delete process.env.LIVY_PYTHON
    else process.env.LIVY_PYTHON = previous
    stopTorch()
  }

  // And with PyTorch switched off entirely, training still answers — in
  // JavaScript — instead of throwing.
  const off = await torchStatus({ env: { LIVY_PYTHON: 'off' } })
  assert.equal(off.available, false)
  assert.match(off.reason, /off/)

  const result = await trainWithTorch({ train: separable(40), jobs: [{ shape: [8] }], epochs: 5, device: 'cpu' })
  if (!result.available) assert.ok(result.reason)
  t.diagnostic('a missing or broken interpreter falls back to the JavaScript trainer')
}, { timeout: 90_000 })
