/**
 * A filter change made while the station is on air.
 *
 * The DSP is the thing under test, so the signal is a plain 1 kHz tone and the
 * change is a high-pass that takes it away. A step is audible and measurable:
 * the largest jump between neighbouring samples at the join. A fade is not.
 */
import { describe, expect, test } from 'bun:test'

import { FilterChain, crossfade, processWithMorph } from '../src/core/filters/index.js'
import { unlinkSync } from 'node:fs'

const SR = 44_100
const BLOCK_MS = 200

function tone(seconds = 1, freq = 1000, gain = 0.5) {
  const n = Math.round(seconds * SR)
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  for (let i = 0; i < n; i += 1) {
    const v = Math.sin((2 * Math.PI * freq * i) / SR) * gain
    left[i] = v
    right[i] = v
  }
  return { left, right }
}

/** The biggest step between neighbouring samples: what a click is. */
function maxStep(left, from = 0, to = left.length) {
  let worst = 0
  for (let i = Math.max(1, from); i < Math.min(left.length, to); i += 1) {
    worst = Math.max(worst, Math.abs(left[i] - left[i - 1]))
  }
  return worst
}

const KILL = { highpass: { enabled: true, cutoff: 8000, resonance: 0.7, mix: 1 } }

describe('a filter change on air', () => {
  test('crossfade lands exactly on both ends', () => {
    const a = Float32Array.from([1, 1, 1, 1])
    const b = Float32Array.from([0, 0, 0, 0])
    const a2 = Float32Array.from([1, 1, 1, 1])
    const b2 = Float32Array.from([0, 0, 0, 0])
    expect(crossfade(Float32Array.from(a), Float32Array.from(a2), b, b2, { start: 1, span: 0 }).left[0]).toBeCloseTo(0, 6)
    expect(crossfade(Float32Array.from(a), Float32Array.from(a2), b, b2, { start: 0, span: 0 }).left[0]).toBeCloseTo(1, 6)
  })

  test('switching a filter instantly steps the waveform', () => {
    // One continuous tone, cut into the block that airs before the change and
    // the block that airs after it. Nothing about the signal changes at the
    // join except the filter, so the join is the click.
    const whole = tone(0.8)
    // Deliberately not on a cycle boundary: at one, the tone happens to be at
    // zero and the join looks clean whatever the filter does to it.
    const cut = Math.round(0.4 * SR) + 123
    const first = { left: whole.left.slice(0, cut), right: whole.right.slice(0, cut) }
    const second = { left: whole.left.slice(cut), right: whole.right.slice(cut) }
    new FilterChain({}, { sampleRate: SR }).process(first.left, first.right, first.left.length)
    new FilterChain(KILL, { sampleRate: SR }).process(second.left, second.right, second.left.length)
    const step = Math.abs(second.left[0] - first.left[first.left.length - 1])
    // Several times the tone's own slope, which is the definition of a click.
    const slope = maxStep(whole.left, cut - 2000, cut)
    expect(step).toBeGreaterThan(slope * 3)
    expect(step).toBeGreaterThan(0.2)
  })

  test('a morph makes the same change a fade', () => {
    const before = new FilterChain({}, { sampleRate: SR })
    const after = new FilterChain(KILL, { sampleRate: SR })
    const blocks = []
    const startedAt = Date.now()
    const ms = 220
    const whole = tone(0.8)
    const size = Math.round((BLOCK_MS / 1000) * SR)
    for (let block = 0; block < 4; block += 1) {
      const audio = { left: whole.left.slice(block * size, (block + 1) * size), right: whole.right.slice(block * size, (block + 1) * size) }
      // The first block is still the old chain alone; from the second, both
      // run and the mix moves across.
      const out =
        block === 0
          ? before.process(audio.left, audio.right, audio.left.length)
          : processWithMorph(after, before, audio, { startedAt, ms, now: startedAt + (block - 1) * BLOCK_MS + 1 })
      blocks.push(out.left)
    }
    const joined = Float32Array.from(blocks.flatMap((block) => Array.from(block)))
    // Nothing at the join is more than the tone's own slope.
    const atJoin = maxStep(joined, SR * (BLOCK_MS / 1000) - 64, SR * (BLOCK_MS / 1000) + 64 * 2)
    expect(atJoin).toBeLessThan(0.1)
    // And the change did happen: by the last block the tone is gone.
    const tail = joined.subarray(joined.length - 2000)
    expect(maxStep(tail)).toBeLessThan(0.02)
  })

  test('the ramp finishes, and says so', () => {
    const before = new FilterChain({}, { sampleRate: SR })
    const after = new FilterChain(KILL, { sampleRate: SR })
    const audio = tone(0.05)
    const startedAt = Date.now()
    const first = processWithMorph(after, before, tone(0.05), { startedAt, ms: 100, now: startedAt })
    expect(first.done).toBe(false)
    const last = processWithMorph(after, before, tone(0.05), { startedAt, ms: 100, now: startedAt + 250 })
    expect(last.done).toBe(true)
    expect(audio.left.length).toBeGreaterThan(0)
  })

  test('a chain with nothing to change to is not run twice', () => {
    const chain = new FilterChain(KILL, { sampleRate: SR })
    const audio = tone(0.05)
    const out = processWithMorph(chain, null, audio, { startedAt: 0, ms: 220 })
    expect(out.done).toBe(true)
    expect(out.length).toBe(audio.left.length)
  })
})
