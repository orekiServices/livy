/**
 * Render one deterministic synthetic crossfade to MP3.
 *
 *   bun scripts/automix-demo.ts [outfile.mp3]
 *
 * The two synthetic tracks exercise the same outgoing-tail-to-incoming-head
 * CLI path as real files. A is 124 BPM; B is 128 BPM, quieter, and begins with
 * digital silence so cue detection has something to trim.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { encodeMp3 } from '../src/core/automix/index.ts'
import { renderAutomixMp3 } from '../src/core/automix/cli.ts'

const RATE = 44100
const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.resolve(process.argv[2] ?? path.join(here, '..', '..', 'samples', 'automix-crossfade-demo.mp3'))

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
    const kickEnv = Math.exp(-inBeat * 18)
    const kick = Math.sin(2 * Math.PI * (48 + 70 * Math.exp(-inBeat * 30)) * (inBeat * (60 / bpm))) * kickEnv
    const offset = (position + 0.5) % 1
    const hat = (Math.sin(i * 12.9898) * 43758.5453 % 1) * Math.exp(-offset * 90) * 0.35
    const note = [1, 1, 1.5, 1][beatIndex % 4]
    const bass = Math.sin(2 * Math.PI * root * note * t) * 0.6 * (0.6 + 0.4 * Math.exp(-inBeat * 3))
    let pad = 0
    for (const ratio of chord) pad += Math.sin(2 * Math.PI * root * 4 * ratio * (bar % 2 ? 1.0 : 1.122) * t) / chord.length
    const value = (kick * 0.9 + hat * 0.25 + bass * 0.5 + pad * 0.22) * gain
    left[i] = Math.max(-1, Math.min(1, value))
    right[i] = Math.max(-1, Math.min(1, value * 0.97))
  }
  return { left, right }
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'livy-automix-demo-'))
try {
  const outgoing = path.join(temp, 'blue-hour.mp3')
  const incoming = path.join(temp, 'second-sun.mp3')
  const pcmA = song({ bpm: 124, ms: 14_000, root: 55, gain: 0.55 })
  const pcmB = song({ bpm: 128, ms: 12_000, root: 73.42, gain: 0.17, leadInMs: 1200, chord: [1, 1.2, 1.5] })
  fs.writeFileSync(outgoing, await encodeMp3({ ...pcmA, sampleRate: RATE, bitrate: 160 }))
  fs.writeFileSync(incoming, await encodeMp3({ ...pcmB, sampleRate: RATE, bitrate: 160 }))

  const result = await renderAutomixMp3({
    outgoing,
    incoming,
    output: out,
    outgoingTitle: 'Blue Hour',
    incomingTitle: 'Second Sun',
    crossfadeMs: 4000,
    preRollMs: 2000,
    smart: false,
    beatmatch: false,
    bitrate: 160
  })
  console.log(`rendered crossfade: ${result.report.from} → ${result.report.to}`)
  console.log(`wrote ${result.output} (${(result.durationMs / 1000).toFixed(2)} s, ${(result.bytes / 1024).toFixed(0)} KiB)`)
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
