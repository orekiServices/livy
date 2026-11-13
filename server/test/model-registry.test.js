/**
 * Multi-train, the MetroDB registry, training while playing, and private HF
 * storage. No test reaches the network: the hub is a fake `fetch`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import Store from '../src/store/index.js'
import { ACTIONS, FEATURES } from '../src/core/models/features.js'
import { Network } from '../src/core/models/network.js'
import { listModels, resolveModel, saveModel, writableModelDir } from '../src/core/models/storage/local.js'
import { activateModel, modelInventory, pullModels, pushModels } from '../src/core/models/registry.js'
import { configureModels, modelSettings } from '../src/core/models/settings.js'
import { AutoTrainer } from '../src/core/models/auto.js'
import { models } from '../src/core/models/host.js'
import { buildDataset, seamCount, trainModels, recordSeam } from '../src/core/models/trainer/index.js'
import { ensureRepo, hubStatus, uploadFile } from '../src/core/models/storage/hf.js'
import { queueMethods } from '../src/core/station/queue.js'
import { tmpdir } from './helpers.js'

const seams = (count = 240) => {
  const out = []
  let state = 19
  const random = () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0xffff_ffff
  }
  for (let i = 0; i < count; i += 1) {
    const matched = random() > 0.4
    out.push({
      bpmOut: 120 + random() * 20,
      bpmIn: matched ? 122 + random() * 10 : 80 + random() * 30,
      matched,
      correlation: random(),
      loudnessGap: (random() - 0.5) * 4,
      effect: matched ? 'bass-swap' : 'crossfade',
      baseline: 'crossfade',
      outcome: random() > 0.12 ? 'completed' : 'skipped',
      skippedAfterMs: 30_000,
      at: Date.now()
    })
  }
  return out
}

test('multi-train keeps every candidate and activates one', async () => {
  const file = path.join(tmpdir('dj-multi-'), 'seams.jsonl')
  for (const seam of seams(260)) recordSeam(seam, { file })
  const saveDir = tmpdir('dj-multi-models-')

  const report = await trainModels({ file, count: 2, fast: true, epochs: 30, saveDir, activate: false, gpu: false })
  assert.equal(report.trained, true, report.reason)
  assert.equal(report.mode, 'multi')
  assert.equal(report.candidates.length, 2)
  for (const candidate of report.candidates) {
    assert.ok(candidate.name, 'a candidate was saved')
    assert.ok(fs.existsSync(path.join(saveDir, candidate.name)))
    assert.ok(Array.isArray(candidate.shape))
    assert.equal(candidate.shape.at(-1), ACTIONS.length)
  }
  // Only the best is reported as the model, and activation was refused here.
  assert.equal(report.activated, false)
  assert.equal(report.model, null)
  assert.ok(report.accuracyAfter >= 0.6, `learned something (${report.accuracyAfter})`)
})

test('the registry survives a restart because MetroDB holds it', async () => {
  const store = await Store.open(':memory:', { memory: true })
  const net = new Network([FEATURES.length, 8, ACTIONS.length])
  const saved = saveModel(net, { features: FEATURES, steps: 7, activate: false })

  store.saveModelRecord({ name: saved.name, digest: saved.digest, accuracy: 0.87, shape: [16, 8, 10], parameters: 300, backend: 'cpu' })
  const rows = store.listModelRecords()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].accuracy, 0.87)
  assert.deepEqual(rows[0].shape, [16, 8, 10])

  // Activation is a database fact and a manifest fact; both must agree.
  const activated = activateModel(saved.name, { store })
  assert.equal(activated.active, saved.name)
  assert.equal(store.listModelRecords().find((row) => row.name === saved.name).active, true)

  const inventory = modelInventory({ store })
  assert.ok(inventory.some((entry) => entry.name === saved.name && entry.active))
  assert.ok(fs.existsSync(path.join(writableModelDir(), 'manifest.json')))
  fs.rmSync(saved.file, { force: true })
  fs.rmSync(path.join(writableModelDir(), 'manifest.json'), { force: true })
  store.close()
})

test('training data and runs are rows, not files', async () => {
  const store = await Store.open(':memory:', { memory: true })
  for (const seam of seams(5)) store.saveSeam(seam)
  assert.equal(store.countSeams(), 5)
  assert.equal(store.recentSeams(10).length, 5)
  assert.ok(ACTIONS.includes(store.recentSeams(10)[0].effect))

  store.saveTrainingRun({ mode: 'multi', count: 3, backend: 'cpu', trained: true, accuracy: 0.9, best: 'x.bin', report: { fast: true } })
  const [run] = store.recentTrainingRuns(1)
  assert.equal(run.mode, 'multi')
  assert.equal(run.trained, true)
  assert.deepEqual(run.report, { fast: true })
  assert.equal(store.stats().trainingRuns, 1)
  store.close()
})

test('auto-train runs while the station is on air, off the seam table', async () => {
  const store = await Store.open(':memory:', { memory: true })
  for (const seam of seams(200)) store.saveSeam(seam)
  const saveDir = tmpdir('dj-auto-')
  configureModels({ config: { models: { minSeams: 12, everySeams: 5, candidates: 1, fast: true, saveDir } }, store })

  const trainer = new AutoTrainer({ store })
  const report = await trainer.tick({ force: true })
  assert.equal(report.trained, true, report.reason)
  assert.equal(report.count, 1)
  assert.ok(report.accuracyAfter >= 0.5)
  assert.equal(trainer.state().lastRunAt > 0, true)
  const [run] = store.recentTrainingRuns(1)
  assert.equal(run.trained, true)
  configureModels({ config: { models: {} }, store: null })
  store.close()
})

test('a rendered seam becomes a training row through the station path', async () => {
  const store = await Store.open(':memory:', { memory: true })
  const file = path.join(tmpdir('dj-seam-log-'), 'dj-seams.jsonl')
  const station = {
    ...queueMethods,
    store,
    options: { seamLogFile: file },
    _lastSeam: null,
    log: { warn() {}, debug() {} }
  }

  const noted = station.noteSeam({
    at: Date.now(),
    effect: 'bass-swap',
    decision: { source: 'heuristic', baseline: 'crossfade' },
    beat: { bpm: 124, incomingBpm: 126, matched: true, phrase: { beats: 8 } },
    correlation: 0.42,
    loudness: { appliedDb: -1.2 },
    entryEnergy: 0.7,
    blendMs: 8000,
    vocal: { outgoing: true, incoming: false },
    from: 'A',
    to: 'B'
  })
  assert.equal(noted.effect, 'bass-swap')
  assert.equal(noted.phraseAligned, true)
  assert.equal(station._lastSeam, noted, 'the station remembers the seam for a skip')

  assert.equal(station._logSeam({ ...noted, outcome: 'completed', completedAfterMs: 120_000 }), true)
  assert.equal(store.countSeams(), 1)
  assert.equal(fs.existsSync(file), true)

  // A skip inside the attribution window closes the same seam as a negative
  // label instead of being lost.
  station._lastSeam = noted
  assert.equal(station._recordSkip('track-b'), true)
  assert.equal(store.countSeams(), 2)
  const outcomes = store.recentSeams(2).map((row) => row.outcome)
  assert.deepEqual(outcomes, ['completed', 'skipped'])

  // And the row is already the shape the trainer consumes.
  const [pair] = buildDataset(store.recentSeams(2))
  assert.equal(pair.x.length, FEATURES.length)
  assert.equal(pair.y[ACTIONS.indexOf('bass-swap')], 1)

  configureModels({ config: { models: {} }, store: null })
  store.close()
})

test('the seam count falls back to the JSONL log when the table is empty', async () => {
  const store = await Store.open(':memory:', { memory: true })
  const file = path.join(tmpdir('dj-seam-count-'), 'dj-seams.jsonl')
  for (const seam of seams(7)) recordSeam(seam, { file })
  assert.equal(store.countSeams(), 0)
  assert.equal(seamCount({ file, store }), 7)
  assert.equal(seamCount({ file, store: null }), 7)
  store.close()
})

test('auto-train bootstraps from old seams and automix finds the saved model', async () => {
  const store = await Store.open(':memory:', { memory: true })
  for (const seam of seams(80)) store.saveSeam(seam)
  const saveDir = tmpdir('dj-bootstrap-models-')
  const missing = path.join(tmpdir('dj-no-model-'), 'none.bin')
  const previous = process.env.LIVY_DJ_MODEL
  process.env.LIVY_DJ_MODEL = missing
  models.forget()
  configureModels({ config: { models: { minSeams: 12, everySeams: 60, candidates: 1, fast: true, saveDir } }, store })

  const trainer = new AutoTrainer({ store })
  try {
    const started = trainer.start()
    trainer.stop()
    assert.equal(started.lastSeams, 0, 'no model, so existing seams are due')

    // No `force`: the regular poll must pick up the seams already on disk.
    const report = await trainer.tick()
    assert.equal(report.trained, true, report.reason)
    assert.equal(trainer.state().lastSeams, 80)
    assert.ok(report.best?.name, 'a model was written')

    // The custom save directory is part of the host search path, otherwise a
    // freshly trained model is never used by automix.
    delete process.env.LIVY_DJ_MODEL
    models.forget()
    const found = resolveModel()
    assert.ok(found, 'the active model is discoverable')
    assert.equal(path.dirname(found.file), path.resolve(saveDir))
    assert.equal(models.active?.name, report.best.name)
  } finally {
    trainer.stop()
    if (previous === undefined) delete process.env.LIVY_DJ_MODEL
    else process.env.LIVY_DJ_MODEL = previous
    configureModels({ config: { models: {} }, store: null })
    models.forget()
    store.close()
  }
})

/* ------------------------------ HF storage ----------------------------- */

const hfCfg = (repo = 'owner/private-models', token = 'hf_test') => ({
  enabled: true,
  repo,
  revision: 'main',
  private: true,
  token
})

test('a public HF repo is refused, and a new one is created private', async () => {
  const calls = []
  const publicFetch = async (url) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ id: 'owner/public', private: false }), { status: 200 })
  }
  await assert.rejects(() => ensureRepo(hfCfg('owner/public'), { fetchImpl: publicFetch }), /private/)

  const created = []
  const missingFetch = async (url, options = {}) => {
    if (String(url).includes('/api/models/')) return new Response('{}', { status: 404 })
    created.push({ url: String(url), body: JSON.parse(options.body) })
    return new Response(JSON.stringify({ url: 'https://huggingface.co/owner/private-models' }), { status: 200 })
  }
  const result = await ensureRepo(hfCfg(), { fetchImpl: missingFetch })
  assert.equal(result.created, true)
  assert.equal(created.length, 1)
  assert.equal(created[0].body.private, true, 'the repo is created private')
  assert.equal(created[0].body.name, 'owner/private-models')
})

test('upload, list and pull move a model through the hub', async () => {
  configureModels({ config: { models: { hf: hfCfg() } } })
  const remote = new Map()
  const fakeFetch = async (url, options = {}) => {
    const pathname = new global.URL(String(url)).pathname
    if (options.method === 'PUT') {
      remote.set(pathname.split('/').pop(), Buffer.from(options.body))
      return new Response('{}', { status: 200 })
    }
    if (pathname.startsWith('/api/models/') && pathname.endsWith('/tree/main')) {
      return new Response(
        JSON.stringify([...remote.keys()].map((name) => ({ type: 'file', path: name, size: remote.get(name).length }))),
        { status: 200 }
      )
    }
    if (pathname.startsWith('/api/models/')) {
      return new Response(JSON.stringify({ id: 'owner/private-models', private: true }), { status: 200 })
    }
    const name = decodeURIComponent(pathname.split('/').pop())
    if (!remote.has(name)) return new Response('nope', { status: 404 })
    return new Response(remote.get(name), { status: 200 })
  }

  const net = new Network([FEATURES.length, 6, ACTIONS.length])
  const saved = saveModel(net, { features: FEATURES, activate: false })
  const pushed = await pushModels({ names: [saved.name], cfg: hfCfg(), fetchImpl: fakeFetch })
  assert.equal(pushed.pushed.length, 1)
  assert.ok(remote.has(saved.name), 'the bytes are in the repo')

  const status = await hubStatus(hfCfg(), { fetchImpl: fakeFetch })
  assert.equal(status.private, true)
  assert.ok(status.remote.some((entry) => entry.name === saved.name))

  fs.rmSync(saved.file)
  const target = path.join(writableModelDir(), saved.name)
  const pulled = await pullModels({ names: [saved.name], cfg: hfCfg(), fetchImpl: fakeFetch })
  assert.equal(pulled.pulled.length, 1)
  assert.ok(fs.existsSync(target))
  fs.rmSync(target, { force: true })
  configureModels({ config: { models: {} } })
})

test('an upload to a public repo never happens', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ private: false }), { status: 200 })
  await assert.rejects(() => uploadFile(Buffer.from('x'), 'a.bin', hfCfg('owner/public'), { fetchImpl: fakeFetch }), /private/)
})

test('the default settings really are fast, multi and on by default', () => {
  configureModels({ config: { models: {} } })
  const settings = modelSettings()
  assert.equal(settings.autoTrain, true)
  assert.equal(settings.fast, true)
  assert.ok(settings.candidates >= 2)
  assert.equal(settings.hf.private, true)
  // Local listing still works with no models, which is the empty-install case.
  assert.ok(Array.isArray(listModels()))
})
