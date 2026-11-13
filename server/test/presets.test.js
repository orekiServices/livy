/**
 * More trainable DJ models: the presets are real architectures, not labels.
 *
 * The tests check three layers: the preset resolves against a host (a phone
 * stays a phone), the trainer actually builds the promised shape, and the
 * owner API can list, select and reject presets.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { MODEL_PRESETS, isModelPreset, modelPresets } from '../src/core/models/presets.js'
import { trainingProfile } from '../src/core/models/device.js'
import { configureModels, modelSettings, updateModelSettings } from '../src/core/models/settings.js'
import { recordSeam } from '../src/core/models/trainer/dataset.js'
import { trainModel } from '../src/core/models/trainer/index.js'
import { ACTIONS, FEATURES } from '../src/core/models/features.js'
import { boot, api, tmpdir, quietLogs } from './helpers.js'

quietLogs()

test('every preset is a distinct architecture with a real budget', () => {
  const ids = modelPresets().map((entry) => entry.id)
  assert.deepEqual(ids, ['auto', 'fast', 'balanced', 'wide', 'deep'])
  for (const id of ids) {
    assert.equal(isModelPreset(id), true)
    if (id === 'auto') continue
    const preset = MODEL_PRESETS[id]
    assert.ok(preset.shapes.length >= 2, `${id} offers more than one candidate shape`)
    assert.ok(preset.epochs > 0 && preset.fastEpochs > 0, `${id} has an epoch budget`)
    assert.ok(preset.fastEpochs < preset.epochs, `${id} fast mode is shorter`)
    for (const shape of preset.shapes) {
      assert.ok(shape.length >= 1 && shape.length <= 4, `${id} has a sane hidden depth`)
      assert.ok(shape.every((width) => width >= 8 && width <= 128), `${id} widths are trainable`)
    }
  }
  assert.equal(isModelPreset('nope'), false)
  assert.equal(isModelPreset(undefined), false)
})

test('a preset changes the architecture, the host still owns the phone limits', () => {
  const phone = { mobile: true, profile: 'android', termux: true }
  const server = { mobile: false, profile: 'server', termux: false }

  const widePhone = trainingProfile({ host: phone, preset: 'wide' })
  assert.equal(widePhone.id, 'wide')
  assert.equal(widePhone.host, 'android')
  assert.deepEqual(widePhone.shapes, MODEL_PRESETS.wide.shapes)
  assert.deepEqual(widePhone.fastShapes, MODEL_PRESETS.wide.shapes, 'fast mode does not shrink the chosen architecture')
  assert.equal(widePhone.batchMax, 8, 'the phone batch size is not widened by the preset')
  assert.equal(widePhone.maxPairs, 1200, 'the phone data budget is still capped')
  assert.equal(widePhone.gpu, false, 'a preset cannot ask a phone for a GPU')
  assert.equal(widePhone.fastEpochs, MODEL_PRESETS.wide.fastEpochs)

  const deepServer = trainingProfile({ host: server, preset: 'deep' })
  assert.equal(deepServer.id, 'deep')
  assert.equal(deepServer.host, 'server')
  assert.deepEqual(deepServer.shapes, MODEL_PRESETS.deep.shapes)
  assert.equal(deepServer.gpu, true)

  // Unknown or missing falls back to the device profile rather than throwing.
  assert.equal(trainingProfile({ host: phone, preset: 'nope' }).id, 'android')
  assert.equal(trainingProfile({ host: server }).id, 'server')
})

test('settings accept presets, reject typos, and keep them across a reload', () => {
  configureModels({ config: {}, host: { mobile: false, profile: 'server', termux: false } })
  assert.equal(modelSettings().preset, 'auto')

  const saved = updateModelSettings({ preset: 'wide' })
  assert.equal(saved.preset, 'wide')
  assert.throws(() => updateModelSettings({ preset: 'enormous' }), (error) => error.status === 400 && /Unknown model preset/.test(error.message))
  assert.equal(modelSettings().preset, 'wide', 'a rejected patch leaves the setting alone')

  configureModels({ config: {}, host: { mobile: false, profile: 'server', termux: false } })
})

test('the trainer builds the selected preset and says so', async () => {
  const dir = tmpdir('preset-train-')
  const file = path.join(dir, 'seams.jsonl')
  let state = 23
  const random = () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0xffff_ffff
  }
  for (let i = 0; i < 180; i += 1) {
    const matched = random() > 0.5
    const bpmOut = 96 + random() * 48
    recordSeam(
      {
        bpmOut,
        bpmIn: matched ? bpmOut : bpmOut + 24,
        matched,
        correlation: random(),
        loudnessGap: (random() - 0.5) * 4,
        energy: random(),
        fadeMs: 5000 + random() * 1000,
        effect: matched ? 'bass-swap' : 'crossfade',
        baseline: 'crossfade',
        outcome: 'completed'
      },
      { file }
    )
  }

  const report = await trainModel({
    file,
    preset: 'fast',
    activate: false,
    saveDir: tmpdir('preset-model-'),
    gpu: false
  })
  assert.equal(report.trained, true, report.reason)
  assert.equal(report.preset, 'fast')
  assert.equal(report.profile, 'fast')
  assert.equal(report.epochs, MODEL_PRESETS.fast.fastEpochs, 'fast mode uses the preset fast budget')
  const hidden = report.shape.slice(1, -1)
  assert.ok(
    MODEL_PRESETS.fast.shapes.some((shape) => shape.length === hidden.length && shape.every((width, index) => width === hidden[index])),
    `trained ${hidden.join('→')}, which is one of the fast shapes`
  )
  assert.deepEqual(report.shape[0], FEATURES.length)
  assert.deepEqual(report.shape.at(-1), ACTIONS.length)
  assert.ok(report.ms < 20_000, `a preset run stays quick (${report.ms} ms)`)
})

test('the owner API lists presets and applies them to the next run', async (t) => {
  const dir = tmpdir('preset-api-')
  const KEY = 'preset-owner-key'
  const instance = await boot({
    _dir: dir,
    owner: { key: KEY, name: 'tester' },
    store: { enabled: true, file: path.join(dir, 'livy.db') },
    models: { autoTrain: false, preset: 'auto' }
  })
  const base = `http://127.0.0.1:${instance.port}`
  t.after(() => instance.close?.())

  const list = await api(base, '/api/v1/owner/models', { key: KEY })
  assert.equal(list._status, 200)
  assert.deepEqual(list.presets.map((entry) => entry.id), ['auto', 'fast', 'balanced', 'wide', 'deep'])
  assert.equal(list.settings.preset, 'auto')

  const patched = await api(base, '/api/v1/owner/models/settings', { method: 'PATCH', key: KEY, body: { preset: 'deep' } })
  assert.equal(patched._status, 200)
  assert.equal(patched.preset, 'deep')

  const bad = await api(base, '/api/v1/owner/models/settings', { method: 'PATCH', key: KEY, body: { preset: 'gigantic' } })
  assert.equal(bad._status, 400)
  assert.match(bad.message, /Unknown model preset/)

  const badTrain = await api(base, '/api/v1/owner/models/train', { method: 'POST', key: KEY, body: { preset: 'huge', count: 1 } })
  assert.equal(badTrain._status, 400)

  // No seams means a 409 with a reason, but the preset itself was accepted.
  const train = await api(base, '/api/v1/owner/models/train', { method: 'POST', key: KEY, body: { preset: 'fast', count: 1 } })
  assert.equal(train._status, 409)
  assert.match(train.reason, /labelled seams/)
})
