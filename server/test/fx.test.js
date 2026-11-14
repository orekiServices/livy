/**
 * MetroFX — the native filter kernels.
 *
 * The suite has to pass on a host with no binary (the JavaScript reference
 * runs) and on one with it (the same filters delegate to Rust). The native
 * assertions therefore test the kernels directly; the parity claim is checked
 * by running the filter suite twice, with and without `LIVY_DISABLE_FX=1`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { fx, fxAvailable, fxEngine, fxInfo } from '../src/util/fx.js'
import { EQ_BANDS, makeFilter } from '../src/core/filters/index.js'

const SR = 44_100

test('the loader reports a usable engine without ever throwing', () => {
  const info = fxInfo()
  assert.equal(info.available, fxAvailable)
  assert.equal(info.engine, fxEngine)
  assert.ok(['native', 'javascript'].includes(fxEngine))
  if (fxAvailable) {
    assert.equal(typeof fx.Biquad, 'function')
    assert.match(info.describe, /^MetroFX /)
  } else {
    assert.equal(fx, null)
    assert.equal(info.version, null)
  }
})

test('native MetroFX kernels filter, compress, ring and shape', (t) => {
  if (!fxAvailable) return t.skip('no MetroFX binary for this host')

  // Biquad: a 1 kHz low-pass should keep 300 Hz and remove 8 kHz.
  const lowpass = new fx.Biquad()
  lowpass.setLowpass(1000, SR)
  const tone = (freq) => {
    const left = new Float32Array(SR / 2)
    const right = new Float32Array(SR / 2)
    for (let i = 0; i < left.length; i += 1) {
      const value = Math.sin((2 * Math.PI * freq * i) / SR) * 0.5
      left[i] = value
      right[i] = value
    }
    return { left, right }
  }
  const rms = (samples) => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)

  const low = tone(300)
  lowpass.process(low.left, low.right, low.left.length)
  const high = tone(8000)
  // A second instance: the first one's state belongs to the 300 Hz run.
  const lowpass2 = new fx.Biquad()
  lowpass2.setLowpass(1000, SR)
  lowpass2.process(high.left, high.right, high.left.length)
  assert.ok(rms(low.left) > 0.2, 'the passband survives')
  assert.ok(rms(high.left) < 0.05, `the stopband is attenuated (${rms(high.left)})`)

  // Compressor: a loud signal comes down, a quiet one does not.
  const comp = new fx.Compressor()
  comp.setParams(0.5, 8, 0.001, 0.1, 1, 1, SR)
  const loud = tone(200)
  for (let i = 0; i < loud.left.length; i += 1) {
    loud.left[i] *= 1.8
    loud.right[i] *= 1.8
  }
  comp.process(loud.left, loud.right, loud.left.length)
  const peak = Math.max(...loud.left.map(Math.abs))
  assert.ok(peak < 0.9, `the peak came down (${peak})`)

  // Reverb: an impulse still has a tail a quarter of a second later.
  const reverb = new fx.Reverb(SR)
  reverb.setParams(0.8, 0.2, 0.5, 0.6, 0.4)
  const burst = new Float32Array(SR)
  const burstR = new Float32Array(SR)
  for (let i = 0; i < 2205; i += 1) {
    const value = Math.sin((2 * Math.PI * 500 * i) / SR) * 0.5
    burst[i] = value
    burstR[i] = value
  }
  reverb.process(burst, burstR, burst.length)
  let tail = 0
  for (let i = SR / 2; i < SR; i += 1) tail += burst[i] * burst[i]
  assert.ok(Math.sqrt(tail / (SR / 2)) > 0.0005, 'the reverb rings on')

  // Distortion: bounded, and it changed the waveform.
  const dist = new fx.Distortion(SR, 4)
  dist.setParams(0, 1, 0, 1, 4, 1, 0, 1)
  const dry = tone(220)
  const before = Float32Array.from(dry.left.subarray(0, 64))
  dist.process(dry.left, dry.right, dry.left.length)
  assert.ok(Math.max(...dry.left.map(Math.abs)) <= 1, 'bounded')
  assert.notDeepEqual(Array.from(dry.left.subarray(0, 64)), Array.from(before), 'the shaper fired')
})

test('the chain delegates to MetroFX when it is loaded', (t) => {
  if (!fxAvailable) return t.skip('no MetroFX binary for this host')
  const n = 2048
  const input = new Float32Array(n)
  for (let i = 0; i < n; i += 1) input[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5
  const run = (filter, kernel) => {
    const throughChain = Float32Array.from(input)
    const right = Float32Array.from(input)
    filter.process(throughChain, right, n)
    const direct = Float32Array.from(input)
    kernel.process(direct, Float32Array.from(input), n)
    let max = 0
    for (let i = 0; i < n; i += 1) max = Math.max(max, Math.abs(throughChain[i] - direct[i]))
    return max
  }

  // One EQ band: the chain's section and a native section with the same
  // coefficients must be sample-identical, which they are only if the chain
  // actually used the native path.
  // `gain` is an offset from flat (NodeLink's convention), so 0.5 is a 1.5x
  // multiplier, and the native section is built from that multiplier.
  const eq = makeFilter('equalizer', { bands: [{ band: 5, gain: 0.5 }] }, { sampleRate: SR })
  const section = new fx.Biquad()
  section.setPeaking(EQ_BANDS[5], 20 * Math.log10(1.5), SR, 1.41)
  assert.equal(run(eq, section), 0, 'EQ delegates to MetroFX')

  // NodeLink units: threshold and makeup in dB, attack and release in seconds.
  // The native section is given the same linear values the filter derives, so
  // the comparison is about the shared maths and not about rounding.
  const thresholdDb = -6.0206
  const makeupDb = 0.8279
  const comp = makeFilter(
    'compressor',
    { threshold: thresholdDb, ratio: 4, attack: 0.001, release: 0.01, gain: 1.2, makeupGain: makeupDb },
    { sampleRate: SR }
  )
  const compressor = new fx.Compressor()
  // `release` is clamped to NodeLink's 10 ms floor, so both sides say 0.01.
  compressor.setParams(10 ** (thresholdDb / 20), 4, 0.001, 0.01, 1.2, 10 ** (makeupDb / 20), SR)
  assert.equal(run(comp, compressor), 0, 'compressor delegates to MetroFX')

  const reverb = makeFilter('reverb', { roomSize: 0.8, damping: 0.2, width: 0.5, mix: 0.5 }, { sampleRate: SR })
  const room = new fx.Reverb(SR)
  room.setParams(0.8, 0.2, 0.5, 0.5, 0.5)
  assert.equal(run(reverb, room), 0, 'reverb delegates to MetroFX')

  const distortion = makeFilter('distortion', { tanScale: 3 }, { sampleRate: SR })
  const shaper = new fx.Distortion(SR, 4)
  shaper.setParams(0, 1, 0, 1, 0, 3, 0, 1)
  assert.equal(run(distortion, shaper), 0, 'distortion delegates to MetroFX')
})
