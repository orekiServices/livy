/**
 * Seam analysis — the four ideas this node took from
 * VertexSelection/automix-engine, and the behaviour they are supposed to
 * produce.
 *
 * automix-engine is a Python pipeline built on CUE-DETR (a cue-point
 * transformer), Demucs (stem separation) and Rubber Band (high-quality
 * stretching). None of that ships here: a radio node renders a seam between
 * two songs in a few hundred milliseconds on a CPU core while the pacer keeps
 * releasing frames. What *does* transfer is the musical reasoning, and these
 * tests pin the four pieces of it:
 *
 *   1. joint tempo-pair selection       (their `select_tempo_pair`)
 *   2. cue snapping to the beat grid    (their `choose_cue`)
 *   3. phrase-aligned blend length      (their 32-beat map)
 *   4. vocal-aware seam shape           (their "do not fade a lyric" rule)
 *
 * Where the reference implementation is available, the constants and the
 * formulas are the same ones. Where it is not — anything that needed stems —
 * the test measures the property that made the original necessary rather than
 * pretending to reproduce the algorithm.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

import {
  beatAlignOffset,
  beatGrid,
  foldTempo,
  phraseBlend,
  phraseBoundary,
  selectTempoPair,
  snapCue,
  tempoCandidates,
  tempoRelease,
  vocalActivity,
  vocalAwareCurves
} from '../src/core/dsp.js'
import { Automix } from '../src/core/automix.js'
import { beatLoop, framesFrom, quietLogs, toMp3 } from './helpers.js'

quietLogs()

const SR = 44_100

const totalMs = (list) => list.reduce((sum, frame) => sum + frame.ms, 0)

/* ------------------------------------------------------------------ *
 * 1. The tempo pair
 * ------------------------------------------------------------------ */

test('the tempo search stays cheap enough to run inside a seam render', () => {
  // A seam renders on the pacer's thread while frames are being released, so
  // the analysis budget is milliseconds, not seconds. The pair search runs two
  // of these; this pins the one that used to be 61 ms.
  // Four seconds is the window the seam actually analyses (`analysePair`
  // truncates to 4 s), so this measures the real unit of work rather than a
  // larger one and then divides by two.
  const audio = beatLoop({ bpm: 128, seconds: 4 })
  tempoCandidates(audio.left, audio.sampleRate) // warm the JIT, as a live node would be

  // Best of several runs, not the mean: this file runs first in the suite and
  // shares one process with 24 others under bun, so an early run can be
  // scheduled against another file's GC. The claim being tested is "this is
  // not the 61 ms O(n·lag) version", and the fastest run measures that.
  let best = Infinity
  for (let i = 0; i < 5; i += 1) {
    const started = performance.now()
    tempoCandidates(audio.left, audio.sampleRate)
    best = Math.min(best, performance.now() - started)
  }
  assert.ok(best < 60, `tempo candidates cost ${best.toFixed(1)} ms for 4 s of audio (best of 5)`)
})

test('tempo candidates are peaks, not shoulders, and agree with the estimator', () => {
  const loop = beatLoop({ bpm: 128, seconds: 10 })
  const candidates = tempoCandidates(loop.left, loop.sampleRate)
  assert.ok(candidates.length >= 1)
  assert.equal(candidates[0].strength, 1, 'the best candidate is normalised to 1')

  const top = candidates[0].bpm
  assert.ok(Math.abs(top - 128) < 2, `expected ~128 BPM, got ${top.toFixed(2)}`)
  // Every candidate is unique enough to be a real peak.
  const bpms = candidates.map((c) => Math.round(c.bpm))
  assert.equal(new Set(bpms).size, bpms.length, 'no duplicated peaks')
  for (let i = 1; i < candidates.length; i += 1) {
    assert.ok(candidates[i].strength <= candidates[i - 1].strength, 'sorted by strength')
  }
})

test('the pair is chosen for agreement, not for confidence', () => {
  // A confident 90 BPM against a confident 92: they agree, and the pair should
  // take them. The same songs against a confident 90 at half time must not win,
  // because the centrality term and the compatibility penalty both push back.
  const pair = selectTempoPair([{ bpm: 90, strength: 1 }], [{ bpm: 92, strength: 1 }])
  assert.deepEqual([pair.bpmA, pair.bpmB], [90, 92])
  assert.ok(pair.compatibility < 0.03)

  const octave = selectTempoPair([{ bpm: 176, strength: 1 }], [{ bpm: 88, strength: 1 }])
  // 176 and 88 are an octave apart: |ln 2| ≈ 0.69. A penalty of 2.5 makes that
  // pair score −1.7 before strengths, so it can only win if nothing else exists.
  assert.ok(octave.compatibility > 0.6)
  assert.ok(octave.score < 0.5, 'an octave-disagreement is penalised')
})

test('the pair search fixes the octave error the scalar estimator makes', async () => {
  // A half-time estimator on a 128 BPM loop reports 64. Folded, that is 128 —
  // but the seam renderer folds *towards the outgoing tempo*, so a pair where
  // both sides land on 64 halves the whole mix. The joint search prefers the
  // pair that agrees on 128.
  const a = beatLoop({ bpm: 128, seconds: 8 })
  const b = beatLoop({ bpm: 130, seconds: 8, freq: 220 })
  const pair = selectTempoPair(tempoCandidates(a.left, SR), tempoCandidates(b.left, SR))
  assert.ok(pair, 'a pair was chosen')
  assert.ok(Math.abs(pair.bpmA - 128) < 2, `A at ~128, got ${pair.bpmA}`)
  assert.ok(Math.abs(pair.bpmB - 130) < 2, `B at ~130, got ${pair.bpmB}`)
  assert.ok(pair.compatibility < 0.03, 'and they agree')
})

test('the automix prefers the pair over a half-time scalar answer', async () => {
  const mix = new Automix(
    { minTrackMs: 3000, crossfadeMs: 2000, maxRenderMs: 8000, effect: 'crossfade', dj: { enabled: false } },
    {}
  )
  await mix.push(framesFrom(await toMp3(beatLoop({ bpm: 128, seconds: 8 })), { id: 'a', title: 'A', artist: 'x' }))
  await mix.push(framesFrom(await toMp3(beatLoop({ bpm: 126, seconds: 9, freq: 220 })), { id: 'b', title: 'B', artist: 'x' }))

  const report = mix.info().last
  assert.ok(report.beat.bpm > 110, `the outgoing tempo is the musical one (${report.beat.bpm})`)
  assert.ok(report.beat.incomingBpm > 110, `the incoming tempo is the musical one (${report.beat.incomingBpm})`)
  // 128 against 126 must be matched, not refused: that is the point of the pair.
  assert.equal(report.beat.matched, true)
  assert.ok(Math.abs(report.beat.stretchPercent) < 5)
})

/* ------------------------------------------------------------------ *
 * 2. Cue snapping
 * ------------------------------------------------------------------ */

test('a cue snaps to the nearest beat and reports how far it moved', () => {
  const beats = beatGrid(SR * 10, SR, 120) // 0.5 s apart
  const period = beats[1] - beats[0]

  const near = snapCue(beats[4] + period * 0.1, beats)
  assert.equal(near.snapped, true)
  assert.equal(near.sample, beats[4], 'moved onto the beat')
  assert.equal(near.beats, 4, 'and says which beat')
  assert.equal(near.distance, 0.1, 'the move is reported as a fraction of a beat')

  // 90 % of a beat past beat 4 is 10 % *before* beat 5, and that is the beat
  // it belongs to — the rule is proximity to the nearest grid line, so the
  // transition lands 26 ms early rather than 212 ms late.
  const far = snapCue(beats[4] + period * 0.9, beats)
  assert.equal(far.beats, 5)
  assert.equal(far.distance, 0.1)
  assert.equal(far.sample, beats[5], 'the next beat, not the previous one')

  // A cue at the exact midpoint is not snapped at all: `tolerance` of 0.5 and
  // less refuses to guess, which is what keeps an ambiguous cue honest.
  const ambiguous = snapCue(beats[4] + period * 0.5, beats, { tolerance: 0.4 })
  assert.equal(ambiguous.snapped, false)

  assert.equal(snapCue(1234, []), null, 'no grid, no snap')
})

test('beats align by a shift smaller than one beat', () => {
  const period = 1000
  assert.equal(beatAlignOffset(period, 120, 40), 80)
  assert.equal(beatAlignOffset(period, 40, 120), 920)

  // A shift that would eat most of what is held is refused: that is a dropped
  // bar. 800 samples of a 900-sample buffer is more than half of it.
  assert.equal(beatAlignOffset(period, 40, 120, 900, { maxFraction: 0.5 }), 0)
  assert.equal(beatAlignOffset(period, 40, 120, 100_000, { maxFraction: 0.5 }), 920)

  // Sub-sample and whole-period shifts are not shifts.
  assert.equal(beatAlignOffset(period, 40, 40), 0)
  assert.equal(beatAlignOffset(0, 1, 2), 0)
})

/* ------------------------------------------------------------------ *
 * 3. Phrase-aligned blends
 * ------------------------------------------------------------------ */

test('blend length is whole phrases, and it follows the tempo', () => {
  const at80 = phraseBlend({ bpm: 80, sampleRate: SR, availableSamples: SR * 30 })
  const at140 = phraseBlend({ bpm: 140, sampleRate: SR, availableSamples: SR * 30 })
  assert.equal(at80.beats % 4, 0, 'a whole number of four-beat phrases')
  assert.equal(at140.beats % 4, 0)
  assert.ok(at80.beats >= 8, 'at least two bars')
  // The same phrase count is a different number of samples at a different tempo.
  assert.ok(at140.samples < at80.samples, 'faster music, shorter blend')
  assert.equal(at80.phrases, at80.beats / 4)

  // Every phrase count is a musical length: 8 beats at 80 BPM is 6 seconds.
  assert.ok(Math.abs(at80.samples / SR - (at80.beats * 60) / 80) < 0.01)

  // Not enough audio: it rounds *down* to a phrase rather than asking for more
  // seconds than exist, because a blend the caller then clamps is not a phrase
  // any more.
  const tight = phraseBlend({ bpm: 120, sampleRate: SR, availableSamples: Math.round(SR * 3.1) })
  assert.equal(tight.beats % 4, 0)
  assert.ok(tight.beats >= 4)
  // 3.1 s at 120 BPM is 6.2 beats: not enough for the shortest musical blend
  // (two bars), so it says so instead of quietly asking for 4 s of audio.
  assert.equal(tight.fits, false)
  const roomy = phraseBlend({ bpm: 120, sampleRate: SR, availableSamples: SR * 10 })
  assert.equal(roomy.fits, true)
  assert.ok(roomy.samples <= SR * 10)

  // A grid without a tempo is not a grid.
  assert.equal(phraseBlend({ bpm: 0 }), null)
})

test('a rendered seam reports a phrase-aligned blend', async () => {
  // The automix holds one crossfade of the outgoing song and waits for the
  // incoming one to arrive before it can render, so the head must be longer
  // than the blend (plus the 2 s of headroom the cue detector uses).
  const mix = new Automix(
    { minTrackMs: 3000, crossfadeMs: 4000, maxRenderMs: 12_000, effect: 'crossfade', dj: { enabled: false } },
    {}
  )
  await mix.push(framesFrom(await toMp3(beatLoop({ bpm: 120, seconds: 12 })), { id: 'a', title: 'A', artist: 'x' }))
  await mix.push(framesFrom(await toMp3(beatLoop({ bpm: 120, seconds: 20, freq: 220 })), { id: 'b', title: 'B', artist: 'x' }))
  const report = mix.info().last
  assert.ok(report, 'a seam was rendered')
  assert.ok(report.beat.phrase, 'the report carries the phrase count')
  assert.equal(report.beat.phrase.beats % 4, 0, `${report.beat.phrase.beats} beats is not a phrase`)
  assert.ok(report.beat.phrase.phrases >= 1)
  // And the reported blend really is that many beats long.
  const beatMs = 60_000 / 120
  assert.ok(Math.abs(report.blendMs - report.beat.phrase.beats * beatMs) < 60)
})

/* ------------------------------------------------------------------ *
 * 4. Tempo release
 * ------------------------------------------------------------------ */

test('tempo release eases from the matched rate back to 1 without a step', () => {
  const from = 126 / 128
  const release = tempoRelease(SR * 20, SR, { fromRate: from, releaseSeconds: 4 })
  assert.equal(release.releaseSamples, SR * 4)

  // Rate starts at the matched ratio and ends at exactly 1.
  assert.ok(Math.abs(release.rateAt(0) - from) < 1e-9)
  assert.equal(release.rateAt(release.releaseSamples), 1)
  assert.equal(release.rateAt(release.releaseSamples * 2), 1, 'and stays there')

  // Monotonic: the fader moves one way, never back.
  let previous = release.rateAt(0)
  for (let i = 1; i <= 64; i += 1) {
    const next = release.rateAt((i / 64) * release.releaseSamples)
    assert.ok(next >= previous - 1e-9, `rate went backwards at ${i}`)
    previous = next
  }

  // Smoothstep, not a ramp: the derivative is zero at both ends, so there is
  // no speed discontinuity where the release starts or finishes.
  const nearStart = release.rateAt(release.releaseSamples * 0.01) - release.rateAt(0)
  const middle = release.rateAt(release.releaseSamples * 0.51) - release.rateAt(release.releaseSamples * 0.49)
  assert.ok(middle > nearStart * 5, 'it accelerates away from the seam')
})

test('a release that is already at native speed is the identity', () => {
  const release = tempoRelease(SR * 10, SR, { fromRate: 1 })
  assert.equal(release.outputLength(SR * 10), SR * 10)
  assert.equal(release.rateAt(1234), 1)
})

/* ------------------------------------------------------------------ *
 * 5. Vocal awareness
 * ------------------------------------------------------------------ */

test('vocal activity finds a voice in the middle of a mix', () => {
  // A 2 kHz tone with no accompaniment: mid-band energy, so it reads as a
  // voice. A 60 Hz tone does not: it is all low band.
  const voice = new Float32Array(SR)
  const bass = new Float32Array(SR)
  for (let i = 0; i < SR; i += 1) {
    voice[i] = Math.sin((2 * Math.PI * 2000 * i) / SR) * 0.4
    bass[i] = Math.sin((2 * Math.PI * 60 * i) / SR) * 0.4
  }
  const sung = vocalActivity(voice, SR)
  const played = vocalActivity(bass, SR)
  assert.equal(sung.active, true, 'a mid-band tone is a vocal')
  assert.equal(played.active, false, 'a 60 Hz tone is not')
})

test('the phrase boundary waits for the line to end and snaps to a beat', () => {
  // 0.5 s of singing, 1 s of silence, at 120 BPM.
  const n = SR * 3
  const audio = new Float32Array(n)
  for (let i = 0; i < SR * 0.5; i += 1) audio[i] = Math.sin((2 * Math.PI * 1500 * i) / SR) * 0.4
  const beats = beatGrid(n, SR, 120)
  const boundary = phraseBoundary(audio, SR, 0, { beats })
  assert.equal(boundary.waited, true, 'it found the gap')
  assert.ok(boundary.sample / SR > 0.4, 'after the line, not during it')
  assert.ok(boundary.sample / SR < 1.0, 'and soon after it')
  assert.equal(boundary.sample % (beats[1] - beats[0]), 0, 'on a beat')
})

test('the seam curves change shape for a vocal, and never mute the bed', () => {
  const plain = vocalAwareCurves({ outgoingActive: false, incomingActive: false })
  assert.equal(plain.shape, 'crossfade')
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const [a, b] = [plain.aGain(t), plain.bGain(t)]
    assert.ok(a >= 0 && a <= 1 && b >= 0 && b <= 1)
  }

  const waiting = vocalAwareCurves({ outgoingActive: true, incomingActive: false, phraseEnd: 0.6 })
  assert.equal(waiting.shape, 'vocal-wait')
  // Mid-phrase the incoming song is held back, and by the end it is full.
  assert.ok(waiting.bGain(0.3) < plain.bGain(0.3), 'the incoming song waits')
  assert.ok(waiting.bGain(1) > 0.9, 'and arrives before the blend ends')
  // The outgoing song is never slashed: this is a transition, not a cut.
  assert.ok(plain.aGain(0.2) > 0.5 && waiting.aGain(0.2) > 0.5)

  const both = vocalAwareCurves({ outgoingActive: true, incomingActive: true })
  assert.equal(both.shape, 'duck-bed')
  assert.ok(both.aGain(0.8) < plain.aGain(0.8), 'the bed is ducked under the new voice')

  const call = vocalAwareCurves({ outgoingActive: false, incomingActive: true })
  assert.equal(call.shape, 'call-response')
})

test('the automix says whether it heard a vocal at the seam', async () => {
  const mix = new Automix(
    { minTrackMs: 3000, crossfadeMs: 3000, maxRenderMs: 9000, effect: 'crossfade', dj: { enabled: false } },
    {}
  )
  await mix.push(framesFrom(await toMp3(beatLoop({ bpm: 120, seconds: 8 })), { id: 'a', title: 'A', artist: 'x' }))
  await mix.push(framesFrom(await toMp3(beatLoop({ bpm: 120, seconds: 9, freq: 220 })), { id: 'b', title: 'B', artist: 'x' }))
  const report = mix.info().last
  assert.ok(report.vocal, 'the report always carries the vocal analysis')
  assert.ok(['crossfade', 'vocal-wait', 'call-response', 'duck-bed'].includes(report.vocal.shape))
  assert.equal(typeof report.vocal.outgoing, 'boolean')
  assert.ok(report.vocal.why.length > 0, 'and says why it chose that shape')
})

/* ------------------------------------------------------------------ *
 * The redesign must not have changed what a seam *is*
 * ------------------------------------------------------------------ */

test('a seam is still seamless: the render joins the programme without a click', async () => {
  // The redesign touches how a seam is *chosen*; the audio that comes out must
  // still be sample-continuous where it meets the air.
  const mix = new Automix(
    { minTrackMs: 3000, crossfadeMs: 2000, maxRenderMs: 8000, effect: 'crossfade', dj: { enabled: false } },
    {}
  )
  const out = []
  out.push(...(await mix.push(framesFrom(await toMp3(beatLoop({ bpm: 124, seconds: 8 })), { id: 'a', title: 'A', artist: 'x' }))))
  out.push(...(await mix.push(framesFrom(await toMp3(beatLoop({ bpm: 124, seconds: 9, freq: 220 })), { id: 'b', title: 'B', artist: 'x' }))))
  const flushed = await mix.flush()
  const all = [...out, ...flushed]
  assert.ok(all.length > 0)

  // Every frame is a real MP3 frame and the total duration is coherent.
  for (const frame of all) {
    assert.ok(frame.data.length > 100, 'a frame is not a stub')
    assert.ok(frame.ms > 20 && frame.ms < 30, `frame duration ${frame.ms}`)
  }
  const ms = totalMs(all)
  assert.ok(ms > 8000, `the whole programme went out (${ms} ms)`)
  // The mix replaced the seam, so it is not simply the two inputs concatenated.
  assert.ok(mix.info().last, 'a seam was rendered')
  assert.equal(mix.info().last.effect, 'crossfade')
  assert.ok(foldTempo(87, 174).bpm === 174)
})
