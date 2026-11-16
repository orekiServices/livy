import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { AUTOMIX_MP3_USAGE, parseAutomixMp3Args, renderAutomixMp3 } from '../src/core/automix/cli.ts'
import { decodeMp3 } from '../src/core/automix/index.ts'
import { probeMp3 } from '../src/util/mp3.ts'
import { beatLoop, tmpdir, toMp3 } from './helpers.ts'

test('automix MP3 CLI parses outgoing first, incoming second, and documents head/tail scope', () => {
  const parsed = parseAutomixMp3Args([
    '--',
    'outgoing.mp3',
    'incoming.mp3',
    '--output',
    'seam.mp3',
    '--crossfade-ms',
    '7000',
    '--pre-roll-ms',
    '2500',
    '--fixed'
  ])
  assert.deepEqual(parsed, {
    help: false,
    options: {
      outgoing: 'outgoing.mp3',
      incoming: 'incoming.mp3',
      output: 'seam.mp3',
      crossfadeMs: 7000,
      preRollMs: 2500,
      smart: false
    }
  })
  assert.match(AUTOMIX_MP3_USAGE, /END into the incoming file's START/)
  assert.match(AUTOMIX_MP3_USAGE, /else Livy's local detector/)
})

test('automix MP3 renderer mixes only the outgoing tail into the incoming head', async () => {
  const dir = tmpdir('automix-cli-')
  const outgoing = path.join(dir, 'outgoing.mp3')
  const incoming = path.join(dir, 'incoming.mp3')
  const output = path.join(dir, 'transition.mp3')
  fs.writeFileSync(outgoing, await toMp3(beatLoop({ bpm: 124, seconds: 24, freq: 110 }), 128))
  fs.writeFileSync(incoming, await toMp3(beatLoop({ bpm: 128, seconds: 24, freq: 220 }), 128))

  const result = await renderAutomixMp3({ outgoing, incoming, output, smart: false, crossfadeMs: 4000, preRollMs: 1500 })
  assert.equal(result.report.effect, 'crossfade')
  assert.equal(result.report.from, 'outgoing')
  assert.equal(result.report.to, 'incoming')
  assert.ok(result.outgoingWindowMs < 8000, `outgoing render window was ${result.outgoingWindowMs}ms`)
  assert.ok(result.incomingWindowMs < 10_000, `incoming render window was ${result.incomingWindowMs}ms`)
  assert.ok(result.preRollMs >= 1450)
  assert.ok(result.durationMs < 15_000, `transition clip unexpectedly includes whole tracks (${result.durationMs}ms)`)
  assert.ok(fs.existsSync(output))
  assert.ok(probeMp3(fs.readFileSync(output)).durationMs > 0)
  const decoded = await decodeMp3(fs.readFileSync(output))
  assert.ok(decoded?.length > 0, 'the transition MP3 decodes to audio')

  const smartOutput = path.join(dir, 'smart-transition.mp3')
  const smartResult = await renderAutomixMp3({ outgoing, incoming, output: smartOutput })
  assert.equal(smartResult.report.effect, 'crossfade')
  assert.ok(smartResult.outgoingWindowMs < 25_000)
  assert.ok(smartResult.incomingWindowMs < 25_000)
  assert.ok(smartResult.preRollMs >= 2950)
  assert.ok(smartResult.durationMs < 20_000, `default output included too much source audio (${smartResult.durationMs}ms)`)
  assert.ok(probeMp3(fs.readFileSync(smartOutput)).durationMs > 0)
})

test('automix MP3 CLI rejects a too-short edge and does not overwrite an input', async () => {
  const dir = tmpdir('automix-cli-invalid-')
  const short = path.join(dir, 'short.mp3')
  const other = path.join(dir, 'other.mp3')
  const bytes = await toMp3(beatLoop({ seconds: 2 }), 128)
  fs.writeFileSync(short, bytes)
  fs.writeFileSync(other, bytes)

  await assert.rejects(renderAutomixMp3({ outgoing: short, incoming: other, output: path.join(dir, 'out.mp3'), smart: false }), /too short/)
  await assert.rejects(renderAutomixMp3({ outgoing: short, incoming: other, output: short }), /must not overwrite/)
})
