/**
 * Android/Termux: the node has to run *and* train on a phone.
 *
 * The interesting assertions are the budgets, not the detection: a mobile
 * profile must pick a smaller network, fewer epochs, no GPU, and a bounded
 * dataset, and a saved owner setting must still win over the device default.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { hostInfo } from '../src/util/platform.js'
import { ANDROID_PROFILE, SERVER_PROFILE, trainingProfile } from '../src/core/models/device.js'
import { MOBILE_MODEL_SETTINGS, configureModels, modelSettings } from '../src/core/models/settings.js'
import { recordSeam } from '../src/core/models/trainer/dataset.js'
import { trainModel } from '../src/core/models/trainer/index.js'
import { ACTIONS, FEATURES } from '../src/core/models/features.js'
import { openMemoryDatabase } from '../src/store/driver.js'
import { tmpdir } from './helpers.js'

test('Termux and Android are recognised without shelling out', () => {
  const termux = hostInfo({ PREFIX: '/data/data/com.termux/files/usr', TERMUX_VERSION: '0.118' }, { platform: 'android', cpus: 8, totalMem: 8e9 })
  assert.equal(termux.termux, true)
  assert.equal(termux.android, true)
  assert.equal(termux.mobile, true)
  assert.equal(termux.gpu, false)

  const plain = hostInfo({}, { platform: 'linux', cpus: 16, totalMem: 32e9 })
  assert.equal(plain.mobile, false)
  assert.equal(plain.profile, 'server')
  assert.equal(plain.gpu, true)

  // Explicit overrides are for tests and for a small VPS that wants the
  // desktop schedule.
  assert.equal(hostInfo({ LIVY_PLATFORM: 'android' }, { platform: 'linux', cpus: 16, totalMem: 32e9 }).mobile, true)
  assert.equal(hostInfo({ LIVY_PLATFORM: 'server' }, { platform: 'android', cpus: 8, totalMem: 8e9 }).mobile, false)
  // A 1 GB box is mobile whatever its platform string says.
  assert.equal(hostInfo({}, { platform: 'linux', cpus: 4, totalMem: 900e6 }).mobile, true)
  // A small-but-real VPS is not a phone.
  assert.equal(hostInfo({}, { platform: 'linux', cpus: 2, totalMem: 4e9 }).mobile, false)
})

test('the mobile training profile is smaller in every dimension that costs battery', () => {
  const android = trainingProfile({ host: { mobile: true } })
  assert.equal(android.id, 'android')
  assert.ok(android.epochs < SERVER_PROFILE.epochs)
  assert.ok(android.fastEpochs < SERVER_PROFILE.fastEpochs)
  assert.ok(android.batchMax < SERVER_PROFILE.batchMax)
  assert.ok(android.maxPairs < SERVER_PROFILE.maxPairs)
  assert.equal(android.gpu, false)
  assert.deepEqual(android.shapes, [[12], [14]])
  assert.equal(trainingProfile({ host: { mobile: false } }).id, 'server')
})

test('a fresh Android settings block is cheaper, but a saved choice wins', () => {
  const env = process.env.LIVY_PLATFORM
  process.env.LIVY_PLATFORM = 'android'
  try {
    const fresh = configureModels({ config: {}, host: { mobile: true, profile: 'android', termux: true } })
    assert.equal(fresh.candidates, MOBILE_MODEL_SETTINGS.candidates)
    assert.equal(fresh.pollMs, MOBILE_MODEL_SETTINGS.pollMs)
    assert.equal(fresh.device.profile, 'android')
  } finally {
    if (env === undefined) delete process.env.LIVY_PLATFORM
    else process.env.LIVY_PLATFORM = env
  }

  const saved = { get: () => ({ candidates: 2, pollMs: 60_000 }), set: () => {} }
  process.env.LIVY_PLATFORM = 'android'
  try {
    const remembered = configureModels({ store: saved, host: { mobile: true, profile: 'android', termux: true } })
    assert.equal(remembered.candidates, 2, 'the owner pinned two candidates')
    assert.equal(remembered.pollMs, 60_000, 'and the polling interval')
  } finally {
    if (env === undefined) delete process.env.LIVY_PLATFORM
    else process.env.LIVY_PLATFORM = env
    // Put the process-wide settings back the way the next test file expects:
    // a server profile, whatever this CI machine happens to be.
    configureModels({ config: {}, host: { mobile: false, profile: 'server', termux: false } })
  }
  assert.equal(modelSettings().device.profile, 'server')
})

test('the trainer runs the Android budget and reports it', async () => {
  const dir = tmpdir('android-train-')
  const file = path.join(dir, 'seams.jsonl')
  let state = 11
  const random = () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0xffff_ffff
  }
  for (let i = 0; i < 160; i += 1) {
    const matched = random() > 0.5
    const bpmOut = 100 + random() * 40
    recordSeam(
      {
        bpmOut,
        bpmIn: matched ? bpmOut : bpmOut + 20,
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
    profile: ANDROID_PROFILE,
    activate: false,
    saveDir: tmpdir('android-model-'),
    gpu: false
  })
  assert.equal(report.trained, true, report.reason)
  assert.equal(report.profile, 'android')
  assert.equal(report.epochs, ANDROID_PROFILE.fastEpochs)
  assert.deepEqual(report.shape, [FEATURES.length, 12, ACTIONS.length])
  assert.equal(report.backend, 'cpu')
  assert.ok(report.ms < 20_000, `a phone-sized run stays quick (${report.ms} ms)`)
  assert.ok(report.accuracyAfter >= 0.7, `it still learns (${report.accuracyAfter})`)
  assert.ok(fs.existsSync(report.best.file), 'the winning candidate was written')
})

test('node:sqlite is a usable store backend where Node provides it', async (t) => {
  const available = await import('node:sqlite').then(() => true).catch(() => false)
  if (!available || typeof globalThis.Bun !== 'undefined') return t.skip('node:sqlite is not the selected backend here')

  const previous = process.env.LIVY_DISABLE_METRODB
  process.env.LIVY_DISABLE_METRODB = '1'
  try {
    const db = await openMemoryDatabase()
    assert.match(db.driver, /node:sqlite/)
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT)')
    db.run('INSERT INTO t (value) VALUES (?)', [undefined])
    db.run('INSERT INTO t (value) VALUES (?)', [true])
    const rows = db.all('SELECT id, value FROM t ORDER BY id')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].value, null, 'undefined binds as NULL')
    assert.equal(Number(rows[1].value), 1, 'booleans bind as 0/1')
    db.close()
  } finally {
    if (previous === undefined) delete process.env.LIVY_DISABLE_METRODB
    else process.env.LIVY_DISABLE_METRODB = previous
  }
})
