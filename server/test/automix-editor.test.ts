import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeMp3 } from '../src/core/automix/index.ts'
import { isPublicAddress, renderEditorTransition } from '../src/core/automix/editor.ts'
import { probeMp3 } from '../src/util/mp3.ts'
import { beatLoop, boot, toMp3 } from './helpers.ts'

const fileInput = (name: string, bytes: Buffer, title: string, artist: string) => ({
  name,
  base64: bytes.toString('base64'),
  title,
  artist
})

test('Automix Editor renders user MP3s from outgoing end to incoming start only', async () => {
  const outgoing = await toMp3(beatLoop({ bpm: 124, seconds: 18, freq: 120 }), 128)
  const incoming = await toMp3(beatLoop({ bpm: 128, seconds: 18, freq: 240 }), 128)
  const result = await renderEditorTransition({
    outgoing: fileInput('outgoing.mp3', outgoing, 'Last Song', 'Artist A'),
    incoming: fileInput('incoming.MP3', incoming, 'Next Song', 'Artist B'),
    options: { crossfadeMs: 2000, preRollMs: 1000, bitrate: 128, curve: 'equal-power', smart: false }
  })

  assert.equal(result.report.effect, 'crossfade')
  assert.equal(result.report.from, 'Last Song')
  assert.equal(result.report.to, 'Next Song')
  assert.ok(result.durationMs > 0 && result.durationMs < 12_000)
  assert.ok(result.preRollMs >= 950)
  assert.ok(probeMp3(result.mp3).durationMs > 0)
  assert.ok((await decodeMp3(result.mp3))?.length)
})

test('Automix Editor accepts exactly one MP3 input form per direction and blocks private URL targets', async () => {
  const valid = await toMp3(beatLoop({ seconds: 18 }), 128)
  const incoming = fileInput('incoming.mp3', valid, 'Next', 'Artist')

  await assert.rejects(
    renderEditorTransition({
      outgoing: { ...fileInput('outgoing.mp3', valid, 'Last', 'Artist'), url: 'https://example.com/outgoing.mp3' },
      incoming,
      options: { crossfadeMs: 1000, smart: false }
    }),
    /Choose exactly one MP3 file or link/
  )
  await assert.rejects(
    renderEditorTransition({
      outgoing: { url: 'http://127.0.0.1/private.mp3' },
      incoming,
      options: { crossfadeMs: 1000, smart: false }
    }),
    /public internet address/
  )
})

test('owner Automix Editor route returns an auditionable MP3 without creating a station', async (t) => {
  const key = 'automix-editor-test-key'
  const server = await boot({ owner: { key }, stations: [], stationDefaults: { automix: { enabled: false } } })
  t.after(() => server.close())
  const outgoing = await toMp3(beatLoop({ bpm: 124, seconds: 18, freq: 120 }), 128)
  const incoming = await toMp3(beatLoop({ bpm: 128, seconds: 18, freq: 240 }), 128)
  const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/owner/automix/editor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-owner-key': key },
    body: JSON.stringify({
      outgoing: fileInput('outgoing.mp3', outgoing, 'End Track', 'Artist A'),
      incoming: fileInput('incoming.mp3', incoming, 'Start Track', 'Artist B'),
      options: { crossfadeMs: 1000, preRollMs: 500, smart: false }
    })
  })

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /audio\/mpeg/)
  assert.equal(server.manager.size, 0, 'the editor can render with no broadcast station')
  const reportHeader = response.headers.get('x-livy-report')
  assert.ok(reportHeader)
  const report = JSON.parse(Buffer.from(reportHeader, 'base64url').toString('utf8'))
  assert.equal(report.from, 'End Track')
  assert.equal(report.to, 'Start Track')
  assert.equal(report.effect, 'crossfade')
  const mp3 = Buffer.from(await response.arrayBuffer())
  assert.ok(probeMp3(mp3).durationMs > 0)
})

test('Automix Editor URL validation rejects non-public IP ranges, including mapped IPv4', () => {
  for (const address of [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.168.1.1',
    '192.0.2.1',
    '198.18.0.1',
    '203.0.113.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:192.168.1.1'
  ]) assert.equal(isPublicAddress(address), false, `${address} must not be fetched`)

  assert.equal(isPublicAddress('8.8.8.8'), true)
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true)
})
