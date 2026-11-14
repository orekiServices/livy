/**
 * The filter folder — the parts the old single file could not do.
 *
 * Three things are new and each one is a claim that has to be measured:
 *
 *   • **Animated transitions.** `transition: { durationMs }` has to ramp a
 *     setting over blocks, not swap it, and it has to keep ramping *from
 *     wherever it is* when a second transition interrupts it.
 *   • **In-place updates.** Moving one fader must not reset the reverb tail;
 *     switching a filter off must free its state.
 *   • **Tempo stretch.** WSOLA has to change length without changing pitch,
 *     and pitch shift has to change pitch without changing length.
 *
 * Measured on audio, because "the code ran" is not the same as "the effect
 * is audible".
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BaseFilter,
  FilterChain,
  applyPitchShift,
  applyTempoStretch,
  compile,
  curveValue,
  describe,
  makeFilter,
  renderWithStretch,
  wsola
} from '../src/core/filters/index.ts'

const SR = 44_100

/** A steady tone, as a stereo pair of Float32Arrays. */
function tone(frequency = 440, seconds = 0.5, amplitude = 0.5) {
  const length = Math.round(SR * seconds)
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const value = Math.sin((2 * Math.PI * frequency * i) / SR) * amplitude
    left[i] = value
    right[i] = value
  }
  return { left, right, length }
}

const rms = (samples) => {
  let total = 0
  for (const sample of samples) total += sample * sample
  return Math.sqrt(total / samples.length)
}

/**
 * Frequency from zero crossings — enough for a clean tone, and the only
 * measurement that actually answers "did the pitch move?".
 */
function frequencyOf(samples) {
  let crossings = 0
  const first = 0.05 * SR
  const last = samples.length - 0.05 * SR
  for (let i = Math.max(1, first); i < Math.min(samples.length, last); i += 1) {
    if (samples[i - 1] <= 0 && samples[i] > 0) crossings += 1
  }
  return crossings / ((last - first) / SR)
}

test('the folder describes every filter, with its priority and its params', () => {
  const described = describe()
  assert.ok(described.filters.length >= 19, 'every filter is described')
  const equalizer = described.filters.find((filter) => filter.name === 'equalizer')
  assert.equal(equalizer.params[0].key, 'bands')
  assert.ok(equalizer.params[0].list, 'the band list is advertised as a list')
  assert.ok(described.filters.every((filter) => typeof filter.priority === 'number'), 'the chain order is exposed')
  assert.equal(described.animations, true, 'transitions are supported, and the console can say so')
})

test('curveValue is monotonic and lands exactly on both ends', () => {
  for (const curve of ['linear', 'exponential', 'sinusoidal']) {
    assert.equal(curveValue(0, curve), 0)
    assert.equal(curveValue(1, curve), 1)
    let previous = 0
    for (let t = 0.1; t < 1; t += 0.1) {
      const value = curveValue(t, curve)
      assert.ok(value >= previous, `${curve} never runs backwards`)
      previous = value
    }
  }
})

test('a transition ramps a setting over blocks instead of jumping', () => {
  const { left, right, length } = tone(440, 1)
  const chain = new FilterChain({
    // A deep tremolo, switched on with a half-second ramp. The filter starts
    // at depth 0 and *arrives* at 1, so the first block should be much less
    // modulated than the last.
    tremolo: { frequency: 6, depth: 1, transition: { durationMs: 500, curve: 'linear' } }
  })
  const filter = chain.compiled.chain[0]
  assert.equal(filter.config.depth, 0, 'a transition starts from where the filter was')

  // Four blocks of 125 ms: half of the ramp, then the rest.
  const block = Math.round(SR * 0.125)
  const swells = []
  for (let start = 0; start + block <= length; start += block) {
    const sliceL = left.slice(start, start + block)
    const sliceR = right.slice(start, start + block)
    chain.process(sliceL, sliceR, block)
    swells.push(rms(sliceL))
  }
  assert.ok(filter.config.depth > 0.85, `the ramp nearly completed (depth ${filter.config.depth.toFixed(2)})`)
  assert.ok(swells[0] > swells[1], 'the first block is barely modulated, the second more')

  // One more block finishes it exactly: a transition that starts at 0 and
  // lasts 500 ms is done after 500 ms of audio, not after 500 ms + a block.
  const tail = tone(440, 0.13)
  chain.process(tail.left, tail.right, tail.length)
  assert.equal(filter.config.depth, 1, 'the ramp lands exactly on its target')
  assert.ok(!filter.animating, 'and the animation is over')
})

test('a second update mid-transition starts from where the first had got to', () => {
  // Built active at mix 0.2, then ramped to 1 over 200 ms: after one 20 ms
  // block it is part-way, and the second request must resume from there
  // rather than jumping back to 0.2. The first update is what arms the ramp —
  // a filter does not animate its own constructor — so it is done by hand.
  const chain = new FilterChain({ echo: { delay: 0.1, mix: 0.2 } })
  const filter = chain.compiled.chain[0]
  filter.update({ delay: 0.1, mix: 1, transition: { durationMs: 200 } })
  const direct = makeFilter('echo', { delay: 0.1, mix: 0.2 })
  assert.ok(direct instanceof BaseFilter, 'every filter is a BaseFilter')
  assert.equal(direct.priority, 12)

  const { left, right } = tone(300, 0.02)
  filter.process(left, right, left.length)
  assert.ok(filter.config.mix > 0.2 && filter.config.mix < 1, `it is part-way through the ramp (${filter.config.mix})`)

  const partway = filter.config.mix
  filter.update({ delay: 0.1, mix: 1, transition: { durationMs: 200 } })
  assert.equal(filter.config.mix, partway, 'the new ramp begins where the old one stopped')
})

test('updating a chain keeps the state of the filters that stay engaged', () => {
  const chain = new FilterChain({ reverb: { mix: 0.6, roomSize: 0.8 } })
  const reverb = chain.compiled.chain[0]
  const { left, right } = tone(440, 0.25)
  chain.process(left, right, left.length)

  // The combs hold energy now. A rebuild would zero it.
  const tailBefore = reverb.flush.length
  chain.update({ reverb: { mix: 0.7, roomSize: 0.8 } })
  assert.equal(chain.compiled.chain[0], reverb, 'the same instance is still running')
  assert.equal(reverb.flush.length, tailBefore, 'and it kept its buffer')
  assert.equal(reverb.config.mix, 0.7, 'while re-reading the payload')
})

test('a filter that switches off is reset and dropped', () => {
  const chain = new FilterChain({ tremolo: { frequency: 5, depth: 0.8 } })
  assert.deepEqual(chain.active, ['tremolo'])
  chain.update({ tremolo: { frequency: 5, depth: 0 } })
  assert.deepEqual(chain.active, [], 'the chain is empty again')
})

test('WSOLA changes the length and keeps the pitch', () => {
  const { left } = tone(440, 2)
  const faster = wsola(left, 0.75)
  assert.ok(Math.abs(faster.length - left.length * 0.75) < 200, `the length follows the ratio (${faster.length})`)
  const before = frequencyOf(left)
  const after = frequencyOf(faster)
  assert.ok(Math.abs(after - before) < 12, `the pitch stayed put (${before.toFixed(1)} → ${after.toFixed(1)})`)
})

test('applyTempoStretch composes tempo and key like a turntable', () => {
  const { left, right } = tone(440, 2)
  const channels = [left, right]

  // speed alone: both tempo and pitch move together, as a record does.
  const tape = applyTempoStretch(channels, { speed: 1.2 })
  assert.ok(Math.abs(tape.channels[0].length - left.length / 1.2) < 400, 'a 20 % speed-up is a 20 % shorter track')

  // rate alone: tempo moves, pitch does not.
  const tempo = applyTempoStretch(channels, { rate: 0.8 })
  const before = frequencyOf(left)
  const after = frequencyOf(tempo.channels[0])
  assert.ok(Math.abs(tempo.channels[0].length - left.length / 0.8) < 500, 'a 0.8 rate is a longer track')
  assert.ok(Math.abs(after - before) < 15, `and the key is unchanged (${before.toFixed(1)} → ${after.toFixed(1)})`)
})

test('applyPitchShift moves the key and leaves the length alone', () => {
  const { left, right } = tone(440, 2)
  const shifted = applyPitchShift([left, right], 7, {}) // a fifth up
  const before = frequencyOf(left)
  const after = frequencyOf(shifted.channels[0])
  assert.ok(after > before * 1.35 && after < before * 1.65, `a fifth is ×1.498 (${before.toFixed(1)} → ${after.toFixed(1)})`)
  assert.ok(Math.abs(shifted.channels[0].length - left.length) < left.length * 0.02, 'the length is unchanged')
})

test('renderWithStretch applies the stream stage before the block filters', async () => {
  const { left, right } = tone(440, 1)
  const output = await renderWithStretch(
    { left, right },
    { timescale: { rate: 1.2 }, tremolo: { frequency: 4, depth: 0.5 } }
  )
  assert.ok(Math.abs(output.length - left.length / 1.2) < left.length * 0.05, 'the rate shortened the segment')
  assert.deepEqual(output.stream, { speed: 1, pitch: 1, rate: 1.2 })
  assert.ok(output.chain.includes('tremolo'), 'the block filter still ran')
  // A tremolo at depth 0.5 has to leave the peak below the dry tone's.
  let peak = 0
  for (const sample of output.left) peak = Math.max(peak, Math.abs(sample))
  assert.ok(peak < 0.5, `the tremolo dipped the signal (peak ${peak.toFixed(3)})`)
})

test('compile skips a neutral filter and reports an unknown one', () => {
  const compiled = compile({ reverb: { mix: 0 }, chorus: { mix: 0.4 }, nonsense: { x: 1 } })
  assert.deepEqual(compiled.active, ['chorus'])
  assert.deepEqual(compiled.unknown, ['nonsense'])
  assert.ok(compiled.skipped.includes('reverb'))
})

test('a chain of several filters runs them in priority order', () => {
  const chain = new FilterChain({
    reverb: { mix: 0.3 },
    equalizer: { bands: [{ band: 3, gain: 1.4 }] },
    distortion: { tanScale: 1.4, tanOffset: 0.1 }
  })
  assert.deepEqual(chain.active, ['equalizer', 'distortion', 'reverb'], 'EQ, then drive, then the tail')
})

test('equalizerStandalone validates its own schema and coexists with equalizer on update()', () => {
  const described = describe({ equalizerStandalone: { band: 4, gain: 0.6 } })
  assert.deepEqual(described.unknown, [], 'band and gain are recognised on equalizerStandalone')
  assert.deepEqual(described.active, ['equalizer'])

  const chain = new FilterChain({
    equalizer: { bands: [{ band: 2, gain: 0.4 }] },
    equalizerStandalone: { band: 10, gain: -0.5 }
  })
  assert.equal(chain.compiled.chain.length, 2, 'both equalizer instances are active')
  const [eq, standalone] = chain.compiled.chain
  chain.update({
    equalizer: { bands: [{ band: 2, gain: 0.8 }] },
    equalizerStandalone: { band: 10, gain: -0.8 }
  })
  assert.equal(chain.compiled.chain[0], eq, 'multi-band EQ instance preserved')
  assert.equal(chain.compiled.chain[1], standalone, 'standalone EQ instance preserved independently')
  assert.ok(Math.abs(eq.gains[2] - 1.8) < 1e-5)
  assert.ok(Math.abs(standalone.gains[10] - 0.2) < 1e-5)

  // Missing gain on a band object defaults to flat (0), never +1 boost.
  const flat = compile({ equalizer: { bands: [{ band: 3 }] } })
  assert.deepEqual(flat.active, [])
})

test('transitions complete in real audio time, including distortion and channelMix', () => {
  // 500 ms of planar audio must complete a 500 ms transition (not 1000 ms).
  const dist = makeFilter('distortion', { scale: 2, transition: { durationMs: 500, curve: 'linear' } })
  assert.equal(dist.config.scale, 1)
  const half = tone(300, 0.25)
  dist.process(half.left, half.right, half.length)
  assert.ok(Math.abs(dist.config.scale - 1.5) < 0.05, `halfway at 250 ms (${dist.config.scale})`)
  assert.equal(dist.animating, true)
  const rest = tone(300, 0.26)
  dist.process(rest.left, rest.right, rest.length)
  assert.equal(dist.config.scale, 2)
  assert.equal(dist.animating, false)

  // Distortion offsets clamp to [-1, 1] (not [-1, 3]).
  dist.update({ offset: 2.5, sinOffset: 2.5 })
  assert.equal(dist.config.offset, 1)
  assert.equal(dist.config.sinOffset, 1)

  const mix = makeFilter('channelMix', { leftToLeft: 0.5, leftToRight: 0.5, transition: { durationMs: 200, curve: 'linear' } })
  const slice = tone(300, 0.1)
  mix.process(slice.left, slice.right, slice.length)
  assert.ok(mix.config.leftToLeft < 0.9 && mix.config.leftToLeft > 0.6, `channelMix ramped (${mix.config.leftToLeft})`)
})

test('custom reverb combs actually run even when MetroFX is loaded', () => {
  const impulse = (delays, gains) => {
    const reverb = makeFilter('reverb', { mix: 0.8, delays, gains }, { sampleRate: SR })
    const left = new Float32Array(Math.round(SR * 0.15))
    const right = new Float32Array(left.length)
    for (let i = 0; i < 64; i += 1) left[i] = right[i] = 0.8
    reverb.process(left, right, left.length)
    return left
  }
  const shortRoom = impulse([0.01], [0.8])
  const longRoom = impulse([0.08], [0.8])
  let diff = 0
  for (let i = 0; i < shortRoom.length; i += 1) diff = Math.max(diff, Math.abs(shortRoom[i] - longRoom[i]))
  assert.ok(diff > 0.01, `custom comb delays produce distinct responses (max diff ${diff.toFixed(4)})`)
})

test('chorus, phaser, flanger and compressor activation and limits stay consistent', () => {
  // Flanger feedback capped at 0.95 (NodeLink).
  const flanger = makeFilter('flanger', { mix: 0.5, rate: 1, depth: 0.5, feedback: 1 })
  assert.equal(flanger.config.feedback, 0.95)

  // Chorus and phaser compiled as active actually modify audio.
  for (const [name, payload] of [
    ['chorus', { chorus: { mix: 0.5 } }],
    ['phaser', { phaser: { rate: 1, mix: 0.5 } }]
  ]) {
    const chain = new FilterChain(payload, { sampleRate: SR })
    assert.deepEqual(chain.active, [name])
    const dry = tone(440, 0.25)
    const wetL = Float32Array.from(dry.left)
    const wetR = Float32Array.from(dry.right)
    chain.process(wetL, wetR, wetL.length)
    let delta = 0
    for (let i = 0; i < wetL.length; i += 1) delta = Math.max(delta, Math.abs(wetL[i] - dry.left[i]))
    assert.ok(delta > 0.01, `${name} actually processes audio (delta ${delta.toFixed(4)})`)
  }

  // Compressor with makeupGain only (threshold 0 dB, ratio 1) is still active and boosts output.
  const boost = new FilterChain({ compressor: { threshold: 0, ratio: 1, makeupGain: 6 } }, { sampleRate: SR })
  assert.deepEqual(boost.active, ['compressor'])
  const sig = tone(440, 0.1, 0.2)
  const outL = Float32Array.from(sig.left)
  boost.process(outL, Float32Array.from(sig.right), outL.length)
  assert.ok(rms(outL) > rms(sig.left) * 1.5, 'makeupGain boosts even when threshold is 0 dB')
})

test('renderWithStretch keeps duration on pure pitch shift with a custom stretcher', async () => {
  const audio = tone(440, 1)
  let seen = null
  const shifted = await renderWithStretch(audio, { timescale: { pitch: 1.5 } }, {
    sampleRate: SR,
    stretch: async (channels, _rate, { stretch }) => {
      seen = stretch
      const length = Math.round(channels[0].length * stretch)
      return { channels: channels.map((c) => { const out = new Float32Array(length); out.set(c.subarray(0, Math.min(c.length, length))); return out }), length }
    }
  })
  assert.ok(Math.abs(seen - 1.5) < 1e-6, `pure pitch 1.5 stretches by 1.5 before resampling (${seen})`)
  assert.ok(Math.abs(shifted.length - audio.left.length) < 4, `duration preserved (${shifted.length} vs ${audio.left.length})`)
})
