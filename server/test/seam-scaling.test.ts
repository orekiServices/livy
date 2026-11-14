import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  AUTOMIX_STRATEGIES,
  SEAM_SCALING_TIERS,
  estimatePolicyParams,
  recordSeam,
  resolveScalingTier,
  runDjTrainingPipeline,
  scalingLadderSummary,
  trainModel,
  type ExtractedTransitionExample
} from '../src/core/models/index.ts'
import { trainingProfile } from '../src/core/models/device.ts'
import {
  analyzeTrackStructure,
  buildAutomationPlan,
  planTransition,
  renderContinuousBlend
} from '../src/core/automix/index.ts'
import { tmpdir, quietLogs } from './helpers.ts'

quietLogs()

const SR = 44100

function synthBeatTrack(bpm: number, seconds: number, chord: number[], vocal = false): Float32Array {
  const n = Math.floor(seconds * SR)
  const out = new Float32Array(n)
  const beatSec = 60 / bpm
  for (let i = 0; i < n; i += 1) {
    const t = i / SR
    const phase = t % beatSec
    const kick = Math.sin(2 * Math.PI * (55 + 65 * Math.exp(-phase * 38)) * phase) * Math.exp(-phase * 30) * 0.55
    let harm = 0
    for (const f of chord) harm += Math.sin(2 * Math.PI * f * t) * 0.16
    const voc = vocal ? Math.sin(2 * Math.PI * 1150 * t + 2 * Math.sin(2 * Math.PI * 5 * t)) * 0.16 : 0
    out[i] = Math.max(-0.95, Math.min(0.95, kick + harm + voc))
  }
  return out
}

test('SEAM_SCALING_TIERS enforces strictly monotonic scaling: more seams -> more transitions -> more parameters', () => {
  assert.ok(SEAM_SCALING_TIERS.length >= 6)

  let prevSeams = -1
  let prevTransitions = 0
  let prevKnots = 0
  let prevCandidates = 0
  let prevPolicyParams = 0
  let prevNeuralParams = 0
  const prevSet = new Set<string>()

  for (const tier of SEAM_SCALING_TIERS) {
    const resolved = resolveScalingTier(tier.minSeams)
    assert.equal(resolved.id, tier.id)
    assert.ok(tier.minSeams > prevSeams, `${tier.id} minSeams increases`)
    assert.ok(resolved.unlockedCount >= prevTransitions, `${tier.id} unlocked transitions non-decreasing`)
    assert.ok(resolved.knots >= prevKnots, `${tier.id} automation knots non-decreasing`)
    assert.ok(resolved.maxCandidates > prevCandidates, `${tier.id} candidate breadth increases`)
    assert.ok(resolved.policyParams > prevPolicyParams, `${tier.id} policy params increase (${resolved.policyParams} > ${prevPolicyParams})`)
    assert.ok(resolved.neuralParams > prevNeuralParams, `${tier.id} neural params increase (${resolved.neuralParams} > ${prevNeuralParams})`)
    assert.ok(resolved.neuralParams >= 1_000 && resolved.neuralParams <= 5_000_000, `${tier.id} stays within 1K..5M budget`)

    // Cumulative: every previously unlocked strategy remains unlocked in higher tiers.
    for (const s of prevSet) {
      assert.ok(resolved.unlockedStrategies.includes(s as any), `${tier.id} retains strategy "${s}"`)
    }
    for (const s of resolved.unlockedStrategies) prevSet.add(s)

    prevSeams = tier.minSeams
    prevTransitions = resolved.unlockedCount
    prevKnots = resolved.knots
    prevCandidates = resolved.maxCandidates
    prevPolicyParams = resolved.policyParams
    prevNeuralParams = resolved.neuralParams
  }

  // Top tier unlocks the complete 16-transition repertoire.
  assert.equal(prevTransitions, AUTOMIX_STRATEGIES.length)
  assert.equal(AUTOMIX_STRATEGIES.length, 16)

  // Mobile hosts cap gracefully at resident tier so Termux stays fast & cool.
  const mobileHigh = resolveScalingTier(50_000, { mobile: true })
  assert.equal(mobileHigh.id, 'resident')
  assert.equal(mobileHigh.mobileCapped, true)
  assert.ok(mobileHigh.neuralParams < 30_000)

  const summary = scalingLadderSummary(400)
  assert.equal(summary.tier, 'resident')
  assert.equal(summary.nextTier?.id, 'pro')
  assert.equal(summary.nextTier?.seamsRemaining, 200)
})

test('all 4 new continuous transition archetypes render cleanly without clipping or NaNs', () => {
  const fade = SR * 2
  const total = SR * 3
  const pcmA = synthBeatTrack(124, 3, [220, 261.63, 329.63], true)
  const pcmB = synthBeatTrack(124, 3, [261.63, 329.63, 392.0], false)

  for (const strategy of ['phrase-cut', 'vocal-bridge', 'tempo-ramp', 'harmonic-drop'] as const) {
    const plan = buildAutomationPlan({
      strategy,
      vocalOut: 0.85,
      vocalIn: 0.25,
      harmonicScore: 0.92,
      beatMatched: true,
      knots: 12
    })
    assert.equal(plan.curves.knots, 12)
    const left = new Float32Array(total)
    const right = new Float32Array(total)
    renderContinuousBlend({
      a: { left: pcmA, right: pcmA, sampleRate: SR, length: total },
      b: { left: pcmB, right: pcmB, sampleRate: SR, length: total },
      left,
      right,
      fade,
      total,
      sampleRate: SR,
      beatSamples: Math.round((60 / 124) * SR),
      plan
    })

    let peak = 0
    for (let i = 0; i < total; i += 1) {
      assert.ok(Number.isFinite(left[i]) && Number.isFinite(right[i]), `${strategy} sample finite`)
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
    }
    assert.ok(peak > 0.1 && peak <= 1.0, `${strategy} legal peak=${peak.toFixed(3)}`)
  }
})

test('planTransition with progressiveScaling widens unlocked transitions and knot resolution as seamCount grows', () => {
  const sA = analyzeTrackStructure(synthBeatTrack(124, 14, [220, 261.63, 329.63], true), SR, { bypassCache: true })
  const sB = analyzeTrackStructure(synthBeatTrack(124, 14, [261.63, 329.63, 392.0], false), SR, { bypassCache: true })

  const low = planTransition(sA, sB, { seamCount: 15, progressiveScaling: true, bypassCache: true })
  const high = planTransition(sA, sB, { seamCount: 10_000, progressiveScaling: true, bypassCache: true })

  assert.equal(low.scaling?.id, 'bootstrap')
  assert.equal(high.scaling?.id, 'festival')
  assert.ok(high.scaling!.unlockedCount > low.scaling!.unlockedCount)
  assert.ok(high.scaling!.knots > low.scaling!.knots)
  assert.ok(high.selected.plan.curves.knots > low.selected.plan.curves.knots)
  // At bootstrap tier, every candidate strategy must belong to the 4 unlocked core transitions.
  for (const cand of low.candidates) {
    assert.ok(
      low.scaling!.unlockedStrategies.includes(cand.strategy as any),
      `bootstrap candidate "${cand.strategy}" is within unlocked transitions`
    )
  }
})

test('v1 trainer and trainingProfile automatically scale parameters with seam log size when preset is auto', async () => {
  const server = { mobile: false, profile: 'server', termux: false }
  const smallProfile = trainingProfile({ host: server, preset: 'auto', seams: 25 })
  const largeProfile = trainingProfile({ host: server, preset: 'auto', seams: 3_000 })

  assert.ok(
    estimatePolicyParams(largeProfile.shapes[0]) > estimatePolicyParams(smallProfile.shapes[0]),
    `3,000 seams scales policy params (${estimatePolicyParams(largeProfile.shapes[0])} > ${estimatePolicyParams(smallProfile.shapes[0])})`
  )

  const dir = tmpdir('scale-v1-')
  const smallFile = path.join(dir, 'small.jsonl')
  const medFile = path.join(dir, 'med.jsonl')
  const writeSeams = (file: string, count: number) => {
    for (let i = 0; i < count; i += 1) {
      recordSeam(
        {
          bpmOut: 120 + (i % 8),
          bpmIn: 120 + ((i + 1) % 8),
          matched: i % 2 === 0,
          correlation: 0.4,
          loudnessGap: 0.5,
          energy: 0.6,
          fadeMs: 6000,
          effect: i % 2 === 0 ? 'bass-swap' : 'crossfade',
          baseline: 'crossfade',
          outcome: 'completed'
        },
        { file }
      )
    }
  }
  writeSeams(smallFile, 30)
  writeSeams(medFile, 240)

  const rSmall = await trainModel({ file: smallFile, preset: 'auto', activate: false, saveDir: tmpdir('m-s-'), gpu: false, epochs: 8 })
  const rMed = await trainModel({ file: medFile, preset: 'auto', activate: false, saveDir: tmpdir('m-m-'), gpu: false, epochs: 8 })

  assert.equal(rSmall.trained, true)
  assert.equal(rMed.trained, true)
  assert.equal(rSmall.scaling.tier, 'bootstrap')
  assert.equal(rMed.scaling.tier, 'resident')
  assert.ok(rMed.best.parameters > rSmall.best.parameters, `resident (${rMed.best.parameters}p) > bootstrap (${rSmall.best.parameters}p)`)
})

test('v2 runDjTrainingPipeline with preset auto scales neural architecture parameters with real DJ transition count', async () => {
  const makeExamples = (count: number): ExtractedTransitionExample[] =>
    Array.from({ length: count }, (_, idx) => {
      const strat = idx % 4
      return {
        exampleId: `ex-${idx}`,
        mixId: `mix-${idx % 5}`,
        trackAId: `a-${idx}`,
        trackBId: `b-${idx}`,
        provenance: { source: 'real-dj-mix', license: 'CC-BY-4.0', alignmentConfidence: 0.9, extractedAt: Date.now() },
        alignment: {
          mixOverlapStartSec: 40,
          mixOverlapEndSec: 56,
          trackAMixOutSec: 170,
          trackBMixInSec: 12,
          durationSec: 16,
          durationBars: 8,
          tempoRatioA: 1,
          tempoRatioB: 1,
          confidenceA: 0.9,
          confidenceB: 0.9
        },
        diagnostics: {
          observedStrategy: 'bass-swap',
          bassSwapAt: 0.5,
          bassSwapWidth: 0.12,
          residualEnergyRatio: 0.04,
          reconstructionR2: 0.92,
          vocalOverlapRatio: 0.02
        },
        input: {
          pair: Array.from({ length: 32 }, (_, j) => Math.sin(j * 0.3 + strat) * 0.5 + 0.5),
          seqA: Array.from({ length: 16 }, () => new Array(16).fill(0.3)),
          seqB: Array.from({ length: 16 }, () => new Array(16).fill(0.3))
        },
        target: {
          stage1: [0.75, 0.15, 0.33, 0.9, 0.9],
          strategyIndex: strat,
          automation: [0.5, 0.12, ...new Array(14 * 8).fill(0.4)]
        }
      }
    })

  const smallRun = await runDjTrainingPipeline({
    examples: makeExamples(16),
    preset: 'auto',
    epochs: 5,
    batchSize: 8,
    backend: 'ts'
  })
  const clubRun = await runDjTrainingPipeline({
    examples: makeExamples(68),
    preset: 'auto',
    epochs: 5,
    batchSize: 16,
    backend: 'ts'
  })

  assert.equal(smallRun.scaling.id, 'bootstrap')
  assert.equal(clubRun.scaling.id, 'club')
  assert.equal(smallRun.scaling.neuralPreset, 'mlp-nano')
  assert.equal(clubRun.scaling.neuralPreset, 'mlp-micro')
  assert.ok(clubRun.parameterCount > smallRun.parameterCount, `club (${clubRun.parameterCount}p) > bootstrap (${smallRun.parameterCount}p)`)
})
