/**
 * DJ models — the format, the network, the trainer, and the guarantee that
 * matters most: a broken model never stops a station.
 *
 * The training test is the one worth reading. It generates a synthetic
 * station whose listeners consistently prefer bass-swaps when the two songs
 * are tempo-matched and crossfades otherwise, trains on it, and checks the
 * network learned *that rule* rather than memorising the rows — which is what
 * a held-out split measures.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { ACTIONS, FEATURES, featuresFor, targetFor } from '../src/core/models/features.ts'
import { Network } from '../src/core/models/network.ts'
import { MAGIC, VERSION, checksum, packModel, unpackModel } from '../src/core/models/format.ts'
import { buildDataset, readSeams, recordSeam, seamFor, trainModel } from '../src/core/models/trainer.ts'
import { saveModel, listModels, modelDirs, models, resolveModel } from '../src/core/models/index.ts'
import { EFFECTS, chooseEffect, chooseEffectWithModel } from '../src/core/automix.ts'
import { tmpdir } from './helpers.ts'

const network = (shape = [FEATURES.length, 8, ACTIONS.length]) => new Network(shape)

test('the feature vector has one number per named feature, and stays in range', () => {
  const features = featuresFor({ bpmOut: 128, bpmIn: 96, correlation: 0.4, fadeMs: 6000, hour: 3 })
  assert.equal(features.length, FEATURES.length)
  for (const [index, value] of features.entries()) {
    assert.ok(Number.isFinite(value), `${FEATURES[index]} is finite`)
    // The tempo ratio is a ratio (0.5…2); everything else is −1…1.
    const limit = FEATURES[index] === 'tempoRatio' ? 2 : 1
    assert.ok(value >= -1.001 && value <= limit + 0.001, `${FEATURES[index]} = ${value} is in range`)
  }
  // 128/96 is a ratio of 1.33, log2 of that is 0.415 — a real value, not a clamp.
  assert.ok(Math.abs(features[FEATURES.indexOf('tempoRatioLog')] - 0.415) < 0.01)
})

test('a `.bin` model round-trips exactly, and carries its feature list', () => {
  const net = network()
  const buffer = packModel({ ...net.parameters(), features: FEATURES, steps: 42 })

  assert.equal(buffer.toString('ascii', 0, 4), MAGIC)
  assert.equal(buffer.readUInt16LE(4), VERSION)

  const model = unpackModel(buffer)
  assert.deepEqual(model.features, FEATURES, 'the column order travels with the file')
  assert.equal(model.steps, 42)
  assert.equal(model.weights.length, 2)
  // Float32 is the storage format, so "exactly" means within one float32 ulp —
  // a Float64 copy of the same number is not equal, and should not be.
  const close = (a, b) => Math.abs(a - b) < 1e-6
  assert.ok(model.weights[0].every((value, index) => close(value, net.weights[0][index])), 'weights survive')
  assert.ok(model.biases[1].every((value, index) => close(value, net.biases[1][index])), 'biases survive')
})

test('a corrupt or truncated model is refused, with a reason', () => {
  const buffer = packModel({ ...network().parameters(), features: FEATURES })
  assert.throws(() => unpackModel(buffer.subarray(0, buffer.length - 8)), /truncated|checksum/)
  const wrongMagic = Buffer.from(buffer)
  wrongMagic.write('XXXX', 0, 'ascii')
  assert.throws(() => unpackModel(wrongMagic), /magic/)
  const wrongVersion = Buffer.from(buffer)
  wrongVersion.writeUInt16LE(99, 4)
  assert.throws(() => unpackModel(wrongVersion), /version 99/)
  assert.equal(checksum(Buffer.from('livy')), checksum(Buffer.from('livy')), 'the checksum is stable')
})

test('the network forward pass has the shape it was built with', () => {
  const net = network([FEATURES.length, 8, ACTIONS.length])
  const output = net.predict(featuresFor({ bpmOut: 120, bpmIn: 120 }))
  assert.equal(output.length, ACTIONS.length)
  assert.ok([...output].every(Number.isFinite))
  assert.equal(net.parameterCount, FEATURES.length * 8 + 8 + 8 * ACTIONS.length + ACTIONS.length)
})

test('training on a synthetic station learns its taste, on held-out rows', () => {
  // A station whose listeners like a bass-swap when the tempos are close and
  // a long crossfade when they are not. The network never sees this rule.
  const random = (() => {
    let state = 7
    return () => {
      state ^= state << 13
      state >>>= 0
      state ^= state >>> 17
      state ^= state << 5
      state >>>= 0
      return state / 0xffff_ffff
    }
  })()

  const records = []
  for (let i = 0; i < 400; i += 1) {
    const matched = random() > 0.5
    const bpmOut = 90 + random() * 60
    const bpmIn = matched ? bpmOut + (random() - 0.5) * 2 : bpmOut + (random() - 0.5) * 40
    const liked = matched ? 'bass-swap' : 'crossfade'
    records.push({
      bpmOut,
      bpmIn,
      matched,
      correlation: random(),
      loudnessGap: (random() - 0.5) * 6,
      energy: random(),
      fadeMs: 6000 + random() * 2000,
      effect: liked,
      baseline: 'crossfade',
      outcome: random() > 0.15 ? 'completed' : 'skipped',
      skippedAfterMs: 20_000
    })
  }

  const dir = tmpdir('dj-model-')
  const file = path.join(dir, 'seams.jsonl')
  for (const record of records) recordSeam(record, { file })
  assert.equal(readSeams({ file }).length, 400, 'every seam was logged')

  const pairs = buildDataset(readSeams({ file }))
  assert.ok(pairs.length > 300, 'most seams carry a label')

  // `saveDir` keeps the run out of server/data/models: a test that installs
  // itself as the station's live policy is a test that changes the next one.
  const saveDir = tmpdir('dj-run-')
  return trainModel({ file, epochs: 120, learningRate: 0.02, activate: false, saveDir, gpu: false }).then((report) => {
    assert.equal(report.trained, true, report.reason ?? report.error?.message ?? 'training ran')
    assert.equal(report.backend, 'cpu')
    assert.ok(report.labelled >= 300)
    assert.ok(
      report.accuracyAfter >= 0.85,
      `the rule was learned, not memorised (held-out accuracy ${report.accuracyAfter})`
    )
    assert.ok(report.accuracyAfter >= report.accuracyBefore, 'and it did not get worse')
    assert.ok(report.ms < 30_000, `it is fast enough to run on a live node (${report.ms} ms)`)
  })
})

test('a target is the outcome, not the heuristic\'s opinion', () => {
  const completed = targetFor({ effect: 'bass-swap', baseline: 'crossfade', outcome: 'completed' })
  assert.ok(completed[ACTIONS.indexOf('bass-swap')] > 0.8, 'the effect that played got the credit')
  assert.ok(completed[ACTIONS.indexOf('crossfade')] < 0.9, 'but the incumbent is not zeroed')

  const skipped = targetFor({ effect: 'bass-swap', baseline: 'crossfade', outcome: 'skipped', skippedAfterMs: 5000 })
  assert.ok(skipped[ACTIONS.indexOf('bass-swap')] < 0.1, 'a skip right after the seam blames it')

  // A skip four minutes later is about the song, not the transition.
  const late = targetFor({ effect: 'bass-swap', baseline: 'crossfade', outcome: 'skipped', skippedAfterMs: 240_000 })
  assert.ok(late[ACTIONS.indexOf('bass-swap')] > 0.3, 'a late skip is not attributed to the seam')
})

test('the model only re-ranks what the heuristic already allows', () => {
  const seam = { beat: true, matched: true, tempoDelta: 1, fadeMs: 6000, correlation: 0.1 }
  const scorings = {
    order: ['bass-swap', 'crossfade', 'wash'],
    best: 'bass-swap',
    margin: 0.4,
    model: 'test'
  }

  // Allowed: the model wins.
  //
  // `chooseEffect` picks at random among the near-best transitions (so two
  // identical-looking seams do not always resolve the same way), which means a
  // single call is not a stable baseline. The claim being tested is about the
  // fold, not about the draw, so the model's pick has to be the same every
  // time regardless of what the heuristic happened to roll.
  for (let run = 0; run < 25; run += 1) {
    const picked = chooseEffectWithModel(seam, [], scorings)
    assert.equal(picked.effect, 'bass-swap', `run ${run}: expected the model's pick, got ${picked.effect} (${picked.source})`)
    assert.equal(picked.source, 'model')
  }

  // Excluded by the pool: the pool wins.
  assert.notEqual(chooseEffectWithModel(seam, ['crossfade', 'wash'], scorings).effect, 'bass-swap')

  // A margin under 0.05 is not a decision.
  const thin = chooseEffectWithModel(seam, [], { ...scorings, margin: 0.01 })
  assert.equal(thin.source, 'heuristic')

  // No model at all: the heuristic's own distribution, untouched. With no
  // model the fold must not even be consulted, so every answer has to be a
  // transition the heuristic can pick.
  for (let run = 0; run < 25; run += 1) {
    const picked = chooseEffectWithModel(seam, [], null)
    assert.equal(picked.source, 'heuristic')
    assert.ok(EFFECTS.includes(picked.effect), `${picked.effect} is a real transition`)
  }
})

test('the model cannot pick a transition the seam cannot carry', () => {
  // No beat: a roll is not on offer, however much the model likes it.
  const noBeat = { beat: false, matched: false, fadeMs: 6000 }
  const choice = chooseEffectWithModel(noBeat, [], { order: ['roll', 'crossfade'], best: 'roll', margin: 0.9 })
  assert.notEqual(choice.effect, 'roll')
  // Nor a matched-only effect on a pair that does not match.
  const unmatched = { beat: true, matched: false, tempoDelta: 20, fadeMs: 6000 }
  const other = chooseEffectWithModel(unmatched, [], { order: ['bass-swap', 'crossfade'], best: 'bass-swap', margin: 0.9 })
  assert.notEqual(other.effect, 'bass-swap')
})

test('a broken model file is a warning, not an outage', () => {
  const dir = tmpdir('dj-broken-')
  const file = path.join(dir, 'broken.bin')
  fs.writeFileSync(file, 'this is not a model')
  // The host is what a station talks to; a bad file must resolve to null.
  const previous = process.env.LIVY_DJ_MODEL
  process.env.LIVY_DJ_MODEL = file
  try {
    assert.equal(models.reload(), null, 'an unreadable model loads as no model')
    assert.equal(models.score({ bpmOut: 120 }), null)
    assert.equal(models.explain({ bpmOut: 120 }), null)
  } finally {
    if (previous === undefined) delete process.env.LIVY_DJ_MODEL
    else process.env.LIVY_DJ_MODEL = previous
    models.reload()
  }
})

test('a saved model is picked up, scored, and explained', () => {
  const dir = tmpdir('dj-save-')
  const net = network([FEATURES.length, 12, ACTIONS.length])
  const saved = saveModel(net, { features: FEATURES, steps: 10, activate: false, dir })
  assert.ok(fs.existsSync(saved.file))
  assert.equal(saved.bytes, fs.statSync(saved.file).size)

  // Point the host at the file and check the whole path: read, score, explain.
  const previous = process.env.LIVY_DJ_MODEL
  process.env.LIVY_DJ_MODEL = saved.file
  try {
    const loaded = models.reload()
    assert.ok(loaded, 'the model loaded')
    assert.equal(loaded.features.length, FEATURES.length)
    const scored = models.score({ bpmOut: 128, bpmIn: 126, matched: true, correlation: 0.3, fadeMs: 6000 })
    assert.ok(scored, 'it scored the seam')
    assert.ok(ACTIONS.includes(scored.best))
    assert.equal(scored.order.length, ACTIONS.length)
    const explained = models.explain({ bpmOut: 128, bpmIn: 126 }, scored.best)
    assert.equal(explained.action, scored.best)
    assert.ok(explained.contributions.length <= 6)
    assert.ok(explained.contributions.every((entry) => FEATURES.includes(entry.feature)), 'every contribution names a real feature')
  } finally {
    if (previous === undefined) delete process.env.LIVY_DJ_MODEL
    else process.env.LIVY_DJ_MODEL = previous
    models.reload()
  }
})

test('a model built for another feature set is refused rather than misread', () => {
  // Two layers of defence, and both are tested here: the writer refuses a
  // network whose input width does not match its feature list, and the reader
  // refuses a file trained on features this build does not have (a model from
  // an older release is exactly that).
  const dir = tmpdir('dj-features-')
  // Four features feeding a layer that wants sixteen inputs: refused at write
  // time, because the resulting file could only ever be misread.
  assert.throws(
    () => packModel({ ...network([FEATURES.length, 8, ACTIONS.length]).parameters(), features: FEATURES.slice(0, 4) }),
    /weights/,
    'the writer will not build a file whose width and feature list disagree'
  )

  // A model that IS internally consistent but was trained on four features.
  const shortFeatures = FEATURES.slice(0, 4)
  const shortNet = new Network([shortFeatures.length, 6, ACTIONS.length])
  const model = packModel({ ...shortNet.parameters(), features: shortFeatures, steps: 1 })
  const file = path.join(dir, 'short.bin')
  fs.writeFileSync(file, model)

  const previous = process.env.LIVY_DJ_MODEL
  process.env.LIVY_DJ_MODEL = file
  try {
    assert.ok(models.reload(), 'the file itself is valid')
    assert.equal(models.score({ bpmOut: 120 }), null, 'but it cannot score this build\'s features')
  } finally {
    if (previous === undefined) delete process.env.LIVY_DJ_MODEL
    else process.env.LIVY_DJ_MODEL = previous
    models.reload()
  }
})

test('seamFor turns an automix report into the features the model was trained on', () => {
  const seam = seamFor({
    report: {
      beat: { bpm: 128, toBpm: 96, matched: false },
      correlation: 0.2,
      loudness: { appliedDb: -2 },
      entryEnergy: 0.7,
      vocal: { outgoing: true, incoming: false },
      blendMs: 8000,
      phrase: { aligned: true },
      dj: { kind: 'intro' }
    },
    hour: 2
  })
  assert.equal(seam.bpmOut, 128)
  assert.equal(seam.bpmIn, 96)
  assert.equal(seam.talkover, true)
  assert.equal(seam.phraseAligned, true)
  assert.equal(featuresFor(seam).length, FEATURES.length)
})

test('models are looked for in the writable data directory first', () => {
  const dirs = modelDirs()
  assert.ok(dirs.length >= 1)
  assert.ok(dirs.every((dir) => path.isAbsolute(dir)))
  // The list is tolerant of directories that do not exist yet.
  assert.ok(Array.isArray(listModels()))
  // With no env override, resolution is either a real file or nothing.
  const resolved = resolveModel({ file: null })
  if (resolved) assert.ok(fs.existsSync(resolved.file))
})
