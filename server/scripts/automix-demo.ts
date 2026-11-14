/**
 * Render one seam per transition effect into a single MP3, so the automix can
 * be listened to rather than read about.
 *
 *   bun scripts/automix-demo.js [outfile]
 *
 * Two synthetic "songs" are used because they are deterministic and because
 * they make the analysis audible: A is 124 BPM and loud, B is 128 BPM, 10 dB
 * quieter and starts with 1.2 s of digital silence (a badly trimmed file).
 * The automix has to loudness-match them, cue past the silence and land B on
 * A's beat grid, for every effect in turn.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Automix, encodeMp3 } from '../src/core/automix.ts'
import { Mp3FrameSplitter } from '../src/util/mp3.ts'
import { integratedLoudness } from '../src/core/dsp.ts'

const RATE = 44100
const here = path.dirname(fileURLToPath(import.meta.url))
const out = process.argv[2] ?? path.join(here, '..', '..', 'samples', 'automix-effects-demo.mp3')

/** A loop with a kick, a hat, a bassline and a chord — enough to have a beat. */
function song({ bpm, ms, root, gain = 0.5, leadInMs = 0, chord = [1, 1.25, 1.5] }) {
  const beat = (60 / bpm) * RATE
  const lead = Math.round((leadInMs / 1000) * RATE)
  const n = lead + Math.round((ms / 1000) * RATE)
  const left = new Float32Array(n)
  const right = new Float32Array(n)

  for (let i = lead; i < n; i += 1) {
    const t = (i - lead) / RATE
    const position = (i - lead) / beat
    const inBeat = position % 1
    const beatIndex = Math.floor(position)
    const bar = Math.floor(beatIndex / 4)

    // Kick: a fast downward pitch sweep on every beat.
    const kickEnv = Math.exp(-inBeat * 18)
    const kick = Math.sin(2 * Math.PI * (48 + 70 * Math.exp(-inBeat * 30)) * (inBeat * (60 / bpm))) * kickEnv

    // Hat: filtered-ish noise burst on the off-beat.
    const offset = (position + 0.5) % 1
    const hat = (Math.sin(i * 12.9898) * 43758.5453 % 1) * Math.exp(-offset * 90) * 0.35

    // Bass: root / fifth, one note per beat.
    const note = [1, 1, 1.5, 1][beatIndex % 4]
    const bass = Math.sin(2 * Math.PI * root * note * t) * 0.6 * (0.6 + 0.4 * Math.exp(-inBeat * 3))

    // Chord: a held pad, one inversion per bar.
    let pad = 0
    for (const ratio of chord) pad += Math.sin(2 * Math.PI * root * 4 * ratio * (bar % 2 ? 1.0 : 1.122) * t) / chord.length

    const v = (kick * 0.9 + hat * 0.25 + bass * 0.5 + pad * 0.22) * gain
    left[i] = Math.max(-1, Math.min(1, v))
    right[i] = Math.max(-1, Math.min(1, v * 0.97))
  }
  return { left, right }
}

const framesOf = (buffer, track) => {
  const parsed = new Mp3FrameSplitter().push(buffer)
  const ms = parsed.durationMs / parsed.frames.length
  return parsed.frames.map((data) => ({ data, ms, track }))
}

const trackA = { id: 'a', title: 'Blue Hour', artist: 'Tone Test', streamBitrate: 160 }
const trackB = { id: 'b', title: 'Second Sun', artist: 'Tone Test', streamBitrate: 160 }

const pcmA = song({ bpm: 124, ms: 14_000, root: 55, gain: 0.55 })
const pcmB = song({ bpm: 128, ms: 12_000, root: 73.42, gain: 0.17, leadInMs: 1200, chord: [1, 1.2, 1.5] })
console.log(`A: 124 BPM, ${integratedLoudness([pcmA.left, pcmA.right], RATE).toFixed(1)} LUFS`)
console.log(`B: 128 BPM, ${integratedLoudness([pcmB.left, pcmB.right], RATE).toFixed(1)} LUFS, 1.2 s of silence at the head`)

const mp3A = await encodeMp3({ ...pcmA, sampleRate: RATE, bitrate: 160 })
const mp3B = await encodeMp3({ ...pcmB, sampleRate: RATE, bitrate: 160 })

const effects = ['crossfade', 'bass-swap', 'filter', 'echo', 'sweep', 'spindown', 'slam']
const pieces = []
let at = 0

for (const effect of effects) {
  const automix = new Automix(
    { effect, crossfadeMs: 6000, minTrackMs: 4000, dj: { enabled: false } },
    { station: { name: 'Demo FM', emit() {} } }
  )
  const frames = []
  for (const frame of framesOf(mp3A, trackA)) frames.push(...(await automix.push([frame])))
  for (const frame of framesOf(mp3B, trackB)) frames.push(...(await automix.push([frame])))
  frames.push(...(await automix.flush()))

  // Keep the last 6 s of A and the first 6 s of B around the seam.
  const total = frames.reduce((sum, f) => sum + f.ms, 0)
  const seamStart = frames.reduce((acc, f) => (f.track.automix && acc === null ? acc : acc), null)
  let elapsed = 0
  let seamAt = total
  for (const frame of frames) {
    if (frame.track.automix) {
      seamAt = elapsed
      break
    }
    elapsed += frame.ms
  }
  const from = Math.max(0, seamAt - 5000)
  const to = seamAt + 9000
  elapsed = 0
  const clip = []
  for (const frame of frames) {
    if (elapsed >= from && elapsed <= to) clip.push(frame.data)
    elapsed += frame.ms
  }
  const bytes = Buffer.concat(clip)
  pieces.push(bytes)

  const last = automix.info().last
  const seconds = (bytes.length / ((160 * 1000) / 8)).toFixed(0)
  console.log(
    `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}  ${effect.padEnd(10)}` +
      ` blend ${String(last.blendMs).padStart(5)}ms  ${last.curve.padEnd(12)}` +
      ` match ${last.loudness.appliedDb > 0 ? '+' : ''}${last.loudness.appliedDb} dB  trimmed ${last.cues.trimmedHeadMs}ms` +
      `  beat ${last.beat.bpm ? `${last.beat.bpm.toFixed(0)}→${last.beat.incomingBpm.toFixed(0)} BPM shift ${last.beat.shiftMs}ms` : 'n/a'}` +
      `  peak ${last.peakDb} dBFS`
  )
  void seamStart
  at += Number(seconds)
}

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, Buffer.concat(pieces))
console.log(`\nwrote ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`)
