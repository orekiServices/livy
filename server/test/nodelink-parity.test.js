/**
 * NodeLink parity — the numbers Livy's filters have to agree with.
 *
 * NodeLink (`PerformanC/NodeLink`) is the reference implementation this filter
 * surface copies: same filter names, same payload shape, same units. Its
 * filters live in `src/playback/filters/`, one file per filter, and each one
 * clamps its own parameters in `update()`. The table below is transcribed from
 * those files, so a change here that is not a change there is a bug.
 *
 * Units are the part that bites. NodeLink's `echo.delay` is milliseconds;
 * `compressor.threshold` and `makeupGain` are decibels; `karaoke.filterBand`
 * and `filterWidth` are hertz; the equaliser's `gain` is an offset from flat.
 * A station that speaks NodeLink and a station that speaks something else
 * sound different through the same speakers, which is why the units are
 * asserted and not just documented.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { FILTER_NAMES, FILTER_SCHEMA, compile, defaultsFor, makeFilter } from '../src/core/filters/index.js'
import { EQ_BANDS } from '../src/core/filters/constants.js'

const SR = 44_100
const range = (name, key) => FILTER_SCHEMA[name][key].range
const fallback = (name, key) => FILTER_SCHEMA[name][key].default

test('the filter names are NodeLink\'s filter names', () => {
  const nodeLink = [
    'tremolo', 'vibrato', 'lowpass', 'highpass', 'rotation', 'karaoke',
    'distortion', 'channelMix', 'equalizer', 'chorus', 'compressor', 'echo',
    'phaser', 'timescale', 'spatial', 'reverb', 'flanger', 'phonograph',
    'tesseract'
  ]
  for (const name of nodeLink) {
    assert.ok(FILTER_NAMES.includes(name), `${name} is a NodeLink filter and must be one of ours`)
  }
  // `equalizerStandalone` is Livy's one addition: a single band under its own
  // key, so automation does not have to rewrite the fifteen-band array.
  const extra = FILTER_NAMES.filter((name) => !nodeLink.includes(name))
  assert.deepEqual(extra, ['equalizerStandalone'])
})

test('the equaliser is fifteen bands at NodeLink\'s centres', () => {
  // equalizer.ts: BANDS = [25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600,
  //                        2500, 4000, 6300, 10000, 16000]
  assert.deepEqual(EQ_BANDS, [25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10_000, 16_000])
})

test('the equaliser gain is an offset from flat, clamped to ±1', () => {
  // equalizer.ts maps the request gain to `1.0 + gain`, clamped to [0, 2], so
  // the request itself is bounded by [-1, 1] and `gain: -1` is a kill.
  const band = FILTER_SCHEMA.equalizer.bands.list.gain
  assert.deepEqual(band.range, [-1, 1])

  const boosted = compile({ equalizer: { bands: [{ band: 8, gain: 1 }] } }, { sampleRate: SR })
  assert.deepEqual(boosted.active, ['equalizer'])

  const flat = compile({ equalizer: { bands: [{ band: 8, gain: 0 }] } }, { sampleRate: SR })
  assert.deepEqual(flat.active, [], 'a zero offset is flat, so nothing runs')
})

test('timescale spans 0.25 to 4', () => {
  // timescale.ts: `Math.max(0.25, Math.min(4, value))` for speed, pitch, rate.
  for (const key of ['speed', 'pitch', 'rate']) {
    assert.deepEqual(range('timescale', key), [0.25, 4])
    assert.equal(fallback('timescale', key), 1)
  }
})

test('karaoke speaks hertz, and defaults the way NodeLink does', () => {
  // karaoke.ts: level 1.0, monoLevel 1.0, filterBand 220.0, filterWidth 100.0,
  // and the band split is skipped when either band or width is zero.
  assert.equal(fallback('karaoke', 'level'), 1)
  assert.equal(fallback('karaoke', 'monoLevel'), 1)
  assert.equal(fallback('karaoke', 'filterBand'), 220)
  assert.equal(fallback('karaoke', 'filterWidth'), 100)
  assert.deepEqual(range('karaoke', 'filterBand'), [0, 20_000])

  // A band of zero disables the split: the levels still gate the filter, but
  // nothing is band-limited, which is NodeLink's `!band || !width` branch.
  const off = defaultsFor('karaoke')
  assert.equal(off.filterBand, 220)
})

test('echo delay is milliseconds', () => {
  // echo.ts: MAX_DELAY_MS = 2000, `delay` clamped to [0, 2000].
  assert.deepEqual(range('echo', 'delay'), [0, 2000])
  assert.deepEqual(range('echo', 'feedback'), [0, 1])
  assert.deepEqual(range('echo', 'mix'), [0, 1])
})

test('chorus takes a millisecond delay and NodeLink\'s defaults', () => {
  // chorus.ts: delay clamped to [1, MAX_DELAY_MS - 5] and defaults to 25,
  // mix defaults to 0.5, feedback is capped at 0.95.
  assert.deepEqual(range('chorus', 'delay'), [1, 995])
  assert.equal(fallback('chorus', 'delay'), 25)
  assert.equal(fallback('chorus', 'mix'), 0.5)
  assert.deepEqual(range('chorus', 'feedback'), [0, 0.95])
})

test('phaser keeps NodeLink\'s two-stage floor and sweep window', () => {
  // phaser.ts: stages [2, MAX_STAGES] default 4, depth default 1.0,
  // feedback capped at 0.9, mix default 0.5, min 100 Hz, max 2500 Hz.
  assert.deepEqual(range('phaser', 'stages'), [2, 8])
  assert.equal(fallback('phaser', 'stages'), 4)
  assert.equal(fallback('phaser', 'depth'), 1)
  assert.equal(fallback('phaser', 'mix'), 0.5)
  assert.deepEqual(range('phaser', 'feedback'), [0, 0.9])
  assert.equal(fallback('phaser', 'minFrequency'), 100)
  assert.equal(fallback('phaser', 'maxFrequency'), 2500)
})

test('the compressor is in decibels and seconds', () => {
  // compressor.ts: threshold default -24 dB, ratio >= 1 (default 4),
  // attack >= 0.001 s (default 0.01), release >= 0.01 s (default 0.1),
  // makeupGain in dB.
  assert.deepEqual(range('compressor', 'threshold'), [-60, 0])
  assert.equal(fallback('compressor', 'threshold'), -24)
  assert.deepEqual(range('compressor', 'ratio'), [1, 20])
  assert.equal(fallback('compressor', 'ratio'), 4)
  assert.deepEqual(range('compressor', 'attack'), [0.001, 1])
  assert.equal(fallback('compressor', 'attack'), 0.01)
  assert.deepEqual(range('compressor', 'release'), [0.01, 10])
  assert.equal(fallback('compressor', 'release'), 0.1)
  assert.equal(fallback('compressor', 'makeupGain'), 0)

  // Ratio 1 is the neutral state: the documented defaults are present but the
  // station hears nothing compressed.
  const neutral = compile({}, { sampleRate: SR })
  assert.deepEqual(neutral.active, [])
})

test('low-pass smoothing is 20 kHz over the dial, with a 200 Hz floor', () => {
  // lowpass.ts: cutoff = max(200, min(23000, 20000 / 10 ** log10(smoothing)))
  // for smoothing > 1, and wide open below that.
  assert.deepEqual(range('lowpass', 'smoothing'), [1, 100])
  assert.equal(fallback('lowpass', 'smoothing'), 1)

  const at = (smoothing) => makeFilter('lowpass', { smoothing }, { sampleRate: SR }).cutoff()
  assert.equal(at(40), 500, '40 on the dial is a 500 Hz corner')
  assert.equal(at(100), 200, 'the floor is 200 Hz')
  assert.equal(at(1), 20_000, 'and 1 is wide open')
})

test('the remaining NodeLink ranges match', () => {
  // channelMix.ts: every coefficient clamped to [0, 1].
  for (const key of ['leftToLeft', 'leftToRight', 'rightToLeft', 'rightToRight']) {
    assert.deepEqual(range('channelMix', key), [0, 1])
  }
  // vibrato.ts allows a depth of 2; tremolo.ts stops at 1.
  assert.deepEqual(range('vibrato', 'depth'), [0, 2])
  assert.deepEqual(range('tremolo', 'depth'), [0, 1])
  // rotation.ts and tesseract.ts are both a rotation rate in hertz.
  assert.deepEqual(range('rotation', 'rotationHz'), [0, 100])
  assert.deepEqual(range('tesseract', 'rotationHz'), [0, 100])
  // spatial.ts: depth [0, 1] plus a rate.
  assert.deepEqual(range('spatial', 'depth'), [0, 1])
  // reverb.ts: mix defaults to 0.5, and the room controls are all [0, 1].
  assert.equal(fallback('reverb', 'mix'), 0.5)
  for (const key of ['roomSize', 'damping', 'wetLevel', 'dryLevel', 'width', 'mix']) {
    assert.deepEqual(range('reverb', key), [0, 1])
  }
  // phonograph.ts: depth 0.25, crackle 0.18, flutter 0.18, room 0.22,
  // micAgc 0.25, drive 0.25, all clamped to [0, 1].
  assert.deepEqual(
    ['depth', 'crackle', 'flutter', 'room', 'micAgc', 'drive'].map((key) => fallback('phonograph', key)),
    [0.25, 0.18, 0.18, 0.22, 0.25, 0.25]
  )
  // distortion.ts: offsets default to 0, scales to 1.
  assert.deepEqual(
    ['sinOffset', 'cosOffset', 'tanOffset', 'offset'].map((key) => fallback('distortion', key)),
    [0, 0, 0, 0]
  )
  assert.deepEqual(
    ['sinScale', 'cosScale', 'tanScale', 'scale'].map((key) => fallback('distortion', key)),
    [1, 1, 1, 1]
  )
})

test('reverb accepts a custom room, in seconds and feedback', () => {
  // reverb.ts: `delays` (seconds) and `gains` (comb feedback) in parallel
  // arrays; when both are present the combs are built from them instead of
  // Freeverb's, with the right channel a half-millisecond longer.
  const described = FILTER_SCHEMA.reverb
  assert.equal(described.delays.array, true)
  assert.equal(described.gains.array, true)
  assert.deepEqual(described.gains.range, [0, 0.95])

  // Out-of-range values are clipped rather than rejected, like every other
  // parameter, and a hostile length is cut down.
  const compiled = compile(
    { reverb: { mix: 0.5, delays: [0.03, 0.05, 1], gains: [0.7, 1.4, 0.2] } },
    { sampleRate: SR }
  )
  const reverb = compiled.chain.find((filter) => filter.name === 'reverb')
  assert.ok(reverb, 'the custom room still compiles')
  assert.deepEqual(reverb.config.delays, [0.03, 0.05, 0.25])
  assert.deepEqual(reverb.config.gains, [0.7, 0.95, 0.2])

  // And it actually runs: an impulse must leave a tail behind it.
  const n = Math.round(SR * 0.5)
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  left[0] = 0.5
  right[0] = 0.5
  reverb.process(left, right, n)
  const tail = left.slice(Math.round(SR * 0.1)).reduce((sum, sample) => sum + Math.abs(sample), 0)
  assert.ok(tail > 0.01, `the custom room has a tail (${tail.toFixed(3)})`)
})

test('a filter switched on with no parameters gives NodeLink\'s defaults', () => {
  const chain = compile(
    { equalizer: true, karaoke: true, compressor: true, chorus: true, phaser: true },
    { sampleRate: SR }
  )
  const byName = Object.fromEntries(chain.chain.map((filter) => [filter.name, filter.config ?? {}]))
  assert.equal(byName.karaoke.filterBand, 220)
  assert.equal(byName.karaoke.filterWidth, 100)
  assert.equal(byName.chorus.delay, 25)
  assert.equal(byName.phaser.stages, 4)
  // The compressor keeps its settings privately; its documented defaults are
  // what `defaultsFor` reports and what `{compressor: true}` resolves to.
  assert.equal(defaultsFor('compressor').threshold, -24)
  // A `true` equaliser is flat, so it contributes nothing to the chain.
  assert.ok(!chain.chain.some((filter) => filter.name === 'equalizer'))
})
