/**
 * MetroS — the relay engine.
 *
 * Two implementations have to behave identically: the native `libmetro`
 * addon and the pure-JavaScript fallback in `src/util/mp3.js`. These tests
 * do not care which one is loaded; they check that whichever it is produces
 * exactly the bytes the other would, that live relays end up on air, and
 * that the engine is honest about what it is.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { MetroFramer, probeMp3, scanFrames, decodeMp3, engineInfo } from '../src/util/metro.js'
import { Mp3FrameSplitter, probeMp3 as probeMp3Js, buildSilence } from '../src/util/mp3.js'
import Station from '../src/core/station.js'
import { SourceRegistry } from '../src/sources/index.js'
import { encodeMp3 } from '../src/core/automix.js'
import { quietLogs, tmpdir, makeMedia, waitFor } from './helpers.js'

quietLogs()

/** ~4 s of real (silent) MP3 with an ID3 tag glued to the front. */
function sample({ ms = 1500 } = {}) {
  const audio = Buffer.concat(buildSilence(ms).frames)
  const tag = Buffer.alloc(10 + 64)
  tag.write('ID3')
  tag[3] = 3
  tag[9] = 64 // syncsafe size of the (empty) tag body
  return { audio, tagged: Buffer.concat([tag, audio]) }
}

/** Feed a buffer through a framer in fixed-size chunks. */
function feed(framer, buffer, size) {
  const frames = []
  for (let at = 0; at < buffer.length; at += size) {
    frames.push(...framer.push(buffer.subarray(at, at + size)).frames)
  }
  return frames
}

test('the engine reports itself honestly', () => {
  const info = engineInfo()
  assert.ok(info.engine.startsWith('MetroS'))
  assert.equal(typeof info.native, 'boolean')
  assert.ok(info.describe.length > 0)
  // Native or not, the decoder must be named — "none" is never an answer.
  assert.ok(['libmetro (rust)', 'mpg123 (wasm)'].includes(info.decoder))
  assert.equal(new MetroFramer().engine, info.native ? 'native' : 'javascript')
})

test('MetroS re-frames a stream exactly like the JavaScript splitter', () => {
  const { tagged } = sample()

  for (const size of [1, 7, 1400, 8192, 1_000_000]) {
    const metro = Buffer.concat(feed(new MetroFramer(), tagged, size))
    const js = Buffer.concat(feed(new Mp3FrameSplitter(), tagged, size))
    assert.ok(metro.length > 0, `${size}B chunks produced audio`)
    assert.deepEqual(metro, js, `identical output at ${size}B chunks`)
  }
})

test('frames survive being handed out: a later push never rewrites an earlier one', () => {
  const { audio } = sample({ ms: 2000 })
  const framer = new MetroFramer()
  const kept = feed(framer, audio, 512)
  // Push a second copy through; the frames from the first pass must still
  // read back as the frames we were given. (The native engine writes into a
  // reusable buffer internally — this is the test that it hands out safe
  // views of a per-push allocation instead.)
  const before = Buffer.concat(kept)
  feed(framer, audio, 512)
  assert.deepEqual(Buffer.concat(kept), before)
})

test('an ID3 tag, garbage and a mid-frame join are all resynchronised', () => {
  const { audio } = sample({ ms: 3000 })
  const junk = Buffer.alloc(300, 0xff) // looks like sync words, is not audio
  const messy = Buffer.concat([junk, audio.subarray(200), junk, audio])

  const metro = new MetroFramer()
  const frames = feed(metro, messy, 777)
  assert.ok(frames.length > 100, 'the audio came through')
  for (const frame of frames) {
    assert.equal(frame[0], 0xff, 'every frame starts on a sync word')
    assert.equal(frame[1] & 0xe0, 0xe0)
  }
  // The clean copy at the end of the mess must come through untouched.
  assert.ok(Buffer.concat(frames).includes(audio), 'the intact copy survived the resync')

  // The two engines may disagree by a single frame at a junk seam: MetroS
  // only accepts a header when the *next* header lands exactly where this
  // frame ends, so it rejects the odd false positive the simpler scanner
  // lets through. Anything more than that would be a real difference.
  const js = feed(new Mp3FrameSplitter(), messy, 777)
  assert.ok(Math.abs(frames.length - js.length) <= 1, `${frames.length} frames vs ${js.length}`)
  assert.ok(metro.stats().bytes >= messy.length - 777)
})

test('probe and scan agree with the JavaScript reference', () => {
  const { tagged } = sample({ ms: 2000 })
  const metro = probeMp3(tagged)
  const js = probeMp3Js(tagged)

  assert.equal(metro.frames, js.frames)
  assert.equal(metro.bitrate, js.bitrate, 'bitrate is kbps on both engines')
  assert.equal(metro.sampleRate, js.sampleRate)
  assert.ok(Math.abs(metro.durationMs - js.durationMs) < 1)

  const table = scanFrames(tagged)
  assert.equal(table.length, metro.frames)
  assert.equal(table[0].layer, 3)
  assert.equal(table[0].version, 1)
  assert.equal(table[1].offset - table[0].offset, table[0].length, 'frames tile the buffer')
})

test('block mode returns the same bytes as frame mode, in far fewer pieces', () => {
  const { audio } = sample({ ms: 2500 })

  const blocks = []
  const framer = new MetroFramer()
  for (let at = 0; at < audio.length; at += 8192) {
    blocks.push(...framer.pushBlocks(audio.subarray(at, at + 8192), { maxBlockMs: 240 }).blocks)
  }

  const frames = feed(new Mp3FrameSplitter(), audio, 8192)
  assert.deepEqual(Buffer.concat(blocks.map((b) => b.data)), Buffer.concat(frames))
  assert.ok(blocks.length < frames.length / 4, `${frames.length} frames became ${blocks.length} blocks`)
  assert.ok(blocks.every((b) => b.ms <= 300), 'blocks stay short so the pacer stays smooth')

  const total = blocks.reduce((ms, b) => ms + b.ms, 0)
  assert.ok(Math.abs(total - 2500) < 120, `about the length we fed in (${Math.round(total)}ms)`)
})

test('decoding gives real samples back', async () => {
  // A 220 Hz tone, encoded, then decoded again: the round trip must survive.
  const sampleRate = 44100
  const length = sampleRate // one second
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    left[i] = right[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 0.5
  }

  const mp3 = await encodeMp3({ left, right, sampleRate, bitrate: 128 })
  const pcm = await decodeMp3(mp3)
  assert.ok(pcm, 'a decoder is available')
  assert.equal(pcm.sampleRate, sampleRate)
  assert.ok(pcm.length > sampleRate * 0.8, `most of the second came back (${pcm.length})`)

  // Energy in the middle of the clip, away from encoder padding.
  let peak = 0
  for (let i = 10_000; i < 30_000; i += 1) peak = Math.max(peak, Math.abs(pcm.left[i]))
  assert.ok(peak > 0.2, `the tone survived the round trip (peak ${peak.toFixed(3)})`)
})

test('a plugin-style live relay goes straight to air', async (t) => {
  const dir = tmpdir('relay-')
  makeMedia(dir, { count: 1, ms: 2000 })
  const sources = new SourceRegistry({ mediaDir: dir, hiRes: false, liveFallback: false })
  const station = new Station({ id: 'relay-fm', name: 'Relay FM', playlists: [`local:${dir}`], autoStart: false, automix: { enabled: false } }, { sources })
  t.after(() => station.destroy())

  await station.start()

  // A "live source": MP3 bytes arriving a chunk at a time, as from a socket.
  const audio = Buffer.concat(buildSilence(2000).frames)
  const feedStream = Readable.from(
    (async function* () {
      for (let at = 0; at < audio.length; at += 2048) {
        yield audio.subarray(at, at + 2048)
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
    })()
  )

  const listener = station.subscribe({ label: 'relay-test' })
  const received = []
  listener.on('data', (chunk) => received.push(chunk))

  const handle = station.relay(feedStream, { title: 'Guest DJ set', artist: 'Plugin' })
  assert.equal(station.relaying, true)
  assert.equal(station.info().relaying, true)

  // The feed drains in milliseconds; the station still airs it in real time.
  const stats = await handle.done
  assert.equal(station.relaying, false, 'the station is handed back when the feed ends')
  assert.ok(stats.frames > 60, `the whole relay was framed (${stats.frames})`)
  assert.equal(stats.engine, engineInfo().native ? 'native' : 'javascript')
  assert.ok(Math.abs(stats.durationMs - 2000) < 120, `two seconds of audio (${Math.round(stats.durationMs)}ms)`)

  // The pacer airs in real time, so wait for the relay to reach the
  // listener rather than assuming it already has.
  await waitFor(() => probeMp3(Buffer.concat(received)).frames > 12, { label: 'relay audio on air', timeout: 8000 })
  await waitFor(() => station.nowPlaying()?.track?.title === 'Guest DJ set', { label: 'relay on air', timeout: 8000 })
  assert.equal(probeMp3(Buffer.concat(received)).bitrate, 128)
  listener.destroy()
})
