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
  GetSongBpmServiceError,
  decodeMp3
} from '../src/core/automix/index.ts'
import { estimateBeat, samplePeak, TO_DB } from '../src/core/dsp/index.ts'
import { quietLogs, beatLoop, tone, toMp3, framesFrom } from './helpers.ts'

quietLogs()

const TRACK_A = { id: 'a', title: 'Opener', artist: 'Kavi' }
const TRACK_B = { id: 'b', title: 'Closer', artist: 'Mira' }
const testTempos = new Map<string, number>()

/** Encode audio and hand it back as reader frames, the way a station does. */
async function frames(audio, track, { bitrate = 128 }: any = {}) {
  if (track?.id && Number.isFinite(audio?.bpm)) testTempos.set(String(track.id), audio.bpm)
  return framesFrom(await toMp3(audio, bitrate), track)
}

async function testTempoLookup(track) {
  const tempo = testTempos.get(String(track?.id)) ?? Number(track?.tempo) ?? 120
  return { tempo, confidence: 1, id: `test:${track?.id ?? 'unknown'}`, title: track?.title ?? '', artist: track?.artist ?? null, uri: null }
}

const totalMs = (list) => list.reduce((sum, frame) => sum + frame.ms, 0)

/** A quick automix tuned for tests: short blend, no DJ, no network. */
function automix(options: any = {}, ctx: any = {}) {
  return new Automix(
    // Most tests are about something other than which transition was
    // chosen, so they pin one; the picker has its own test below.
    { minTrackMs: 3000, crossfadeMs: 2000, maxRenderMs: 8000, effect: 'crossfade', ...options, dj: { enabled: false, ...(options.dj ?? {}) } },
    { station: { name: 'Test FM', subscribers: new Set() }, getSongBpmTempo: testTempoLookup, ...ctx }
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
  assert.equal(report.beat.source, 'GetSongBPM')
  assert.equal(report.beat.serviceConfidence, 1)

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


test('GetSongBPM supplies the tempo while local analysis contributes phase only', async () => {
  const mix = automix({ crossfadeMs: 2500 }, {
    getSongBpmTempo: async (track) => ({
      tempo: track?.id === TRACK_A.id ? 116 : 124,
      confidence: 0.99,
      id: `service:${track?.id}`,
      title: track?.title,
      artist: track?.artist,
      uri: null
    })
  })

  await mix.push(await frames(beatLoop({ bpm: 120, seconds: 9 }), TRACK_A))
  await mix.push(await frames(beatLoop({ bpm: 128, seconds: 9, freq: 220 }), TRACK_B))
  const beat = mix.info().last.beat

  assert.equal(beat.source, 'GetSongBPM')
  assert.equal(beat.bpm, 116)
  assert.equal(beat.incomingBpm, 124)
  assert.equal(beat.serviceConfidence, 0.99)
  assert.ok(beat.confidence > 0.25, 'the local phase estimate is independently usable')
  assert.equal(beat.bpmi.model, 'BPMi')
  assert.equal(beat.bpmi.backend, 'cpu')
  assert.equal(beat.bpmi.profiles.outgoing.referenceBpm, 116)
  assert.equal(beat.bpmi.profiles.incoming.referenceBpm, 124)
  assert.ok(beat.bpmi.profiles.outgoing.candidates.length > 0, 'BPMi captures local tempo candidates for seam training')
  assert.equal(beat.matched, true)
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

test('only the built-in crossfade can be configured or registered', async () => {
  assert.deepEqual([...EFFECTS], ['crossfade'])

  const retiredModels = automix({ model: true, continuousBlend: true, neuralAutomix: true })
  assert.equal(retiredModels.info().model, false)
  assert.equal(retiredModels.info().continuousBlend, false)
  assert.equal(retiredModels.info().neuralAutomix, false)
  retiredModels.configure({ model: true, continuousBlend: true, neuralAutomix: true })
  assert.equal(retiredModels.info().model, false, 'persisted and live settings cannot re-enable the effect classifier')
  assert.throws(() => registerEffect('unit-test-fx', () => {}), /supports crossfade only/)
  assert.equal(unregisterEffect('crossfade'), false, 'the built-in renderer is immutable')
  assert.equal(chooseEffect({ tempoDelta: 50 }), 'crossfade')

  const legacy = automix({ effect: 'filter' })
  assert.equal(legacy.info().effect, 'auto', 'legacy persisted effects migrate to auto-crossfade')
  assert.throws(() => legacy.configure({ effect: 'filter' }), /supports crossfade only/)

  const automatic = automix({ effect: 'auto' })
  await automatic.push(await frames(beatLoop({ bpm: 120, seconds: 8 }), TRACK_A))
  await automatic.push(await frames(beatLoop({ bpm: 120, seconds: 8, freq: 220 }), TRACK_B))
  assert.equal(automatic.info().last.effect, 'crossfade')
  assert.equal(automatic.info().last.chosen, true)

  const pinned = automix({ effect: 'crossfade' })
  await pinned.push(await frames(beatLoop({ bpm: 120, seconds: 8 }), TRACK_A))
  await pinned.push(await frames(beatLoop({ bpm: 120, seconds: 8, freq: 220 }), TRACK_B))
  assert.equal(pinned.info().last.effect, 'crossfade')
  assert.equal(pinned.info().last.chosen, false)
})

test('a GetSongBPM failure is reported and a safe crossfade stays on air', async () => {
  const serviceError = new GetSongBpmServiceError('rate_limited', 'GetSongBPM service error: request limit reached.', 429)
  const mix = automix({ effect: 'auto', crossfadeMs: 2500 }, {
    getSongBpmTempo: async () => { throw serviceError }
  })

  await mix.push(await frames(beatLoop({ bpm: 120, seconds: 8 }), TRACK_A))
  const output = await mix.push(await frames(beatLoop({ bpm: 120, seconds: 8, freq: 220 }), TRACK_B))
  const report = mix.info().last

  assert.ok(report, 'the seam is still rendered')
  assert.equal(report.effect, 'crossfade')
  assert.equal(report.fallback.effect, 'crossfade')
  assert.equal(report.fallback.serviceError.service, 'GetSongBPM')
  assert.equal(report.fallback.serviceError.code, 'rate_limited')
  assert.equal(report.serviceError.status, 429)
  assert.match(report.fallback.reason, /GetSongBPM service error/)

  const seam = output.filter((frame) => frame.track.automix)
  assert.ok(seam.length > 0, 'the safe crossfade reached the output')
  const audio = await decodeMp3(Buffer.concat(seam.map((frame) => frame.data)))
  assert.ok(samplePeak([audio.left, audio.right]) > 0.02, 'fallback audio is audible')
})

test('the built-in effects all render an audible, legal seam', { timeout: 60_000 }, async () => {
  const a = await frames(beatLoop({ bpm: 120, seconds: 8 }), TRACK_A)
  const b = await frames(beatLoop({ bpm: 120, seconds: 8, freq: 220 }), TRACK_B)

  for (const effect of EFFECTS) {
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

test('the crossfade policy has one answer for every seam shape', () => {
  const seams = [
    { beat: false, matched: false, tempoDelta: 40, correlation: 0.4, fadeMs: 6000, energy: 0.2 },
    { beat: true, matched: true, tempoDelta: 0.5, correlation: 0.2, fadeMs: 6000, energy: 0.8, talkover: true },
    { beat: true, matched: false, tempoDelta: 18, fadeMs: 8000, energy: 0.9, correlation: 0 }
  ]
  for (const seam of seams) assert.equal(chooseEffect(seam), 'crossfade')
  assert.deepEqual(Object.keys(EFFECT_TRAITS), ['crossfade'])
})

test('auto mode renders the only supported seam and reports the compatibility choice', async () => {
  const mix = automix({ effect: 'auto', crossfadeMs: 3000 })
  await mix.push(await frames(beatLoop({ bpm: 120, seconds: 8 }), TRACK_A))
  const out = await mix.push(await frames(beatLoop({ bpm: 120, seconds: 8, freq: 220 }), TRACK_B))

  const report = mix.info().last
  assert.ok(report, 'a seam was rendered')
  assert.deepEqual([...EFFECTS], ['crossfade'])
  assert.equal(report.effect, 'crossfade')
  assert.equal(report.chosen, true, 'auto remains a compatibility sentinel')
  assert.ok(report.entryEnergy >= 0 && report.entryEnergy <= 1)
  assert.ok(out.some((frame) => frame.track.automix), 'the seam reached the output')

  const compatiblePool = automix({ effect: 'auto', effectPool: ['crossfade'], crossfadeMs: 3000 })
  await compatiblePool.push(await frames(beatLoop({ bpm: 120, seconds: 8 }), TRACK_A))
  await compatiblePool.push(await frames(beatLoop({ bpm: 120, seconds: 8, freq: 220 }), TRACK_B))
  assert.equal(compatiblePool.info().last.effect, 'crossfade')
  assert.throws(() => compatiblePool.configure({ effectPool: ['filter'] }), /supports crossfade only/)
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

test('legacy transition names cannot leak into the crossfade policy', () => {
  for (const name of ['roll', 'drop', 'bass-swap', 'filter', 'echo', 'wash']) {
    assert.equal(EFFECTS.includes(name), false, `${name} is no longer exposed`)
    assert.throws(() => automix().configure({ effect: name }), /supports crossfade only/)
  }
})

test('vocal information may adjust fade timing but cannot select another effect', () => {
  const seam = { beat: true, matched: true, tempoDelta: 1, fadeMs: 6000, energy: 0.5, vocalOut: 1, vocalIn: 1, bpm: 120 }
  assert.equal(chooseEffect(seam), 'crossfade')
  const clean = smartCrossfadeMs(seam, { crossfadeMs: 6000 })
  const clash = smartCrossfadeMs({ ...seam, vocal: { outgoing: true, incoming: true } }, { crossfadeMs: 6000 })
  assert.ok(clash.ms < clean.ms, 'vocal clash shortens the crossfade relative to the clean seam')
})
