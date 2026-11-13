/**
 * Station filters — the NodeLink surface, and whether each one actually does
 * what its name says.
 *
 * The assertions are on *audio*, not on the presence of a key: a low-pass that
 * does not remove highs, or a karaoke that removes the bass along with the
 * voice, would pass a schema test and ruin a station. Where a claim can be
 * measured (band energy before and after, stereo width, peak) it is measured.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EQ_BANDS,
  FILTER_NAMES,
  FILTER_SCHEMA,
  FilterChain,
  compile,
  describe,
  isActive,
  makeFilter,
  neutralSettings,
  validate,
  renderWithStretch
} from '../src/core/filters/index.js'
import { samplePeak } from '../src/core/dsp.js'
import { quietLogs } from './helpers.js'

quietLogs()

const SR = 44_100

/** A tone at `freq`, as an equal-power stereo pair. */
function tone(freq, seconds = 1, amplitude = 0.5) {
  const n = Math.round(SR * seconds)
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  for (let i = 0; i < n; i += 1) {
    const v = Math.sin((2 * Math.PI * freq * i) / SR) * amplitude
    left[i] = v
    right[i] = v
  }
  return { left, right }
}

/** Two independent tones, one per channel — a true stereo image. */
function stereo(leftFreq, rightFreq, seconds = 1) {
  const n = Math.round(SR * seconds)
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  for (let i = 0; i < n; i += 1) {
    left[i] = Math.sin((2 * Math.PI * leftFreq * i) / SR) * 0.5
    right[i] = Math.sin((2 * Math.PI * rightFreq * i) / SR) * 0.5
  }
  return { left, right }
}

/**
 * Energy at one frequency, by Goertzel.
 *
 * Normalised by the number of samples *analysed*, not the buffer length, so a
 * single-sample impulse and a continuous tone are on the same scale — which is
 * what makes it usable for both filter response and echo timing.
 */
function energyAt(samples, freq) {
  const n = Math.min(samples.length, SR)
  const k = (2 * Math.PI * freq) / SR
  let real = 0
  let imag = 0
  for (let i = 0; i < n; i += 1) {
    real += samples[i] * Math.cos(k * i)
    imag -= samples[i] * Math.sin(k * i)
  }
  return Math.sqrt(real * real + imag * imag) / n
}

function rms(samples) {
  let sum = 0
  for (const v of samples) sum += v * v
  return Math.sqrt(sum / samples.length)
}

/* ------------------------------------------------------------------ *
 * Schema and validation
 * ------------------------------------------------------------------ */

test('the schema covers the NodeLink filter set', () => {
  // Every filter NodeLink ships, plus the standalone EQ band this node adds
  // for automation. A missing one is a feature somebody will notice.
  for (const name of [
    'equalizer',
    'timescale',
    'tremolo',
    'vibrato',
    'distortion',
    'karaoke',
    'channelMix',
    'lowpass',
    'highpass',
    'rotation',
    'spatial',
    'chorus',
    'phaser',
    'flanger',
    'echo',
    'reverb',
    'compressor',
    'phonograph',
    'tesseract'
  ]) {
    assert.ok(FILTER_SCHEMA[name], `${name} is in the schema`)
    assert.ok(FILTER_NAMES.includes(name), `${name} is in processing order`)
  }
  assert.equal(EQ_BANDS.length, 15, 'NodeLink has 15 EQ bands')
  assert.deepEqual(EQ_BANDS.slice(0, 3), [25, 40, 63])
  assert.equal(EQ_BANDS.at(-1), 16_000)
})

test('validation clamps, refuses unknowns, and accepts NodeLink animation hints', () => {
  const { settings, unknown, clamped } = validate({
    tremolo: { frequency: 4, depth: 12, transition: { durationMs: 200 } },
    equalizer: { bands: [{ band: 99, gain: 9 }, { band: 3, gain: 1.2 }] },
    'not-a-filter': { x: 1 }
  })

  assert.equal(settings.tremolo.depth, 1, 'depth is clamped to its range')
  assert.deepEqual(settings.tremolo.transition, { durationMs: 200 }, 'transition is kept so the filter can ramp')
  assert.deepEqual(clamped.sort(), ['equalizer.bands', 'tremolo.depth'].sort())
  assert.deepEqual(unknown.sort(), ['not-a-filter'].sort())
  assert.equal(settings.karaoke, undefined, 'an unmentioned filter is not invented')
  // Out-of-range band indexes become the nearest real band, gains are clamped.
  assert.equal(settings.equalizer.bands[0].band, EQ_BANDS.length - 1)
  assert.equal(settings.equalizer.bands[0].gain, 3)
  assert.deepEqual(settings.equalizer.bands[1], { band: 3, gain: 1.2 })
})

test('a neutral payload compiles to nothing at all', () => {
  const compiled = compile(neutralSettings())
  assert.deepEqual(compiled.active, [], 'nothing runs when nothing is asked for')
  assert.equal(new FilterChain({}).empty, true)
  assert.equal(isActive('equalizer', { bands: [{ band: 1, gain: 1 }] }), false)
  assert.equal(isActive('lowpass', { cutoff: 20_000 }), false)
  assert.equal(isActive('reverb', { mix: 0 }), false)
})

test('describe() is the schema, and it agrees with what validation enforces', () => {
  const described = describe()
  assert.equal(described.bands.length, 15)
  assert.equal(described.filters.length, Object.keys(FILTER_SCHEMA).length)
  const tremolo = described.filters.find((f) => f.name === 'tremolo')
  const depth = tremolo.params.find((p) => p.key === 'depth')
  assert.deepEqual([depth.min, depth.max], FILTER_SCHEMA.tremolo.depth.range)
  const phaser = described.filters.find((f) => f.name === 'phaser')
  assert.equal(phaser.params.find((p) => p.key === 'stages').integer, true)
})

/* ------------------------------------------------------------------ *
 * The filters, measured
 * ------------------------------------------------------------------ */

test('the equaliser cuts and boosts the band it is told to', () => {
  const at1k = tone(1000)
  const at100 = tone(100)

  const cut = new FilterChain({ equalizer: { bands: [{ band: 8, gain: 0.25 }] } }, { sampleRate: SR })
  const boosted = new FilterChain({ equalizer: { bands: [{ band: 8, gain: 3 }] } }, { sampleRate: SR })

  const a = Float32Array.from(at1k.left)
  const b = Float32Array.from(at1k.left)
  const c = Float32Array.from(at100.left)
  cut.process(a, Float32Array.from(at1k.right), a.length)
  boosted.process(b, Float32Array.from(at1k.right), b.length)
  // A 1 kHz tone must not be touched by the 100 Hz band.
  cut.process(c, Float32Array.from(at100.right), c.length)

  assert.ok(energyAt(b, 1000) > energyAt(a, 1000) * 1.5, 'the 1 kHz band is boosted at 1 kHz')
  assert.ok(energyAt(a, 1000) < 0.1, 'and cut when cut (-12 dB)')
  assert.ok(Math.abs(energyAt(c, 100) - energyAt(at100.left, 100)) < 0.05, 'the 100 Hz tone is untouched by band 8')
})

test('low-pass and high-pass really remove the band they name', () => {
  const mix = tone(300)
  const low = new FilterChain({ lowpass: { cutoff: 400 } }, { sampleRate: SR })
  const high = new FilterChain({ highpass: { cutoff: 4000 } }, { sampleRate: SR })

  const passed = Float32Array.from(mix.left)
  low.process(passed, Float32Array.from(mix.right), passed.length)
  assert.ok(energyAt(passed, 300) > 0.15, '300 Hz survives a 400 Hz low-pass')

  const blocked = Float32Array.from(mix.left)
  high.process(blocked, Float32Array.from(mix.right), blocked.length)
  assert.ok(energyAt(blocked, 300) < 0.02, '300 Hz does not survive a 4 kHz high-pass')

  // The NodeLink `smoothing` dial: 1 is open, 30 is a closed door.
  const smooth = new FilterChain({ lowpass: { smoothing: 30 } }, { sampleRate: SR })
  const mellow = Float32Array.from(mix.left)
  smooth.process(mellow, Float32Array.from(mix.right), mellow.length)
  assert.ok(energyAt(mellow, 300) < energyAt(mix.left, 300) * 0.5, 'smoothing closes the filter down')
})

test('karaoke removes a centred voice and keeps a stereo mix', () => {
  // A voice panned dead centre: identical in both channels.
  const centred = stereo(1000, 1000)
  const chain = new FilterChain({ karaoke: { level: 0.95 } }, { sampleRate: SR })
  const L = Float32Array.from(centred.left)
  const R = Float32Array.from(centred.right)
  chain.process(L, R, L.length)
  assert.ok(rms(L) < 0.05, `the centre channel is gone (rms ${rms(L).toFixed(3)})`)

  // A wide mix: two different notes. Cancelling one channel would be audible.
  const wide = stereo(440, 660)
  const wideChain = new FilterChain({ karaoke: { level: 0.95 } }, { sampleRate: SR })
  const WL = Float32Array.from(wide.left)
  const WR = Float32Array.from(wide.right)
  wideChain.process(WL, WR, WL.length)
  assert.ok(rms(WL) > 0.2, 'a stereo mix survives vocal cancellation')
  assert.ok(rms(WR) > 0.2)
})

test('karaoke leaves the low end alone when it is band-limited to the voice', () => {
  // Bass dead centre at 50 Hz, voice dead centre at 1 kHz: the band-limited
  // form must cancel the voice and keep the bass, which is the whole point.
  const n = SR
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  for (let i = 0; i < n; i += 1) {
    const bass = Math.sin((2 * Math.PI * 50 * i) / SR) * 0.4
    const voice = Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.4
    left[i] = bass + voice
    right[i] = bass + voice
  }
  const chain = new FilterChain({ karaoke: { level: 0.95, filterBand: 10, filterWidth: 4 } }, { sampleRate: SR })
  chain.process(left, right, n)
  assert.ok(energyAt(left, 50) > 0.1, 'the kick and bass survive')
  assert.ok(energyAt(left, 1000) < energyAt(left, 50), 'the voice does not')
})

test('tremolo modulates amplitude at the rate it was given', () => {
  const steady = tone(440, 2)
  const chain = new FilterChain({ tremolo: { frequency: 5, depth: 1 } }, { sampleRate: SR })
  const L = Float32Array.from(steady.left)
  chain.process(L, Float32Array.from(steady.right), L.length)

  // The envelope should swing between ~0 and ~1: loud early in a cycle, quiet
  // in the trough, five times a second.
  const window = Math.round(SR * 0.02)
  const envelopes = []
  for (let start = 0; start + window < L.length; start += window) {
    let peak = 0
    for (let i = start; i < start + window; i += 1) peak = Math.max(peak, Math.abs(L[i]))
    envelopes.push(peak)
  }
  const max = Math.max(...envelopes)
  const min = Math.min(...envelopes)
  assert.ok(max > 0.4, 'the carrier is still there')
  assert.ok(min < max * 0.2, `the depth reaches the trough (min ${min.toFixed(3)} max ${max.toFixed(3)})`)
})

test('channel mix follows the matrix exactly', () => {
  const audio = stereo(440, 880)
  const chain = new FilterChain({ channelMix: { leftToLeft: 0, leftToRight: 1, rightToLeft: 1, rightToRight: 0 } }, { sampleRate: SR })
  const L = Float32Array.from(audio.left)
  const R = Float32Array.from(audio.right)
  chain.process(L, R, L.length)
  // The channels swapped: what was in the left is now in the right.
  assert.ok(energyAt(L, 880) > 0.15 && energyAt(L, 440) < 0.05)
  assert.ok(energyAt(R, 440) > 0.15 && energyAt(R, 880) < 0.05)
})

test('echo repeats after the delay it was given', () => {
  const n = SR
  const impulse = new Float32Array(n)
  impulse[0] = 0.5
  const chain = new FilterChain({ echo: { delay: 0.25, feedback: 0.4, mix: 1 } }, { sampleRate: SR })
  const L = Float32Array.from(impulse)
  chain.process(L, Float32Array.from(impulse), n)

  const at = (seconds) => Math.abs(L[Math.round(seconds * SR)])
  assert.ok(at(0.25) > 0.05, 'the first repeat is at the delay')
  assert.ok(at(0.5) > 0.005, 'and it repeats again from the feedback')
  assert.ok(at(0.1) < 0.01, 'nothing happens before it')
})

test('reverb makes a tail longer than the sound that caused it', () => {
  const n = SR
  const burst = new Float32Array(n)
  for (let i = 0; i < Math.round(SR * 0.05); i += 1) burst[i] = Math.sin((2 * Math.PI * 500 * i) / SR) * 0.5
  const chain = new FilterChain({ reverb: { mix: 0.6, roomSize: 0.8, damping: 0.2 } }, { sampleRate: SR })
  const L = Float32Array.from(burst)
  chain.process(L, Float32Array.from(burst), n)

  const tail = (from, to) => {
    let sum = 0
    for (let i = Math.round(from * SR); i < Math.round(to * SR); i += 1) sum += L[i] * L[i]
    return Math.sqrt(sum / ((to - from) * SR))
  }
  assert.ok(tail(0.3, 0.6) > 1e-3, 'there is still sound 300–600 ms after the burst')
})

test('rotation and tesseract move the stereo image without losing it', () => {
  for (const name of ['rotation', 'tesseract']) {
    const audio = stereo(440, 440)
    const chain = new FilterChain({ [name]: { rotationHz: 2 } }, { sampleRate: SR })
    const L = Float32Array.from(audio.left)
    const R = Float32Array.from(audio.right)
    chain.process(L, R, L.length)
    const leftRms = rms(L)
    const rightRms = rms(R)
    assert.ok(leftRms > 0.1 && rightRms > 0.1, `${name} keeps both channels audible`)
    // A rotation must actually differ between the channels at some point.
    let differs = 0
    for (let i = 0; i < L.length; i += 1) if (Math.abs(L[i] - R[i]) > 0.05) differs += 1
    assert.ok(differs > L.length * 0.1, `${name} decorrelates the channels`)
  }
})

test('phonograph never clips, however hard it is driven', () => {
  const audio = tone(300, 2, 0.9)
  const chain = new FilterChain(
    { phonograph: { crackle: 1, flutter: 1, depth: 1, room: 1, micAgc: 1, drive: 1 } },
    { sampleRate: SR }
  )
  const L = Float32Array.from(audio.left)
  const R = Float32Array.from(audio.right)
  chain.process(L, R, L.length)
  assert.ok(samplePeak([L, R]) <= 1.0001, 'the output is bounded')
  assert.ok(rms(L) > 0.05, 'and not silent')
})

test('distortion is bounded and changes the waveform', () => {
  const audio = tone(220, 0.5, 0.8)
  const chain = new FilterChain({ distortion: { scale: 2, offset: 0.2 } }, { sampleRate: SR })
  const L = Float32Array.from(audio.left)
  chain.process(L, Float32Array.from(audio.right), L.length)
  assert.ok(samplePeak([L]) <= 1, 'bounded to full scale')
  assert.notDeepEqual(Array.from(L.subarray(0, 16)), Array.from(audio.left.subarray(0, 16)))
})

test('the compressor reduces a loud signal and leaves a quiet one', () => {
  const make = (amplitude) => {
    const n = Math.round(SR * 0.5)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i += 1) out[i] = Math.sin((2 * Math.PI * 200 * i) / SR) * amplitude
    return out
  }
  const chain = new FilterChain({ compressor: { threshold: 0.5, ratio: 8, attack: 0, release: 0.1 } }, { sampleRate: SR })
  const loud = make(0.9)
  const loudR = Float32Array.from(loud)
  chain.process(loud, loudR, loud.length)
  assert.ok(samplePeak([loud]) < 0.9, 'the peak came down')

  const quietChain = new FilterChain({ compressor: { threshold: 0.5, ratio: 8, attack: 0, release: 0.1 } }, { sampleRate: SR })
  const quiet = make(0.2)
  quietChain.process(quiet, Float32Array.from(quiet), quiet.length)
  assert.ok(Math.abs(samplePeak([quiet]) - 0.2) < 0.03, 'below the threshold it is untouched')
})

/* ------------------------------------------------------------------ *
 * Chain behaviour
 * ------------------------------------------------------------------ */

test('the chain runs in a fixed order and reports what is on', () => {
  const compiled = compile({
    reverb: { mix: 0.2 },
    equalizer: { bands: [{ band: 1, gain: 1.5 }] },
    tremolo: { frequency: 3, depth: 0.4 }
  })
  assert.deepEqual(compiled.active, ['equalizer', 'tremolo', 'reverb'], 'EQ → tremolo → reverb')
  assert.deepEqual(compiled.skipped, [])
})

test('state persists across blocks, so a filter is continuous', () => {
  // A sine fed to a reverb in two blocks must produce the same samples as the
  // same audio fed in one block: no per-block restart, no click at the splice.
  const whole = tone(440, 1, 0.5)
  const oneShot = new FilterChain({ reverb: { mix: 0.4 } }, { sampleRate: SR })
  const a = Float32Array.from(whole.left)
  const aR = Float32Array.from(whole.right)
  oneShot.process(a, aR, a.length)

  const split = new FilterChain({ reverb: { mix: 0.4 } }, { sampleRate: SR })
  const b = Float32Array.from(whole.left)
  const bR = Float32Array.from(whole.right)
  const half = Math.floor(b.length / 2)
  split.process(b.subarray(0, half), bR.subarray(0, half), half)
  split.process(b.subarray(half), bR.subarray(half), b.length - half)

  let worst = 0
  for (let i = 0; i < a.length; i += 1) worst = Math.max(worst, Math.abs(a[i] - b[i]))
  assert.ok(worst < 1e-6, `two blocks equal one block (worst ${worst})`)
})

test('a stream-level timescale is reported, not silently ignored', () => {
  const compiled = compile({ timescale: { speed: 1.05 } })
  assert.deepEqual(compiled.active, ['timescale'])
  const chain = new FilterChain({ timescale: { speed: 1.05, rate: 0.95, pitch: 1.1 } })
  assert.deepEqual(chain.streamRequest, { speed: 1.05, pitch: 1.1, rate: 0.95 })
  // Pitch alone is still stream-level: it is a stretch plus a resample, which
  // no per-block filter can do. The chain reports it so the caller can.
  assert.deepEqual(new FilterChain({ timescale: { pitch: 1.05 } }).streamRequest, { speed: 1, pitch: 1.05, rate: 1 })
})

test('renderWithStretch applies tempo and pitch when a stretcher is supplied', async () => {
  const audio = tone(440, 1)
  let seen = null
  const stretched = await renderWithStretch(audio, { timescale: { speed: 1.1 } }, {
    sampleRate: SR,
    // The contract in dsp.js/metro.js: `stretch` is output/input, so a faster
    // tempo is a *smaller* ratio and a shorter output.
    stretch: async (channels, _rate, { stretch }) => {
      seen = stretch
      const length = Math.round(channels[0].length * stretch)
      return { channels: channels.map((c) => c.subarray(0, length)), length }
    }
  })
  assert.ok(Math.abs(seen - 1 / 1.1) < 1e-6, `asked for a 1/1.1 stretch, got ${seen}`)
  assert.ok(stretched.length < audio.left.length, 'a faster speed produces shorter audio')
  assert.ok(Math.abs(stretched.length - Math.round(audio.left.length / 1.1)) < 2)
})

test('unknown names survive a payload written for a newer NodeLink', () => {
  const chain = new FilterChain({ hologram: { depth: 1 }, tremolo: { frequency: 4, depth: 0.5 } })
  assert.deepEqual(chain.active, ['tremolo'], 'the known filter still runs')
  assert.deepEqual(chain.compiled.unknown, ['hologram'], 'and the unknown one is reported')
  assert.equal(makeFilter('hologram'), null, 'which is a null, not a throw')
})

test('every filter in the schema can be built and run without throwing', () => {
  // The dangerous filter is the one nobody has exercised: a parameter that
  // divides by zero, a delay line with a zero length, an LFO at 0 Hz.
  const payload = {}
  for (const [name, spec] of Object.entries(FILTER_SCHEMA)) {
    if (name === 'equalizer') {
      payload[name] = { bands: [{ band: 0, gain: 3 }, { band: 14, gain: 0.1 }] }
      continue
    }
    payload[name] = {}
    for (const [key, entry] of Object.entries(spec)) {
      if (entry.list) continue
      // The maximum is the interesting end: largest delays, fastest LFOs.
      payload[name][key] = entry.range ? entry.range[1] : entry.default
    }
  }
  const chain = new FilterChain(payload, { sampleRate: SR })
  assert.ok(chain.active.length > 10, 'most of the chain is on')
  const audio = tone(440, 0.25, 0.6)
  const L = Float32Array.from(audio.left)
  const R = Float32Array.from(audio.right)
  chain.process(L, R, L.length)
  assert.ok(Number.isFinite(samplePeak([L, R])), 'the output is finite')
  assert.ok(samplePeak([L, R]) < 50, 'and not a runaway')
})

/* ------------------------------------------------------------------ *
 * DSP quality improvements (and the native MetroFX path)
 * ------------------------------------------------------------------ */

test('the moving delay head interpolates with Catmull-Rom, not a staircase', async () => {
  const { FractionalDelay } = await import('../src/core/filters/dsp/delay.js')
  const size = 256
  const delay = new FractionalDelay(size)
  const frequency = 5000
  const omega = (2 * Math.PI * frequency) / SR
  const pushed = []
  for (let i = 0; i < 200; i += 1) {
    const value = Math.sin(omega * i)
    pushed.push(value)
    delay.push(value)
  }

  let cubic = 0
  let linear = 0
  for (const fraction of [0.25, 0.5, 0.75]) {
    const whole = 8
    const ideal = Math.sin(omega * (pushed.length - whole - fraction))
    const value = delay.read(whole + fraction)
    // The linear interpolator this replaced, computed from the same samples.
    const a = pushed[pushed.length - whole - 1]
    const b = pushed[pushed.length - whole]
    const reference = b + (a - b) * fraction
    cubic += (value - ideal) ** 2
    linear += (reference - ideal) ** 2
  }
  assert.ok(Math.sqrt(cubic / 3) < Math.sqrt(linear / 3) * 0.6, 'cubic beats linear where a moving head spends most of its time')
  assert.ok(Math.sqrt(cubic / 3) < 0.01, 'and stays close to the ideal delay')
})

test('compressor gain is input drive, not a dead knob', () => {
  const make = (amplitude) => {
    const n = Math.round(SR * 0.5)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i += 1) out[i] = Math.sin((2 * Math.PI * 200 * i) / SR) * amplitude
    return out
  }
  const run = (gain) => {
    const chain = new FilterChain(
      { compressor: { threshold: 0.5, ratio: 8, attack: 0, release: 0.1, gain, makeupGain: 1 } },
      { sampleRate: SR }
    )
    const left = make(0.4)
    const right = Float32Array.from(left)
    chain.process(left, right, left.length)
    return samplePeak([left])
  }
  const unity = run(1)
  const driven = run(2)
  assert.ok(driven > unity, `driving the input pushes it into the knee (${unity} → ${driven})`)
  assert.ok(driven <= 1, 'and the output is still bounded')
})

test('oversampled distortion puts less energy where aliases land', () => {
  // A 6 kHz tone shaped hard generates a 5th harmonic at 30 kHz, which folds
  // to 14.1 kHz at a 44.1 kHz stream rate. The oversampled path filters it
  // before decimation; a naive shaper cannot.
  const input = tone(6000, 0.25, 0.6).left
  const filter = makeFilter('distortion', { tanScale: 4 }, { sampleRate: SR })
  const shaped = Float32Array.from(input)
  const shapedR = Float32Array.from(input)
  filter.process(shaped, shapedR, shaped.length)

  const naive = Float32Array.from(input)
  for (let i = 0; i < naive.length; i += 1) {
    naive[i] = Math.tanh(naive[i] * 4) / Math.tanh(1.1)
  }

  const alias = 44_100 - 30_000
  const oversampledAlias = energyAt(shaped, alias)
  const naiveAlias = energyAt(naive, alias)
  assert.ok(naiveAlias > 0.001, `the naive shaper aliases (${naiveAlias})`)
  assert.ok(oversampledAlias < naiveAlias * 0.7, `oversampling suppresses the fold (${oversampledAlias} vs ${naiveAlias})`)
  assert.ok(samplePeak([shaped]) <= 1, 'still bounded')
})
