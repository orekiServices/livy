import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  BPMI_FILE,
  BPMI_FORMAT,
  BPMI_NAME,
  bpmIHiddenShape,
  bpmIParameterCount,
  buildBpmDataset,
  makeBpmProfile,
  estimateBPMi,
  loadBPMi,
  readAllSeams,
  splitBpmDataset,
  trainBPMi
} from '../src/core/models/index.ts'
import { unpackSafetensors } from '../src/core/models/safetensors.ts'
import { beatLoop, tmpdir } from './helpers.ts'

function referenceProfile(index: number, bpm: number, source: string) {
  const title = `Track ${index}`
  return {
    candidates: [
      { bpm: bpm / 2, strength: 1 },
      { bpm, strength: 0.64 },
      { bpm: bpm * 1.5, strength: 0.28 }
    ],
    confidence: 0.72,
    sampleRate: 44_100,
    windowSeconds: 4,
    referenceBpm: bpm,
    referenceSource: 'GetSongBPM',
    labelConfidence: 0.95,
    track: { id: `${source}:${index}`, title, artist: `Artist ${index}`, source }
  }
}

function seamRows(count = 48) {
  const sources = ['soundcloud', 'audius', 'youtube-music', 'local']
  return Array.from({ length: count }, (_, index) => {
    const bpmOut = 90 + (index % 50)
    const bpmIn = 92 + ((index * 7) % 48)
    const sourceOut = sources[index % sources.length]
    const sourceIn = sources[(index + 1) % sources.length]
    return {
      at: 1_800_000_000_000 + index,
      stationId: `station-${index % 3}`,
      sourceOut,
      sourceIn,
      bpmOut,
      bpmIn,
      bpmSource: 'GetSongBPM',
      // Outcomes do not determine whether a tempo observation is useful.
      outcome: index % 2 ? 'skipped' : 'completed',
      bpmi: {
        outgoing: referenceProfile(index * 2, bpmOut, sourceOut),
        incoming: referenceProfile(index * 2 + 1, bpmIn, sourceIn)
      }
    }
  })
}

test('BPMi derives local tempo profiles from CPU DSP candidates', () => {
  const audio = beatLoop({ bpm: 128, seconds: 8 })
  const mono = new Float32Array(audio.left.length)
  for (let index = 0; index < mono.length; index += 1) mono[index] = (audio.left[index] + audio.right[index]) / 2
  const profile = makeBpmProfile(mono, audio.sampleRate, {
    confidence: 0.8,
    scalarBpm: 128,
    scalarConfidence: 1,
    referenceBpm: 128,
    referenceSource: 'GetSongBPM',
    labelConfidence: 0.99,
    track: { id: '128', title: '128', artist: 'Example', source: 'local' }
  })
  assert.ok(profile.candidates.length > 0)
  assert.ok(Math.abs(profile.candidates[0].bpm - 128) < 2, `top tempo candidate is ${profile.candidates[0].bpm}`)
  const estimate = estimateBPMi(profile)
  assert.equal(estimate?.model, BPMI_NAME)
  assert.equal(estimate?.backend, 'cpu')
  assert.ok(Math.abs((estimate?.bpm ?? 0) - 128) < 2)
})

test('BPMi dataset includes both sides and does not filter by station, source or listener outcome', () => {
  const records = seamRows(30)
  const { samples, coverage } = buildBpmDataset(records)
  assert.equal(samples.length, 60)
  assert.equal(coverage.seamsWithProfiles, 30)
  assert.equal(coverage.stations, 3)
  assert.equal(coverage.sources, 4)
  assert.equal(coverage.tracks, 60)
  assert.ok(samples.some((sample) => sample.source === 'soundcloud'))
  assert.ok(samples.some((sample) => sample.source === 'youtube-music'))

  const split = splitBpmDataset(samples)
  const trainKeys = new Set(split.train.map((sample) => sample.key))
  assert.ok(split.test.every((sample) => !trainKeys.has(sample.key)), 'the same recording never leaks across the validation split')
})

test('BPMi capacity grows with observations and the full CPU trainer saves Safetensors', async () => {
  assert.ok(bpmIParameterCount(250_000) > bpmIParameterCount(128))
  assert.ok(bpmIHiddenShape(250_000).length > bpmIHiddenShape(128).length)

  const saveDir = tmpdir('bpmi-model-')
  const report = await trainBPMi({ records: seamRows(64), saveDir, epochs: 100, full: true, force: true })
  assert.equal(report.trained, true, (report as any).reason)
  assert.equal(report.model, BPMI_NAME)
  assert.equal(report.backend, 'cpu')
  assert.equal(report.device, 'cpu')
  assert.equal(report.fullDataFit, true)
  assert.equal(report.observations, 128)
  assert.equal(report.stations, 3)
  assert.equal(report.sources, 4)
  assert.ok(report.parameters > 0)
  assert.ok(report.validation.within5Percent > report.baseline.within5Percent, 'learned ranking improves over strongest-peak selection')

  const file = path.join(saveDir, BPMI_FILE)
  assert.ok(fs.existsSync(file))
  const checkpoint = unpackSafetensors(fs.readFileSync(file))
  assert.equal(checkpoint.metadata.model, BPMI_NAME)
  assert.equal(checkpoint.metadata.format, BPMI_FORMAT)
  assert.equal(checkpoint.metadata.backend, undefined, 'backend stays in the API report, not an ambiguous device tensor')
  const loaded = loadBPMi({ saveDir, force: true })
  assert.ok(loaded)
  assert.equal(loaded.backend, 'cpu')
  assert.equal(loaded.observations, 128)
  const profile = referenceProfile(900, 118, 'local')
  const prediction = estimateBPMi(profile, { model: loaded })
  assert.equal(prediction?.model, 'BPMi')
  assert.equal(prediction?.backend, 'cpu')
  assert.ok(Math.abs((prediction?.bpm ?? 0) - 118) < 6)
})

test('BPMi reads the full union of database and JSONL seams without double-counting mirrored writes', () => {
  const file = path.join(tmpdir('bpmi-seams-'), 'dj-seams.jsonl')
  const [fromStore, fromFile] = seamRows(2)
  fs.writeFileSync(file, `${JSON.stringify(fromStore)}\n${JSON.stringify(fromFile)}\n`)
  const rows = readAllSeams({ file, store: { allSeams: () => [fromStore] } })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].stationId, fromStore.stationId)
  assert.equal(rows[1].stationId, fromFile.stationId)
})
