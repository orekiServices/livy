/**
 * Anything → MP3.
 *
 * A relay does not get to choose what it is handed: AAC over Icecast, an
 * HLS playlist of MPEG-TS segments, a FLAC block, an MP4 chunk. Nodecast
 * broadcasts MP3, so MetroS has to turn all of it into MP3 — without
 * re-encoding the MP3 that arrives already correct.
 *
 * The fixtures are real captures, trimmed to about a second each:
 *   `tone.aac`     ADTS AAC, as an Icecast AAC station sends it
 *   `segment.ts`   an MPEG-TS segment, as HLS sends it
 *
 * Everything else is generated, and no test here touches the network: the
 * HLS test serves its own playlist from a throwaway HTTP server.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MetroTranscoder, transcodeToMp3, sniff, probeMp3, engineInfo, encodeMp3 } from '../src/util/metro.js'
import { buildSilence } from '../src/util/mp3.js'
import { parsePlaylist, chooseVariant, isHlsUrl, hlsSegments } from '../src/util/hls.js'
import { quietLogs } from './helpers.js'

quietLogs()

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name))
const native = engineInfo().native

test('a stream announces what it is before a byte is decoded', () => {
  assert.equal(sniff(fixture('tone.aac')), 'aac')
  assert.equal(sniff(fixture('segment.ts')), 'mpeg-ts')
  assert.equal(sniff(Buffer.concat(buildSilence(300).frames)), 'mp3')
  assert.equal(sniff(Buffer.from('OggS\u0000\u0002rubbish')), 'ogg')
  assert.equal(sniff(Buffer.from('fLaC\u0000\u0000\u0000"')), 'flac')
  assert.equal(sniff(Buffer.alloc(64)), 'unknown')
})

test('mp3 is passed through byte for byte, never re-encoded', async () => {
  const mp3 = Buffer.concat(buildSilence(2000).frames)

  const transcoder = new MetroTranscoder({ bitrate: 128 })
  const parts = []
  for (let at = 0; at < mp3.length; at += 1500) parts.push(transcoder.push(mp3.subarray(at, at + 1500)))
  parts.push(transcoder.flush())

  assert.equal(transcoder.kind, 'mp3')
  assert.equal(transcoder.passthrough, true, 'an mp3 relay must not be re-encoded')
  assert.deepEqual(Buffer.concat(parts), mp3, 'the original bytes, unchanged')
  assert.deepEqual(await transcodeToMp3(mp3), mp3)
})

test('aac becomes mp3, in one shot and a chunk at a time', { skip: native ? false : 'needs libmetro' }, async () => {
  const aac = fixture('tone.aac')

  const once = await transcodeToMp3(aac, { bitrate: 128 })
  const probe = probeMp3(once)
  assert.equal(probe.bitrate, 128)
  assert.ok(probe.frames > 20, `real frames out (${probe.frames})`)
  assert.ok(Math.abs(probe.durationMs - 1000) < 250, `about a second of audio (${Math.round(probe.durationMs)}ms)`)

  // The streaming path must produce exactly the same bytes: one decoder is
  // kept alive across chunks, so there is no seam where they are joined.
  const transcoder = new MetroTranscoder({ bitrate: 128 })
  const parts = []
  for (let at = 0; at < aac.length; at += 700) parts.push(transcoder.push(aac.subarray(at, at + 700)))
  parts.push(transcoder.flush())

  assert.equal(transcoder.kind, 'aac')
  assert.equal(transcoder.passthrough, false)
  assert.deepEqual(Buffer.concat(parts), once, 'streaming and one-shot agree')
  assert.equal(transcoder.stats().framesIn > 20, true)
})

test('an HLS transport-stream segment is demuxed and transcoded', { skip: native ? false : 'needs libmetro' }, async () => {
  const segment = fixture('segment.ts')
  const mp3 = await transcodeToMp3(segment, { bitrate: 128 })
  const probe = probeMp3(mp3)

  assert.equal(sniff(mp3), 'mp3')
  assert.equal(probe.sampleRate, 48000, 'the stream keeps its own sample rate')
  assert.ok(probe.frames > 20, `frames out (${probe.frames})`)

  // Packet-sized pushes, as a socket would deliver them.
  const transcoder = new MetroTranscoder()
  const parts = []
  for (let at = 0; at < segment.length; at += 1316) parts.push(transcoder.push(segment.subarray(at, at + 1316)))
  parts.push(transcoder.flush())
  assert.equal(transcoder.kind, 'mpeg-ts')
  assert.deepEqual(Buffer.concat(parts), mp3)
})

test('unsupported input fails loudly instead of airing silence', async () => {
  const transcoder = new MetroTranscoder()
  assert.throws(() => transcoder.push(Buffer.alloc(4096, 0x5a)), /unrecognised|mp3/i)
})

/* ------------------------------- HLS ---------------------------------- */

test('a playlist is parsed the way the spec says', () => {
  const media = parsePlaylist(
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:99',
      '#EXTINF:4.000,',
      'a.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:3.500,',
      '/abs/b.ts'
    ].join('\n'),
    'https://radio.example/live/chunklist.m3u8'
  )

  assert.equal(media.master, false)
  assert.equal(media.mediaSequence, 99)
  assert.equal(media.targetDuration, 4)
  assert.equal(media.segments.length, 2)
  assert.equal(media.segments[0].url, 'https://radio.example/live/a.ts', 'relative to the playlist')
  assert.equal(media.segments[1].url, 'https://radio.example/abs/b.ts', 'absolute to the host')
  assert.equal(media.segments[1].discontinuity, true)
  assert.equal(media.endList, false)

  const master = parsePlaylist(
    [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=2400000,CODECS="avc1.4d401f,mp4a.40.2"',
      'video.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=96000,CODECS="mp4a.40.2"',
      'audio.m3u8'
    ].join('\n'),
    'https://radio.example/master.m3u8'
  )
  assert.equal(master.master, true)
  // Audio-only, and the cheapest: we re-encode to 128 kbps anyway, so
  // pulling a 2.4 Mbps video rendition would be a waste of everyone's line.
  assert.equal(chooseVariant(master.variants).url, 'https://radio.example/audio.m3u8')
  assert.equal(isHlsUrl('https://radio.example/audio.m3u8?token=1'), true)
  assert.equal(isHlsUrl('https://radio.example/audio.mp3'), false)
})

test('a live playlist is followed segment by segment, without repeats', async (t) => {
  const segment = fixture('segment.ts')
  let sequence = 0
  let served = 0

  // A tiny HLS server whose window slides on every poll.
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/live.m3u8')) {
      const body = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:1',
        `#EXT-X-MEDIA-SEQUENCE:${sequence}`,
        `#EXTINF:1.0,\nseg-${sequence}.ts`,
        `#EXTINF:1.0,\nseg-${sequence + 1}.ts`,
        ''
      ].join('\n')
      sequence += 1
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      return res.end(body)
    }
    served += 1
    res.writeHead(200, { 'content-type': 'video/mp2t' })
    res.end(segment)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const base = `http://127.0.0.1:${server.address().port}`
  const abort = new AbortController()
  const seen = []

  for await (const bytes of hlsSegments(`${base}/live.m3u8`, { signal: abort.signal })) {
    seen.push(bytes)
    if (seen.length >= 3) abort.abort()
  }

  assert.equal(seen.length, 3, 'three distinct segments, in order')
  assert.ok(
    seen.every((bytes) => bytes.equals(segment)),
    'segments arrive intact'
  )
  assert.equal(served, 3, 'nothing was downloaded twice')
})

test('HLS through the transcoder comes out as playable mp3', { skip: native ? false : 'needs libmetro' }, async (t) => {
  const segment = fixture('segment.ts')
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('.m3u8')) {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      return res.end(['#EXTM3U', '#EXT-X-TARGETDURATION:1', '#EXTINF:1.0,', 'a.ts', '#EXT-X-ENDLIST', ''].join('\n'))
    }
    res.writeHead(200)
    res.end(segment)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const transcoder = new MetroTranscoder({ bitrate: 128 })
  const out = []
  for await (const bytes of hlsSegments(`http://127.0.0.1:${server.address().port}/live.m3u8`)) {
    out.push(transcoder.push(bytes))
  }
  out.push(transcoder.flush())

  const probe = probeMp3(Buffer.concat(out))
  assert.equal(transcoder.kind, 'mpeg-ts')
  assert.ok(probe.frames > 20, `the playlist played (${probe.frames} frames)`)
  assert.equal(probe.bitrate, 128)
})

/* ----------------------------- encoding ------------------------------- */

test('the mp3 encoder produces something that decodes back to the same tone', async () => {
  const sampleRate = 44100
  const left = new Float32Array(sampleRate)
  const right = new Float32Array(sampleRate)
  for (let i = 0; i < sampleRate; i += 1) left[i] = right[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5

  const mp3 = await encodeMp3({ left, right, sampleRate, bitrate: 128 })
  const probe = probeMp3(mp3)
  assert.equal(probe.bitrate, 128)
  assert.equal(probe.sampleRate, 44100)
  assert.ok(Math.abs(probe.durationMs - 1000) < 120, `a second of audio (${Math.round(probe.durationMs)}ms)`)
})
