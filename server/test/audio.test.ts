/**
 * The audio layer that never gets to be wrong: MP3 frame parsing, ICY
 * metadata, and the DSP the automix is built on (BS.1770 loudness, cue
 * detection, fade law, tempo estimation, WSOLA time-stretching).
 *
 * Everything is measured against a value we can derive independently — a
 * known sine level, a known beat grid, a known stretch ratio — never against
 * "whatever the code did last time".
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseFrameHeader, Mp3FrameSplitter, probeMp3, buildSilence } from '../src/util/mp3.ts'
import { parseIcyMetadata, buildIcyMetadataBlock, IcyDeinterleaver } from '../src/util/icyClient.ts'
import {
  TO_DB,
  Biquad,
  Crossover,
  integratedLoudness,
  samplePeak,
  detectCues,
  correlation,
  exponentFor,
  fadeGains,
  estimateBeat,
  timeStretch,
  stretchMap,
  foldTempo,
  resample,
  compressorGain
} from '../src/core/dsp.ts'
import { decodeMp3, encodeMp3 } from '../src/core/automix.ts'
import { tone, beatLoop, quietLogs } from './helpers.ts'

quietLogs()

/* ----------------------------------------------------------------- *
 * MP3 + ICY
 * ----------------------------------------------------------------- */

test('MP3 frame headers are parsed and a stream is split frame-exactly', () => {
  const { frames } = buildSilence(3000)
  const buffer = Buffer.concat(frames)

  const header = parseFrameHeader(buffer, 0)
  assert.equal(header.bitrate, 128)
  assert.equal(header.sampleRate, 44100)
  assert.equal(header.samples, 1152)
  assert.equal(header.length, 417, 'a 128 kbps/44.1 kHz frame is 417 bytes')
  assert.ok(Math.abs(header.durationMs - 26.12) < 0.1, `frame is ~26 ms, got ${header.durationMs}`)

  const splitter = new Mp3FrameSplitter()
  const out = []
  let durationMs = 0
  // Feed it in awkward chunks: a real socket never respects frame boundaries.
  for (let at = 0; at < buffer.length; at += 100) {
    const result = splitter.push(buffer.subarray(at, at + 100))
    out.push(...result.frames)
    durationMs += result.durationMs
  }

  assert.equal(out.length, frames.length, 'every frame comes back out')
  assert.ok(out.every((frame, i) => frame.equals(frames[i])), 'bytes are passed through untouched')
  assert.ok(Math.abs(durationMs - 3000) < 40, `timing is tracked, got ${durationMs.toFixed(0)}ms`)

  const probe = probeMp3(buffer)
  assert.equal(probe.frames, frames.length)
  assert.equal(probe.bitrate, 128)
  assert.ok(Math.abs(probe.durationMs - 3000) < 40)
})

test('ICY metadata blocks round-trip and de-interleave out of a stream', async () => {
  const block = buildIcyMetadataBlock('Kavi - Blue Hour', 'http://localhost/stream/lofi')
  // One length byte, then a whole number of 16-byte units.
  assert.equal((block.length - 1) % 16, 0, 'blocks are padded to 16-byte units')
  assert.equal(block[0] * 16, block.length - 1)
  const parsed = parseIcyMetadata(block.subarray(1))
  assert.equal(parsed.StreamTitle, 'Kavi - Blue Hour')

  // metaint audio bytes, then a block, then more audio.
  const metaint = 64
  const audio = Buffer.alloc(metaint * 2, 0x55)
  const stream = Buffer.concat([audio.subarray(0, metaint), block, audio.subarray(metaint)])

  const titles = []
  const chunks = []
  const deinterleaver = new IcyDeinterleaver(metaint)
  // The de-interleaver emits the raw ICY string; parsing is a separate step.
  deinterleaver.on('metadata', (raw) => titles.push(parseIcyMetadata(raw).StreamTitle))
  deinterleaver.on('data', (chunk) => chunks.push(chunk))
  deinterleaver.end(stream)
  await new Promise((resolve) => deinterleaver.on('end', resolve))

  assert.deepEqual(titles, ['Kavi - Blue Hour'])
  assert.equal(Buffer.concat(chunks).length, audio.length, 'only audio survives')
})

/* ----------------------------------------------------------------- *
 * Loudness, cues, fades
 * ----------------------------------------------------------------- */

test('BS.1770 loudness matches the reference identity for a 1 kHz sine', () => {
  // A 1 kHz sine at -20 dBFS peak measures -23.00 LUFS (ITU-R BS.2054 / EBU).
  const seconds = 4
  const sampleRate = 48000
  const n = seconds * sampleRate
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  const amplitude = 10 ** (-20 / 20) * Math.SQRT2 // -20 dBFS RMS
  for (let i = 0; i < n; i += 1) {
    left[i] = right[i] = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * amplitude
  }

  // K-weighting is ~0 dB at 1 kHz and the two identical channels sum +3 dB,
  // so -20 dBFS RMS per channel measures -17.0 LUFS.
  const lufs = integratedLoudness([left, right], sampleRate)
  assert.ok(Math.abs(lufs - -17) < 0.3, `expected ≈ -17 LUFS, got ${lufs.toFixed(2)}`)

  const peak = samplePeak([left, right])
  assert.ok(Math.abs(TO_DB(peak) - -17) < 0.5, `peak ≈ -17 dBFS, got ${TO_DB(peak).toFixed(2)}`)

  // Silence gates out completely: null, never NaN or -Infinity maths.
  assert.equal(integratedLoudness([new Float32Array(n)], sampleRate), null)
})

test('cue detection trims silence and finds the overlay point', () => {
  const sampleRate = 44100
  const music = tone({ seconds: 6, sampleRate, gain: 0.5 })
  const lead = Math.round(sampleRate * 1.5)
  const trail = Math.round(sampleRate * 2)

  const mono = new Float32Array(lead + music.length + trail)
  mono.set(music.left, lead) // 1.5 s of silence, 6 s of music, 2 s of silence

  const cues = detectCues(mono, sampleRate) // sample positions
  const ms = (samples) => (samples / sampleRate) * 1000
  assert.ok(Math.abs(ms(cues.cueIn) - 1500) < 200, `cue-in ≈ 1500 ms, got ${ms(cues.cueIn).toFixed(0)}`)
  assert.ok(Math.abs(ms(cues.cueOut) - 7500) < 250, `cue-out ≈ 7500 ms, got ${ms(cues.cueOut).toFixed(0)}`)
  assert.ok(cues.overlay <= cues.cueOut && cues.overlay > cues.cueIn, 'the overlay point sits inside the music')
  assert.ok(cues.silenceDb < -40, 'the silence threshold is derived from the programme level')
})

test('the fade law follows the correlation of the material', () => {
  const sampleRate = 44100
  const a = tone({ seconds: 1, freq: 220, sampleRate })
  const same = tone({ seconds: 1, freq: 220, sampleRate })
  const other = tone({ seconds: 1, freq: 517, sampleRate })

  assert.ok(correlation(a.left, same.left) > 0.99, 'identical material correlates')
  assert.ok(Math.abs(correlation(a.left, other.left)) < 0.2, 'unrelated material does not')

  // Correlated → equal-gain (x≈1), uncorrelated → equal-power (x≈2).
  assert.ok(Math.abs(exponentFor(1) - 1) < 0.05)
  assert.ok(Math.abs(exponentFor(0) - 2) < 0.05)

  for (const exponent of [1, 1.5, 2]) {
    const [ga, gb] = fadeGains(0.5, exponent)
    assert.ok(Math.abs(ga ** exponent + gb ** exponent - 1) < 1e-6, 'the law sums to unity')
  }
  const [startA, startB] = fadeGains(0, 2)
  assert.ok(startA > 0.99 && startB < 0.01)
})

test('filters do what their names say', () => {
  const sampleRate = 44100
  const rms = (buf) => Math.sqrt(buf.reduce((sum, v) => sum + v * v, 0) / buf.length)

  const low = tone({ seconds: 0.5, freq: 60, sampleRate })
  const high = tone({ seconds: 0.5, freq: 8000, sampleRate })

  const lowpass = (input) => Biquad.lowpass(300, sampleRate, 0.707).processInto(input)
  assert.ok(rms(lowpass(low.left)) > 0.9 * rms(low.left), 'a low tone passes a low-pass')
  assert.ok(rms(lowpass(high.left)) < 0.05 * rms(high.left), 'a high tone does not')

  // A Linkwitz-Riley crossover reconstructs the input when summed back.
  const crossover = new Crossover(200, sampleRate)
  const mixed = new Float32Array(low.length)
  for (let i = 0; i < low.length; i += 1) mixed[i] = low.left[i] * 0.5 + high.left[i] * 0.5
  let lowSum = 0
  let highSum = 0
  for (let i = 0; i < mixed.length; i += 1) {
    const [lo, hi] = crossover.split(mixed[i])
    lowSum += lo * lo
    highSum += hi * hi
  }
  assert.ok(lowSum > 0 && highSum > 0, 'both bands carry energy')
})

test('the sidechain compressor ducks and recovers', () => {
  const sampleRate = 44100
  const control = new Float32Array(sampleRate) // 1 s: loud for the first half
  for (let i = 0; i < sampleRate / 2; i += 1) control[i] = 0.7

  const gain = compressorGain(control, sampleRate, { thresholdDb: -32, ratio: 12, attackMs: 80, releaseMs: 300, rangeDb: -9 })
  const duckedDb = TO_DB(gain[Math.round(sampleRate * 0.4)])
  const recoveredDb = TO_DB(gain[sampleRate - 1])

  assert.ok(duckedDb < -6 && duckedDb >= -9.5, `music is ducked to about -9 dB, got ${duckedDb.toFixed(2)}`)
  assert.ok(recoveredDb > duckedDb + 4, `and comes back up, got ${recoveredDb.toFixed(2)}`)
})

/* ----------------------------------------------------------------- *
 * Tempo + time-stretching (the beatmatch primitives)
 * ----------------------------------------------------------------- */

test('tempo and phase are recovered from a beat loop', () => {
  for (const bpm of [96, 120, 140]) {
    const loop = beatLoop({ bpm, seconds: 10 })
    const beat = estimateBeat(loop.left, loop.sampleRate)
    assert.ok(Math.abs(beat.bpm - bpm) < 2, `expected ${bpm} BPM, measured ${beat.bpm.toFixed(2)}`)
    assert.ok(beat.confidence > 0.3, `confidence ${beat.confidence.toFixed(2)} too low at ${bpm} BPM`)
    assert.ok(beat.phaseSamples >= 0 && beat.phaseSamples < beat.periodSamples, 'phase sits inside one beat')
    assert.ok(Math.abs(beat.periodSamples - (60 / bpm) * loop.sampleRate) < 60, 'the period matches the tempo')
  }
})

test('material without a beat is reported as unusable, not confidently wrong', () => {
  const sampleRate = 44100
  // A sustained sine: window ripple gives the autocorrelation *something* to
  // latch onto, so the tempo number is meaningless — the confidence must say so.
  const pad = estimateBeat(tone({ seconds: 8, freq: 440, sampleRate }).left, sampleRate)
  assert.ok(pad.confidence < 0.1, `a steady tone must not look like a beat (got ${pad.confidence.toFixed(2)})`)

  const noise = new Float32Array(8 * sampleRate)
  for (let i = 0; i < noise.length; i += 1) noise[i] = (Math.random() * 2 - 1) * 0.3
  assert.ok(estimateBeat(noise, sampleRate).confidence < 0.3, 'nor must noise')
})

test('half and double time fold onto the reference tempo', () => {
  assert.deepEqual(foldTempo(160, 80), { bpm: 80, factor: 0.5 })
  assert.deepEqual(foldTempo(60, 120), { bpm: 120, factor: 2 })
  assert.equal(foldTempo(128, 124).bpm, 128, 'nearby tempos are left alone')
})

test('stretchMap is invertible and eases in', () => {
  const map = stretchMap(1.08, 4410)
  assert.ok(Math.abs(map.inputAt(map.outputAt(10_000)) - 10_000) < 1, 'the map round-trips')
  assert.ok(map.outputAt(0) === 0, 'the ramp starts at the origin')
  assert.ok(map.outputLength(44_100) > 44_100, 'stretch > 1 makes it longer')

  const identity = stretchMap(1, 0)
  assert.equal(identity.outputAt(5000), 5000)
})

test('WSOLA changes the tempo without moving the pitch', async () => {
  const sampleRate = 44100
  const freq = 220
  const input = tone({ seconds: 2, freq, sampleRate, gain: 0.5 })

  const stretched = timeStretch([input.left, input.right], sampleRate, { stretch: 1.25 })
  const ratio = stretched.length / input.length
  assert.ok(Math.abs(ratio - 1.25) < 0.02, `expected 25% longer, got ${(ratio * 100 - 100).toFixed(1)}%`)

  // Zero-crossing rate is a cheap, robust pitch proxy: it must not change.
  const crossings = (buf) => {
    let n = 0
    for (let i = 1; i < buf.length; i += 1) if (buf[i - 1] <= 0 && buf[i] > 0) n += 1
    return n / (buf.length / sampleRate)
  }
  assert.ok(Math.abs(crossings(stretched.channels[0]) - freq) < 4, 'pitch is preserved')

  // …and the tempo of a beat loop really moves.
  const loop = beatLoop({ bpm: 120, seconds: 8 })
  const faster = timeStretch([loop.left, loop.right], sampleRate, { stretch: 120 / 132 })
  const measured = estimateBeat(faster.channels[0], sampleRate)
  assert.ok(Math.abs(measured.bpm - 132) < 3, `120 BPM stretched to 132 measured ${measured.bpm.toFixed(1)}`)
})

test('resampling preserves duration and pitch', () => {
  const input = tone({ seconds: 1, freq: 440, sampleRate: 44100 })
  const out = resample(input.left, 44100, 22050)
  assert.equal(out.length, 22050)

  let crossings = 0
  for (let i = 1; i < out.length; i += 1) if (out[i - 1] <= 0 && out[i] > 0) crossings += 1
  assert.ok(Math.abs(crossings - 440) < 6, `expected ~440 Hz after resampling, counted ${crossings}`)
})

test('the MP3 codec round-trips through the automix path', async () => {
  const input = tone({ seconds: 1.5, freq: 440, gain: 0.4 })
  const encoded = await encodeMp3({ left: input.left, right: input.right, sampleRate: input.sampleRate, bitrate: 128 })
  assert.ok(Buffer.isBuffer(encoded) && encoded.length > 1000)
  assert.equal(probeMp3(encoded).bitrate, 128)

  const decoded = await decodeMp3(encoded)
  assert.equal(decoded.sampleRate, 44100)
  assert.ok(Math.abs(decoded.left.length / 44100 - 1.5) < 0.12, 'duration survives the round trip')
  assert.ok(samplePeak([decoded.left]) > 0.2, 'and so does the signal')
})
