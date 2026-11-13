/**
 * Splicing — the three things that make an MP3 seam click, and the proof that
 * none of them is left: codec delay, the MDCT overlap, and the bit reservoir.
 *
 * Everything is checked the way a listener's player would hear it: the
 * spliced frames are decoded as one stream and compared, sample for sample,
 * with the audio that was supposed to be there.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { codec, codecKey, decodeFrames } from '../src/util/codec.js'
import { LEAD_FRAMES, bridge, codecDelay, parseLayer3, remux, reservoirBefore, toLogical } from '../src/util/splice.ts'
import { quietLogs } from './helpers.js'

quietLogs()

const SR = 44_100
const SPF = 1152
const here = path.dirname(fileURLToPath(import.meta.url))

/** Chords, a bright tone and a noise burst on every beat: hard to encode. */
function music(seconds = 8) {
  const n = SR * seconds
  const x = new Float32Array(n)
  let seed = 7
  for (let i = 0; i < n; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const t = i / SR
    const beat = (t * 2) % 1
    x[i] =
      0.25 * Math.sin(2 * Math.PI * 220 * t) +
      0.2 * Math.sin(2 * Math.PI * 277 * t) +
      0.15 * Math.sin(2 * Math.PI * 3300 * t) * (beat < 0.5 ? 1 : 0.2) +
      (seed / 2 ** 32 - 0.5) * 0.5 * Math.exp(-beat * 12)
  }
  return x
}

/** A stream whose frames really do keep their audio in earlier frames. */
async function reservoirStream() {
  const x = music()
  const plain = codec.frames(await codec.encode({ left: x, right: x, sampleRate: SR, bitrate: 128 }))
  // Re-muxed into frames a size larger than the audio needs, every frame has
  // room left over and the next one starts in it — the layout LAME produces
  // for real music, with back pointers of up to 511 bytes.
  return remux(toLogical(plain), { preferredBitrate: 160 })
}

/** The first frame at or after `from` whose audio starts in an earlier frame. */
const reaching = (frames, from) => {
  for (let i = from; i < frames.length; i += 1) if (parseLayer3(frames[i]).mainDataBegin > 8) return i
  return from
}

/** Worst sample error over `span` samples of `got` against `want`. */
function worst(got, gotAt, want, wantAt, span) {
  let max = 0
  for (let i = 0; i < span; i += 1) max = Math.max(max, Math.abs(got[gotAt + i] - want[wantAt + i]))
  return max
}

test('side information is read where the standard puts it', async () => {
  const frames = await reservoirStream()
  const info = parseLayer3(frames[40])
  assert.equal(info.lsf, false)
  assert.equal(info.sideSize, 32, 'MPEG-1 stereo side info is 32 bytes')
  assert.equal(info.samples, SPF)
  assert.ok(info.mainBytes > 0 && info.mainBytes < 1441)

  // The 24 kHz voice ident is MPEG-2 (one granule, 8-bit back pointer).
  const ident = codec.frames(fs.readFileSync(path.join(here, '../media/tts/imusic-pro-welcome.mp3')))
  const low = parseLayer3(ident[20])
  assert.equal(low.lsf, true)
  assert.equal(low.samples, 576)
  assert.ok([9, 17].includes(low.sideSize))
  assert.ok(ident.some((frame) => parseLayer3(frame).mainDataBegin > 0), 'the fixture uses the reservoir')
})

test('re-muxing changes the bytes and not one sample', async () => {
  for (const frames of [await reservoirStream(), codec.frames(fs.readFileSync(path.join(here, '../media/tts/imusic-pro-welcome.mp3')))]) {
    const before = await decodeFrames(frames)
    const logical = toLogical(frames)
    assert.ok(logical.every((frame) => frame.complete), 'every frame found its audio')
    const after = await decodeFrames(remux(logical, { preferredBitrate: 64 }))
    assert.equal(after.length, before.length)
    assert.equal(worst(after.left, 0, before.left, 0, before.length), 0)
  }
})

test('a run of re-muxed frames depends on nothing before it', async () => {
  const frames = await reservoirStream()
  const reference = await decodeFrames(frames)
  const from = reaching(frames, 120)
  assert.ok(parseLayer3(frames[from]).mainDataBegin > 0, 'the cut lands on a frame that reaches back')

  // Cut as-is, the first frames are decoded from bytes that are not there.
  // (Two frames of slack for the MDCT overlap, which no cut can avoid.)
  const independent = remux(toLogical(frames).slice(from, from + 40))
  assert.equal(parseLayer3(independent[0]).mainDataBegin, 0)
  const pcm = await decodeFrames(independent)
  assert.ok(worst(pcm.left, 2 * SPF, reference.left, (from + 2) * SPF, 30 * SPF) < 1e-3)
})

test('the codec delay is measured, and it is the one the engine really has', async () => {
  const delay = await codecDelay(codec, SR, 128, codecKey())
  // 1105 for LAME → mpg123 (576 + 529); shine → symphonia is a little less.
  assert.ok(delay > 900 && delay < 1300, `delay ${delay}`)
})

test('a bridge joins two places in a stream without a gap, a repeat or a click', async () => {
  const frames = await reservoirStream()
  const reference = await decodeFrames(frames)
  const A = 100 // the bridge replaces frames from here…
  const B = reaching(frames, 141) - 1 // …and the stream resumes on frame B + 1
  const K = 4 // frames of rendered audio
  assert.ok(parseLayer3(frames[B + 1]).mainDataBegin > 0, 'the frame after the bridge needs a reservoir')

  // What should be heard: the audio before A, sliding into the audio that
  // ends exactly where frame B + 1 begins.
  const length = (LEAD_FRAMES + K) * SPF
  const sourceAt = (A - LEAD_FRAMES) * SPF
  const targetAt = (B + 1) * SPF - length
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const t = Math.max(0, Math.min(1, (i - (LEAD_FRAMES + 1) * SPF) / SPF))
    const ga = Math.cos((t * Math.PI) / 2)
    const gb = Math.sin((t * Math.PI) / 2)
    left[i] = reference.left[sourceAt + i] * ga + reference.left[targetAt + i] * gb
    right[i] = reference.right[sourceAt + i] * ga + reference.right[targetAt + i] * gb
  }
  const after = {
    left: reference.left.subarray((B + 1) * SPF, (B + 4) * SPF),
    right: reference.right.subarray((B + 1) * SPF, (B + 4) * SPF)
  }
  const rendered = await bridge(codec, { left, right, sampleRate: SR, bitrate: 128, after, tail: reservoirBefore(frames, B + 1) }, codecKey())
  assert.equal(rendered.length, K, 'one frame out per frame of audio after the lead')

  const joined = [...frames.slice(0, A), ...rendered, ...frames.slice(B + 1)]
  const hard = [...frames.slice(0, A), ...frames.slice(B + 1)]
  const heard = await decodeFrames(joined)
  const cut = await decodeFrames(hard)

  // After the bridge the stream is the original again, from its first frame:
  // the reservoir was handed over, so nothing is decoded from the wrong bytes.
  const span = 8 * SPF
  const bridged = worst(heard.left, (A + K) * SPF, reference.left, (B + 1) * SPF, span)
  const broken = worst(cut.left, A * SPF, reference.left, (B + 1) * SPF, span)
  assert.ok(bridged < 0.12, `bridged error ${bridged.toFixed(3)}`)
  assert.ok(broken > bridged * 3, `a plain cut is ${broken.toFixed(3)}, the bridge ${bridged.toFixed(3)}`)

  // And the bridge itself is the programme it was given, on time: no 25 ms
  // hole in front of it, which is what an uncompensated encode leaves.
  const inside = worst(heard.left, A * SPF, left, LEAD_FRAMES * SPF, K * SPF)
  assert.ok(inside < 0.15, `bridge content error ${inside.toFixed(3)}`)
  let energy = 0
  for (let i = 0; i < 256; i += 1) energy += heard.left[A * SPF + i] ** 2
  assert.ok(Math.sqrt(energy / 256) > 0.05, 'the first samples of the bridge are audio, not silence')
})
