#!/usr/bin/env node
/**
 * MetroS benchmark: native libmetro vs the JavaScript fallback.
 *
 *     npm run bench:metro            # generated tone, 60 s
 *     npm run bench:metro -- file.mp3
 *
 * Both engines run in the same process on the same bytes, and the output is
 * compared byte for byte before anything is timed — a faster answer that is
 * not the same answer is not worth having.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Mp3FrameSplitter, probeMp3 as probeJs } from '../src/util/mp3.js'
import { MetroFramer, probeMp3, decodeMp3, transcodeToMp3, encodeMp3, engineInfo } from '../src/util/metro.js'
import { encodeMp3 as encodeForMaterial } from '../src/core/automix.js'
import { configureLogging } from '../src/util/logger.js'

configureLogging({ level: 'error', color: false, file: { enabled: false } })

const here = path.dirname(fileURLToPath(import.meta.url))

async function material() {
  const given = process.argv[2]
  if (given) return { name: path.basename(given), audio: fs.readFileSync(given) }

  const demo = path.join(here, '..', '..', 'samples', 'automix-dj-demo.mp3')
  if (fs.existsSync(demo)) return { name: 'samples/automix-dj-demo.mp3', audio: fs.readFileSync(demo) }

  // Nothing to hand? Make 30 seconds of music-ish audio so the numbers are
  // still about real frames rather than silence.
  const sampleRate = 44100
  const length = sampleRate * 30
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate
    const v = Math.sin(2 * Math.PI * 220 * t) * 0.3 + Math.sin(2 * Math.PI * 330 * t) * 0.2 + (Math.random() - 0.5) * 0.02
    left[i] = v
    right[i] = v * 0.9
  }
  return { name: 'generated tone (30 s)', audio: await encodeForMaterial({ left, right, sampleRate, bitrate: 128 }) }
}

function time(fn, runs) {
  fn()
  const started = process.hrtime.bigint()
  for (let i = 0; i < runs; i += 1) fn()
  return Number(process.hrtime.bigint() - started) / 1e6 / runs
}

function row(label, js, metro) {
  const gain = js / metro
  console.log(
    `  ${label.padEnd(28)} ${js.toFixed(2).padStart(8)} ms ${metro.toFixed(2).padStart(9)} ms   ${gain >= 1 ? `${gain.toFixed(2)}x faster` : `${(1 / gain).toFixed(2)}x slower`}`
  )
}

const { name, audio } = await material()
const info = engineInfo()
const probe = probeMp3(audio)

console.log(`\nMetroS benchmark — ${info.describe}`)
if (!info.native) console.log('  (no native binary loaded: build libmetro first, or this only measures JavaScript)')
console.log(`\n  material  ${name}`)
console.log(`  audio     ${(probe.durationMs / 1000).toFixed(1)} s · ${probe.frames} frames · ${probe.bitrate} kbps · ${probe.sampleRate} Hz`)
console.log(`\n  ${''.padEnd(28)} ${'javascript'.padStart(11)} ${'MetroS'.padStart(12)}\n`)

function collectJs(chunks) {
  const splitter = new Mp3FrameSplitter()
  const out = []
  for (const chunk of chunks) out.push(...splitter.push(chunk).frames)
  return out
}

function collectMetro(chunks) {
  const framer = new MetroFramer()
  const out = []
  for (const chunk of chunks) for (const block of framer.pushBlocks(chunk).blocks) out.push(block.data)
  return out
}

/* ---- re-framing, the hot loop of every relay ---------------------------- */

for (const size of [1400, 8192, 65_536]) {
  const chunks = []
  for (let at = 0; at < audio.length; at += size) chunks.push(audio.subarray(at, at + size))

  const a = Buffer.concat(collectJs(chunks))
  const b = Buffer.concat(collectMetro(chunks))
  if (!a.equals(b)) throw new Error(`engines disagree at ${size}B chunks`)

  // Straight re-framing: same work, same result, both engines.
  const jsFrames = () => {
    const splitter = new Mp3FrameSplitter()
    let frames = 0
    for (const chunk of chunks) frames += splitter.push(chunk).frames.length
    return frames
  }
  const metroFrames = () => {
    const framer = new MetroFramer()
    let frames = 0
    for (const chunk of chunks) frames += framer.push(chunk).frames.length
    return frames
  }
  row(`re-frame, ${String(size).padStart(5)}B chunks`, time(jsFrames, 50), time(metroFrames, 50))

  // What a relay really costs: every frame the old path produced became an
  // object on the pacer's queue. MetroS hands the pacer a few contiguous
  // blocks instead, which is where the relay path actually gets cheaper.
  const jsAir = () => {
    const splitter = new Mp3FrameSplitter()
    const air = []
    for (const chunk of chunks) {
      const parsed = splitter.push(chunk)
      const ms = parsed.info?.durationMs ?? 26
      for (const data of parsed.frames) air.push({ data, ms, track: null })
    }
    return air.length
  }
  const metroAir = () => {
    // Exactly what `station.relay()` does, coalescing included.
    const framer = new MetroFramer({ coalesce: 8192 })
    const air = []
    for (const chunk of chunks) {
      for (const block of framer.pushBlocks(chunk).blocks) air.push({ data: block.data, ms: block.ms, track: null })
    }
    for (const block of framer.flush().blocks) air.push({ data: block.data, ms: block.ms, track: null })
    return air.length
  }
  row(`  …and on to air`, time(jsAir, 50), time(metroAir, 50))
}

/* ---- measuring a file --------------------------------------------------- */

row('probe whole file', time(() => probeJs(audio), 50), time(() => probeMp3(audio), 50))

/* ---- transcoding, the relay path ---------------------------------------- */

const fixtures = path.join(here, '..', 'test', 'fixtures')
for (const [name, label] of [
  ['tone.aac', 'transcode aac → mp3'],
  ['segment.ts', 'transcode hls/ts → mp3']
]) {
  const file = path.join(fixtures, name)
  if (!fs.existsSync(file)) continue
  const bytes = fs.readFileSync(file)
  try {
    const out = await transcodeToMp3(bytes, { bitrate: 128 })
    const seconds = probeMp3(out).durationMs / 1000
    const started = process.hrtime.bigint()
    for (let i = 0; i < 5; i += 1) await transcodeToMp3(bytes, { bitrate: 128 })
    const ms = Number(process.hrtime.bigint() - started) / 1e6 / 5
    console.log(`  ${label.padEnd(28)} ${''.padStart(11)} ${ms.toFixed(2).padStart(9)} ms   ${(seconds * 1000 / ms).toFixed(0)}x realtime`)
  } catch (error) {
    console.log(`  ${label.padEnd(28)} ${error.message}`)
  }
}

/* ---- decoding, the automix seam ----------------------------------------- */

const seam = audio.subarray(0, Math.min(audio.length, 400_000))
let wasm = null
try {
  const { MPEGDecoder } = await import('mpg123-decoder')
  const decoder = new MPEGDecoder()
  await decoder.ready
  decoder.decode(new Uint8Array(seam))
  const started = process.hrtime.bigint()
  for (let i = 0; i < 5; i += 1) decoder.decode(new Uint8Array(seam))
  wasm = Number(process.hrtime.bigint() - started) / 1e6 / 5
  decoder.free()
} catch {
  console.log('\n  (mpg123-decoder is not installed; skipping the decode comparison)')
}

if (wasm !== null) {
  await decodeMp3(seam)
  const started = process.hrtime.bigint()
  for (let i = 0; i < 5; i += 1) await decodeMp3(seam)
  const metro = Number(process.hrtime.bigint() - started) / 1e6 / 5
  row(`decode ${(seam.length / 1024).toFixed(0)} KB to PCM`, wasm, metro)
}

/* ---- encoding, the automix output --------------------------------------- */

{
  const sampleRate = 44100
  const left = new Float32Array(sampleRate * 5)
  const right = new Float32Array(sampleRate * 5)
  for (let i = 0; i < left.length; i += 1) left[i] = right[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.4

  await encodeMp3({ left, right, sampleRate, bitrate: 128 })
  const started = process.hrtime.bigint()
  for (let i = 0; i < 3; i += 1) await encodeMp3({ left, right, sampleRate, bitrate: 128 })
  const ms = Number(process.hrtime.bigint() - started) / 1e6 / 3
  console.log(`  ${'encode 5 s of stereo'.padEnd(28)} ${''.padStart(11)} ${ms.toFixed(2).padStart(9)} ms   ${(5000 / ms).toFixed(0)}x realtime`)
}

console.log('')
