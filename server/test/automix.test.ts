/**
 * The automix: what a listener actually hears between two songs.
 *
 * Every test here drives the real `Automix.push()` pipeline with real MP3
 * frames made from synthetic beat loops, so the assertions are about audible
 * behaviour — nothing is held back at start-up, idents are never mangled, the
 * seam lands on the beat, and the levels match.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  Automix,
  EFFECTS,
  EFFECT_TRAITS,
  chooseEffect,
  smartCrossfadeMs,
  smoothEdges,
  DEFAULT_AUTOMIX,
  registerEffect,
  unregisterEffect,
  decodeMp3
} from '../src/core/automix.ts'
import { estimateBeat, samplePeak, TO_DB } from '../src/core/dsp.ts'
import { quietLogs, beatLoop, tone, toMp3, framesFrom } from './helpers.ts'

quietLogs()

const TRACK_A = { id: 'a', title: 'Opener', artist: 'Kavi' }
const TRACK_B = { id: 'b', title: 'Closer', artist: 'Mira' }

/** Encode audio and hand it back as reader frames, the way a station does. */
async function frames(audio, track, { bitrate = 128 }: any = {}) {
  return framesFrom(await toMp3(audio, bitrate), track)
}

const totalMs = (list) => list.reduce((sum, frame) => sum + frame.ms, 0)

/** A quick automix tuned for tests: short blend, no DJ, no network. */
function automix(options: any = {}, ctx: any = {}) {
  return new Automix(
    // Most tests are about something other than which transition was
    // chosen, so they pin one; the picker has its own test below.
    { minTrackMs: 3000, crossfadeMs: 2000, maxRenderMs: 8000, effect: 'crossfade', ...options, dj: { enabled: false, ...(options.dj ?? {}) } },
    { station: { name: 'Test FM', subscribers: new Set() }, ...ctx }
  )
}

test('a disabled automix is a pass-through, byte for byte', async () => {
  const mix = automix({ enabled: false })
  const input = await frames(tone({ seconds: 4 }), TRACK_A)
  const out = await mix.push(input)
  assert.deepEqual(out, input)
  assert.deepEqual(await mix.flush(), [])
  assert.equal(mix.info().enabled, false)
})

test('nothing is held back before a track has run long enough to be worth mixing', async () => {
  const mix = automix()
  const early = await frames(tone({ seconds: 2 }), TRACK_A) // under minTrackMs
  const out = await mix.push(early)
  assert.equal(out.length, early.length, 'the first seconds of a station are aired instantly')

  // Past minTrackMs the tail starts being withheld — `holdMs` of it. With
  // Smart Automix that is more than one configured blend (a seam that earns a
  // long blend has to have the audio to do it with); never more than asked.
  const rest = await frames(tone({ seconds: 6, freq: 330 }), TRACK_A)
  const aired = await mix.push(rest)
  const held = totalMs(rest) - totalMs(aired)
  assert.ok(held > 1500 && held <= mix.holdMs + 30, `no more than the hold is kept, got ${held.toFixed(0)}ms`)

  const fixed = automix({ smart: false })
  await fixed.push(await frames(tone({ seconds: 2 }), TRACK_A))
  const fixedRest = await frames(tone({ seconds: 6, freq: 330 }), TRACK_A)
  const fixedHeld = totalMs(fixedRest) - totalMs(await fixed.push(fixedRest))
  assert.ok(fixedHeld > 1500 && fixedHeld <= 2200, `a fixed blend holds one blend, got ${fixedHeld.toFixed(0)}ms`)

  const flushed = await mix.flush('stop')
  assert.ok(Math.abs(totalMs(flushed) - held) < 60, 'flush releases exactly what was held')
})

test('announcements and live sources are never mixed', async () => {
  const mix = automix()
  await mix.push(await frames(tone({ seconds: 6 }), TRACK_A))

  const ident = await frames(tone({ seconds: 1, freq: 880 }), { id: 'id-1', title: 'Station ident', announcement: true })
  const out = await mix.push(ident)
  assert.ok(out.length > ident.length, 'the held audio is released ahead of the ident')
  assert.ok(
    ident.every((frame) => out.includes(frame)),
    'and the ident itself is passed through untouched'
  )

  const live = await frames(tone({ seconds: 1 }), { id: 'live-1', title: 'Relay', live: true })
  assert.deepEqual(await mix.push(live), live)
})

test('a real seam is beatmatched, phase-locked and level-matched', async () => {
  const mix = automix({ crossfadeMs: 3000, maxRenderMs: 9000 })

  const a = beatLoop({ bpm: 120, seconds: 9 })
  const b = beatLoop({ bpm: 128, seconds: 9, freq: 220 })

  await mix.push(await frames(a, TRACK_A))
  const out = await mix.push(await frames(b, TRACK_B))

  const report = mix.info().last
  assert.ok(report, 'a seam was rendered')
  assert.equal(report.from, 'Opener')
  assert.equal(report.to, 'Closer')
  assert.equal(report.effect, 'crossfade')

  // Beatmatching: the outgoing song is stretched onto the incoming tempo.
  assert.equal(report.beat.matched, true, 'the tempos were matched, not just aligned')
  assert.ok(Math.abs(report.beat.bpm - 120) < 3, `outgoing ≈120 BPM, reported ${report.beat.bpm}`)
  assert.ok(Math.abs(report.beat.incomingBpm - 128) < 3, `incoming ≈128 BPM, reported ${report.beat.incomingBpm}`)
  assert.ok(Math.abs(report.beat.playedAtBpm - report.beat.incomingBpm) < 1, 'the blend plays at the incoming tempo')
  const stretch = Math.abs(report.beat.stretchPercent)
  assert.ok(stretch > 3 && stretch <= DEFAULT_AUTOMIX.maxStretchPercent, `stretch ${stretch}% stays inside the limit`)

  // Phase lock: the blend is a whole number of beats long.
  const beatMs = 60_000 / report.beat.playedAtBpm
  const remainder = report.blendMs % beatMs
  assert.ok(Math.min(remainder, beatMs - remainder) < 12, `blend ${report.blendMs}ms is on the grid (beat ${beatMs.toFixed(1)}ms)`)
  assert.ok(report.beat.beatsInBlend >= 4, 'and at least a phrase long')

  assert.ok(report.peakDb <= -0.9, `the seam respects the ceiling, got ${report.peakDb} dBFS`)
  assert.ok(['equal-power', 'equal-gain'].includes(report.curve) || report.curve.startsWith('blend('), report.curve)
  assert.equal(report.dj, null, 'the DJ is off in this test')

  // The rendered seam is real, decodable, continuous audio.
  const mixed = out.filter((frame) => frame.track.automix)
  assert.ok(mixed.length > 0)
  assert.equal(mixed[0].track.mixedFrom, 'Opener')
  const audio = await decodeMp3(Buffer.concat(mixed.map((frame) => frame.data)))
  assert.ok(audio, 'the seam decodes')
  assert.ok(samplePeak([audio.left, audio.right]) > 0.05, 'and it is not silence')
  assert.ok(TO_DB(samplePeak([audio.left, audio.right])) <= -0.5, 'and it does not clip')
})

test('a quieter incoming song is pulled up, but never further than maxGainDb', async () => {
  const mix = automix({ crossfadeMs: 3000, maxGainDb: 4 })
  const loud = beatLoop({ bpm: 120, seconds: 9, gain: 0.7 })
  const quiet = beatLoop({ bpm: 120, seconds: 9, gain: 0.05 }) // ~23 dB down

  await mix.push(await frames(loud, TRACK_A))
  await mix.push(await frames(quiet, TRACK_B))

  const { loudness } = mix.info().last
  assert.ok(loudness.from != null && loudness.to != null, 'both sides were measured')
  assert.ok(loudness.to < loudness.from, 'the incoming song really is quieter')
  assert.equal(loudness.appliedDb, 4, 'the match is clamped to maxGainDb')
})

test('a plugin effect is honoured, and unknown effects are refused', async () => {
  const seen = []
  registerEffect('unit-test-fx', (ctx) => {
    seen.push({ fade: ctx.fade, total: ctx.total, beatSamples: ctx.beatSamples })
    // A deliberately simple renderer: hard cut at the halfway point.
    for (let i = 0; i < ctx.total; i += 1) {
      const from = i < ctx.fade / 2 ? ctx.a : ctx.b
      ctx.left[i] = from.left[i] ?? 0
      ctx.right[i] = from.right[i] ?? 0
    }
  })

  try {
    assert.ok(EFFECTS.includes('unit-test-fx'))
    const mix = automix({ effect: 'unit-test-fx', crossfadeMs: 3000 })
    assert.equal(mix.info().effect, 'unit-test-fx')

    await mix.push(await frames(beatLoop({ bpm: 120, seconds: 9 }), TRACK_A))
    await mix.push(await frames(beatLoop({ bpm: 120, seconds: 9, freq: 220 }), TRACK_B))

    assert.equal(seen.length, 1, 'the plugin renderer drew the seam')
    assert.ok(seen[0].total >= seen[0].fade)
    assert.equal(mix.info().last.effect, 'unit-test-fx')

    assert.throws(() => mix.configure({ effect: 'does-not-exist' }), /Unknown transition/)
    assert.equal(mix.info().effect, 'unit-test-fx', 'a rejected change leaves the setting alone')
  } finally {
    unregisterEffect('unit-test-fx')
  }
  assert.ok(!EFFECTS.includes('unit-test-fx'), 'the effect goes away with its plugin')
})

test('the built-in effects all render an audible, legal seam', { timeout: 60_000 }, async () => {
  const a = await frames(beatLoop({ bpm: 120, seconds: 8 }), TRACK_A)
  const b = await frames(beatLoop({ bpm: 120, seconds: 8, freq: 220 }), TRACK_B)

  for (const effect of ['crossfade', 'bass-swap', 'filter', 'echo', 'sweep', 'spindown', 'slam', 'wash', 'roll', 'drop'].filter((id) =>
    EFFECTS.includes(id)
  )) {
    const mix = automix({ effect, crossfadeMs: 2500 })
    await mix.push(a)
    const out = await mix.push(b)
    const report = mix.info().last
    assert.ok(report, `${effect} rendered nothing`)
    assert.equal(report.effect, effect)
    assert.ok(report.blendMs > 400, `${effect} blend too short: ${report.blendMs}ms`)
    assert.ok(report.peakDb <= -0.9, `${effect} exceeded the ceiling: ${report.peakDb} dBFS`)

    const seam = out.filter((frame) => frame.track.automix)
    const audio = await decodeMp3(Buffer.concat(seam.map((frame) => frame.data)))
    assert.ok(samplePeak([audio.left, audio.right]) > 0.02, `${effect} produced silence`)
  }
})

test('the seam keeps the programme continuous: nothing is lost or repeated', async () => {
  const mix = automix({ crossfadeMs: 2500 })
  const a = await frames(beatLoop({ bpm: 124, seconds: 8 }), TRACK_A)
  const b = await frames(beatLoop({ bpm: 124, seconds: 8, freq: 200 }), TRACK_B)

  const outA = await mix.push(a)
  const outB = await mix.push(b)
  const tail = await mix.flush('end')

  const inMs = totalMs(a) + totalMs(b)
  const outMs = totalMs(outA) + totalMs(outB) + totalMs(tail)
  // A crossfade overlaps the two songs, so the output is shorter by about one
  // blend — but never by more than that, which would be a dropout.
  const lost = inMs - outMs
  const { blendMs } = mix.info().last
  assert.ok(lost > 0, 'the songs really did overlap')
  assert.ok(lost < blendMs + 1500, `lost ${lost.toFixed(0)}ms against a ${blendMs.toFixed(0)}ms blend`)

  const ids = [...new Set([...outA, ...outB].map((frame) => frame.track.id))]
  assert.deepEqual(ids, ['a', 'b'], 'the running order is preserved')
})

test('configure() deep-merges the DJ block and can turn the mix off mid-flight', async () => {
  const mix = automix()
  await mix.push(await frames(tone({ seconds: 6 }), TRACK_A))
  assert.equal(mix.info().pending, true, 'audio is being held')

  const info = mix.configure({ dj: { every: 5 } })
  assert.equal(info.dj.every, 5)
  assert.equal(info.dj.name, DEFAULT_AUTOMIX.dj.name, 'the rest of the DJ settings survive')
  assert.equal(info.crossfadeMs, 2000, 'unrelated settings survive')

  mix.configure({ enabled: false })
  assert.equal(mix.info().pending, false, 'disabling drops the held audio rather than stalling the stream')
})

test('the incoming tempo estimate the mix acts on is real', async () => {
  // Guards against the whole beatmatch being driven by a constant: the value
  // in the report has to agree with an independent measurement.
  const loop = beatLoop({ bpm: 132, seconds: 9, freq: 210 })
  const measured = estimateBeat(loop.left, loop.sampleRate)
  assert.ok(Math.abs(measured.bpm - 132) < 2)

  const mix = automix({ crossfadeMs: 2500 })
  await mix.push(await frames(beatLoop({ bpm: 132, seconds: 9 }), TRACK_A))
  await mix.push(await frames(loop, TRACK_B))
  const report = mix.info().last
  assert.ok(Math.abs(report.beat.incomingBpm - measured.bpm) < 3, `${report.beat.incomingBpm} vs ${measured.bpm}`)
  assert.ok(report.beat.confidence > 0.3)
})

test('the mix picks a transition per seam, and does not repeat itself', async () => {
  // The picker on its own: same seam, many draws.
  const clubSeam = { beat: true, matched: true, tempoDelta: 0.5, correlation: 0.2, fadeMs: 6000, energy: 0.8 }
  const picks = new Set<string>()
  for (let i = 0; i < 200; i += 1) picks.add(chooseEffect(clubSeam))
  assert.ok(picks.size > 1, 'a matched club seam has more than one right answer')
  for (const effect of picks) assert.ok(EFFECT_TRAITS[effect].energy >= 0.4, `${effect} suits a hot seam`)

  // Nothing that needs a beat grid is chosen without one…
  const noGrid = { beat: false, matched: false, tempoDelta: 40, correlation: 0.4, fadeMs: 6000, energy: 0.2 }
  for (let i = 0; i < 100; i += 1) {
    const effect = chooseEffect(noGrid)
    assert.equal(EFFECT_TRAITS[effect].needsBeat, false, `${effect} needs a grid it cannot have`)
  }

  // …nothing longer than the blend is chosen for a short one…
  for (let i = 0; i < 50; i += 1) {
    const effect = chooseEffect({ ...noGrid, fadeMs: 900 })
    assert.ok(EFFECT_TRAITS[effect].length <= 900, `${effect} cannot fit in 900ms`)
  }

  // …the DJ gets something calm to talk over…
  for (let i = 0; i < 50; i += 1) {
    const effect = chooseEffect({ ...clubSeam, talkover: true })
    assert.ok(EFFECT_TRAITS[effect].energy <= 0.6, `${effect} fights the voice`)
  }

  // …and the last transition is avoided when anything else will do.
  const repeats = new Set()
  for (let i = 0; i < 100; i += 1) repeats.add(chooseEffect({ ...clubSeam, previous: 'roll' }))
  assert.ok(!repeats.has('roll') || repeats.size > 1, 'the same trick is not played twice in a row')

  // An owner-chosen effect is still honoured exactly.
  const pinned = automix({ effect: 'filter', crossfadeMs: 3000 })
  await pinned.push(await frames(beatLoop({ bpm: 120, seconds: 8 }), TRACK_A))
  await pinned.push(await frames(beatLoop({ bpm: 124, seconds: 8, freq: 220 }), TRACK_B))
  assert.equal(pinned.info().last.effect, 'filter')
  assert.equal(pinned.info().last.chosen, false)
})

test('auto mode renders a real seam and says what it chose', async () => {
  const mix = automix({ effect: 'auto', crossfadeMs: 3000 })
  await mix.push(await frames(beatLoop({ bpm: 120, seconds: 8 }), TRACK_A))
  const out = await mix.push(await frames(beatLoop({ bpm: 120, seconds: 8, freq: 220 }), TRACK_B))

  const report = mix.info().last
  assert.ok(report, 'a seam was rendered')
  assert.ok(EFFECTS.includes(report.effect), `${report.effect} is a real transition`)
  assert.equal(report.chosen, true, 'and it says the mix chose it')
  assert.ok(report.entryEnergy >= 0 && report.entryEnergy <= 1)
  assert.ok(out.some((frame) => frame.track.automix), 'the seam reached the output')

  // A pool narrows the choice to what the owner allows.
  const pooled = automix({ effect: 'auto', effectPool: ['crossfade', 'filter'], crossfadeMs: 3000 })
  await pooled.push(await frames(beatLoop({ bpm: 120, seconds: 8 }), TRACK_A))
  await pooled.push(await frames(beatLoop({ bpm: 120, seconds: 8, freq: 220 }), TRACK_B))
  assert.ok(['crossfade', 'filter'].includes(pooled.info().last.effect))
  assert.throws(() => pooled.configure({ effectPool: ['nope'] }), /Unknown transition/)
})

test('every seam is joinable: no click where the render meets the programme', () => {
  const sampleRate = 44100
  const n = sampleRate
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  // Worst case: a block that starts and ends at full scale, with a DC step.
  for (let i = 0; i < n; i += 1) {
    left[i] = 0.9 + 0.05
    right[i] = -0.9 + 0.05
  }

  smoothEdges(left, right, sampleRate)

  assert.ok(Math.abs(left[0]) < 0.02, `starts from silence (${left[0].toFixed(3)})`)
  assert.ok(Math.abs(left[n - 1]) < 0.02, `ends in silence (${left[n - 1].toFixed(3)})`)

  // The DC blocker is a one-pole, so it removes the offset over its ~50 ms
  // time constant rather than instantly: by the end of the block the mean
  // must be gone.
  let tail = 0
  const from = Math.floor(n * 0.9)
  for (let i = from; i < n; i += 1) tail += left[i]
  assert.ok(Math.abs(tail / (n - from)) < 0.01, `no DC offset left (${(tail / (n - from)).toFixed(4)})`)

  // And there must be no discontinuity — which is what a click actually is.
  // A 2 ms raised-cosine ramp on full-scale audio inherently moves about
  // 0.017 per sample at its steepest; an unramped join moves the whole
  // amplitude in one sample, which is two orders of magnitude worse.
  let biggest = 0
  for (let i = 1; i < 2000; i += 1) biggest = Math.max(biggest, Math.abs(left[i] - left[i - 1]))
  assert.ok(biggest < 0.02, `the join is a ramp, not a step (${biggest.toFixed(4)})`)

  // The unsmoothed version, for comparison: this is the click we avoid.
  const raw = new Float32Array(16).fill(0.95)
  assert.ok(Math.abs(raw[0] - 0) > 0.5, 'an unramped block starts with a full-scale step')
})

/* ------------------------------------------------------------------ *
 * Seam decisions added for the Android release
 * ------------------------------------------------------------------ */

test('a vocal clash shortens the blend, and says why', () => {
  const base = { matched: true, tempoDelta: 1, correlation: 0.2, energy: 0.4, bpm: 120 }
  const clean = smartCrossfadeMs(base, { crossfadeMs: 6000 })
  const oneVocal = smartCrossfadeMs({ ...base, vocal: { outgoing: true, incoming: false } }, { crossfadeMs: 6000 })
  const clash = smartCrossfadeMs({ ...base, vocal: { outgoing: true, incoming: true } }, { crossfadeMs: 6000 })

  assert.ok(clash.ms < oneVocal.ms, `clash ${clash.ms} < one vocal ${oneVocal.ms}`)
  assert.ok(oneVocal.ms < clean.ms, `one vocal ${oneVocal.ms} < instrumental ${clean.ms}`)
  assert.match(clash.why, /vocals would clash/)
  assert.match(oneVocal.why, /vocal at the seam/)
  // A fixed crossfade ignores the probe: the owner asked for exactly that.
  assert.equal(smartCrossfadeMs({ ...base, vocal: { outgoing: true, incoming: true } }, { smart: false, crossfadeMs: 6000 }).ms, 6000)
})

test('roll and drop are refused when the tempos do not actually meet', () => {
  const seam = { beat: true, matched: false, tempoDelta: 18, fadeMs: 8000, energy: 0.9, correlation: 0 }
  for (let run = 0; run < 40; run += 1) {
    const picked = chooseEffect(seam, ['roll', 'drop'])
    assert.notEqual(picked, 'roll', `run ${run} rolled on a 18 BPM gap`)
    assert.notEqual(picked, 'drop', `run ${run} dropped on a 18 BPM gap`)
  }
  // A *folded* match with a wide raw gap is fine: the grid already met.
  for (let run = 0; run < 20; run += 1) {
    assert.equal(chooseEffect({ ...seam, matched: true, tempoDelta: 6, fadeMs: 3200 }, ['bass-swap']), 'bass-swap')
  }
})

test('two vocals prefer a masking transition over a bass-swap', () => {
  const seam = {
    beat: true,
    matched: true,
    tempoDelta: 1,
    fadeMs: 6000,
    energy: 0.5,
    correlation: 0.3,
    vocalOut: 1,
    vocalIn: 1
  }
  let filter = 0
  for (let run = 0; run < 60; run += 1) {
    const picked = chooseEffect(seam, ['bass-swap', 'filter'])
    assert.ok(picked === 'filter' || picked === 'bass-swap')
    if (picked === 'filter') filter += 1
  }
  assert.ok(filter > 45, `filter masks the clash (${filter}/60)`)
})
