import test from 'node:test'
import assert from 'node:assert/strict'
import {
  Automix,
  EFFECTS,
  analyzeTrackStructure,
  buildAutomationPlan,
  clearPlanCache,
  encodeMp3,
  evaluateTransition,
  planCacheStats,
  planTransition,
  planTransitionFromAudio
} from '../src/core/automix/index.ts'
import { framesFrom } from './helpers.ts'

const SR = 44100

function synthBeatTrack({
  bpm = 124,
  seconds = 20,
  chord = [220, 261.63, 329.63],
  outroDrop = true
}: {
  bpm?: number
  seconds?: number
  chord?: number[]
  outroDrop?: boolean
} = {}): Float32Array {
  const n = Math.floor(seconds * SR)
  const out = new Float32Array(n)
  const beatSec = 60 / bpm
  for (let i = 0; i < n; i += 1) {
    const t = i / SR
    const frac = i / n
    const env = outroDrop && frac > 0.72 ? 0.4 : frac < 0.22 ? 0.45 : 0.85
    const phase = t % beatSec
    const kick = Math.sin(2 * Math.PI * (55 + 70 * Math.exp(-phase * 40)) * phase) * Math.exp(-phase * 30) * 0.65
    let harm = 0
    for (const f of chord) harm += Math.sin(2 * Math.PI * f * t) * 0.18
    out[i] = Math.max(-0.95, Math.min(0.95, (kick + harm) * env))
  }
  return out
}

test('evaluateTransition scores beat-matched harmonic transitions higher than incompatible clashes', () => {
  const pcmA = synthBeatTrack({ bpm: 124, seconds: 16, chord: [220, 261.63, 329.63] }) // Am
  const pcmBGood = synthBeatTrack({ bpm: 124, seconds: 16, chord: [220, 261.63, 329.63] }) // Am @ 124 BPM
  const pcmBBad = synthBeatTrack({ bpm: 162, seconds: 16, chord: [311.13, 369.99, 466.16] }) // D#m (tritone!) @ 162 BPM

  const sA = analyzeTrackStructure(pcmA, SR, { bypassCache: true })
  const sBGood = analyzeTrackStructure(pcmBGood, SR, { bypassCache: true })
  const sBBad = analyzeTrackStructure(pcmBBad, SR, { bypassCache: true })

  const goodEval = evaluateTransition({
    trackA: sA,
    trackB: sBGood,
    cueOut: sA.mixOutCandidates[0],
    cueIn: sBGood.mixInCandidates[0],
    durationSec: (60 / 124) * 32,
    durationBars: 8,
    beatMatched: true,
    stretchPercent: 0,
    downbeatAligned: true,
    plan: buildAutomationPlan({ strategy: 'bass-swap', beatMatched: true, harmonicScore: 1 })
  })

  const badEval = evaluateTransition({
    trackA: sA,
    trackB: sBBad,
    cueOut: sA.mixOutCandidates[0],
    cueIn: sBBad.mixInCandidates[0],
    durationSec: 4.3,
    durationBars: 0,
    beatMatched: false,
    stretchPercent: 30,
    downbeatAligned: false,
    plan: buildAutomationPlan({ strategy: 'bass-swap', beatMatched: false, harmonicScore: 0.2 }),
    appliedGainDb: 10
  })

  assert.ok(goodEval.overall > badEval.overall + 0.15, `good=${goodEval.overall} vs bad=${badEval.overall}`)
  assert.ok(goodEval.metrics.beatSync > badEval.metrics.beatSync)
  assert.ok(goodEval.metrics.phraseAlignment > badEval.metrics.phraseAlignment)
  assert.ok(badEval.warnings.length >= 1, `bad transition should emit warnings: ${JSON.stringify(badEval.warnings)}`)
})

test('planTransition ranks multiple candidates, caches plans, and falls back gracefully on huge tempo gaps', () => {
  clearPlanCache()
  const a124 = synthBeatTrack({ bpm: 124, seconds: 18, chord: [220, 261.63, 329.63] })
  const b125 = synthBeatTrack({ bpm: 125, seconds: 18, chord: [261.63, 329.63, 392.0] }) // C major (relative to Am)
  const b172 = synthBeatTrack({ bpm: 172, seconds: 18, chord: [311.13, 369.99, 466.16] })

  const good = planTransitionFromAudio(a124, b125, SR, { cacheKey: 'pair:124-125' })
  assert.ok(good.candidates.length >= 2, `generated ${good.candidates.length} candidates`)
  assert.ok(good.selected.evaluation.overall >= good.candidates[good.candidates.length - 1].evaluation.overall)
  assert.equal(good.cached, false)

  // Second call hits plan cache.
  const cached = planTransitionFromAudio(a124, b125, SR, { cacheKey: 'pair:124-125' })
  assert.equal(cached.cached, true)
  assert.ok(planCacheStats().entries >= 1)

  // Huge tempo mismatch triggers graceful smart fallback rather than forcing a broken beatmatch!
  const sA = analyzeTrackStructure(a124, SR, { bypassCache: true })
  const sExtreme = { ...analyzeTrackStructure(b172, SR, { bypassCache: true }), bpm: 172, bpmConfidence: 0.9 }
  const fallback = planTransition(sA, sExtreme, { maxStretchPercent: 10, minBeatMatchQuality: 0.55 })
  assert.equal(fallback.fallbackUsed, true)
  assert.ok(fallback.fallbackReason && fallback.fallbackReason.length > 0)
  assert.ok(['crossfade', 'wash', 'filter', 'echo'].includes(fallback.selected.strategy), `safe fallback strategy: ${fallback.selected.strategy}`)
})

test('Automix engine integrates intelligent planning & continuous blending while preserving API contracts', async () => {
  const pcmA = synthBeatTrack({ bpm: 120, seconds: 8, chord: [220, 261.63, 329.63] })
  const pcmB = synthBeatTrack({ bpm: 120, seconds: 8, chord: [261.63, 329.63, 392.0] })
  const mp3A = await encodeMp3({ left: pcmA, right: pcmA, sampleRate: SR, bitrate: 128 })
  const mp3B = await encodeMp3({ left: pcmB, right: pcmB, sampleRate: SR, bitrate: 128 })
  const framesA = framesFrom(mp3A, { id: 'int-a', title: 'Track A' })
  const framesB = framesFrom(mp3B, { id: 'int-b', title: 'Track B' })

  const mix = new Automix({
    effect: 'auto',
    crossfadeMs: 2500,
    minTrackMs: 3000,
    holdMs: 3500,
    model: false,
    dj: { enabled: false }
  })

  await mix.push(framesA)
  const out = [...(await mix.push(framesB)), ...(await mix.flush())]
  const report = mix.info().last

  assert.ok(report, 'seam report populated')
  assert.ok(EFFECTS.includes(report.effect), `canonical effect "${report.effect}"`)
  assert.equal(report.chosen, true)
  assert.ok(report.peakDb <= -0.9, `peak ceiling respected (${report.peakDb} dBFS)`)
  assert.ok(report.harmony, 'harmony report populated')
  assert.ok(report.harmony.fromCamelot && report.harmony.toCamelot)
  assert.ok(report.structure, 'structure report populated')
  assert.ok(report.quality && typeof report.quality.overall === 'number')
  assert.ok(report.plan && report.plan.candidateCount >= 1)
  assert.ok(out.some((f) => f.track.automix), 'blended seam emitted')
})
