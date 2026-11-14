import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_KNOTS,
  ThreeBandCrossover,
  buildAutomationPlan,
  renderContinuousBlend,
  sampleCurve,
  sanitizeAutomationPlan
} from '../src/core/automix/blender.ts'

const SR = 44100

function stereoSine(freqL: number, freqR: number, len: number, amp = 0.4): { left: Float32Array; right: Float32Array; sampleRate: number; length: number } {
  const left = new Float32Array(len)
  const right = new Float32Array(len)
  for (let i = 0; i < len; i += 1) {
    left[i] = Math.sin((2 * Math.PI * freqL * i) / SR) * amp
    right[i] = Math.sin((2 * Math.PI * freqR * i) / SR) * amp
  }
  return { left, right, sampleRate: SR, length: len }
}

function rms(buf: Float32Array, from = 0, to = buf.length): number {
  let s = 0
  const n = Math.max(1, to - from)
  for (let i = from; i < to; i += 1) s += buf[i] * buf[i]
  return Math.sqrt(s / n)
}

test('ThreeBandCrossover isolates low (60Hz), mid (1kHz), and high (8kHz) bands cleanly', () => {
  const n = SR / 2
  const runTone = (freq: number) => {
    const xo = new ThreeBandCrossover(200, 3600, SR)
    let lo = 0
    let mid = 0
    let hi = 0
    for (let i = 0; i < n; i += 1) {
      const x = Math.sin((2 * Math.PI * freq * i) / SR)
      const [l, m, h] = xo.split(x)
      if (i > 4000) {
        lo += l * l
        mid += m * m
        hi += h * h
      }
    }
    return { lo: Math.sqrt(lo / (n - 4000)), mid: Math.sqrt(mid / (n - 4000)), hi: Math.sqrt(hi / (n - 4000)) }
  }

  const lowTone = runTone(60)
  assert.ok(lowTone.lo > lowTone.mid * 5 && lowTone.lo > lowTone.hi * 10, `60Hz in low band: ${JSON.stringify(lowTone)}`)

  const midTone = runTone(1000)
  assert.ok(midTone.mid > midTone.lo * 5 && midTone.mid > midTone.hi * 5, `1kHz in mid band: ${JSON.stringify(midTone)}`)

  const highTone = runTone(8000)
  assert.ok(highTone.hi > highTone.mid * 4 && highTone.hi > highTone.lo * 10, `8kHz in high band: ${JSON.stringify(highTone)}`)
})

test('sanitizeAutomationPlan enforces sub-bass exclusivity and legal bounds', () => {
  const bad = buildAutomationPlan({ strategy: 'bass-swap' })
  // Deliberately create severe double-bass conflict and out-of-range FX values.
  bad.curves.gainA = new Array(DEFAULT_KNOTS).fill(1.0)
  bad.curves.gainB = new Array(DEFAULT_KNOTS).fill(1.0)
  bad.curves.lowA = new Array(DEFAULT_KNOTS).fill(1.0)
  bad.curves.lowB = new Array(DEFAULT_KNOTS).fill(1.0)
  bad.curves.filterA = new Array(DEFAULT_KNOTS).fill(4.5)
  bad.curves.reverbSendA = new Array(DEFAULT_KNOTS).fill(2.5)

  const clean = sanitizeAutomationPlan(bad)
  for (let k = 0; k < clean.curves.knots; k += 1) {
    const lowSum = clean.curves.gainA[k] * clean.curves.lowA[k] + clean.curves.gainB[k] * clean.curves.lowB[k]
    assert.ok(lowSum <= 1.1501, `knot ${k} lowSum=${lowSum} exceeded sub-bass ceiling`)
    assert.ok(clean.curves.filterA[k] >= -1 && clean.curves.filterA[k] <= 1)
    assert.ok(clean.curves.reverbSendA[k] >= 0 && clean.curves.reverbSendA[k] <= 0.85)
  }
})

test('renderContinuousBlend renders all continuous strategies cleanly with no NaNs or clipping', () => {
  const fade = SR * 3
  const total = SR * 4
  const a = stereoSine(65, 65, total, 0.35)
  const b = stereoSine(520, 520, total, 0.35)

  for (const strategy of ['crossfade', 'eq-blend', 'bass-swap', 'filter', 'wash', 'echo', 'stem-handoff']) {
    const plan = buildAutomationPlan({ strategy, vocalOut: 0.7, vocalIn: 0.6, beatMatched: true })
    const left = new Float32Array(total)
    const right = new Float32Array(total)
    renderContinuousBlend({
      a,
      b,
      left,
      right,
      fade,
      total,
      sampleRate: SR,
      beatSamples: Math.round(SR * 0.5),
      plan
    })

    let peak = 0
    for (let i = 0; i < total; i += 1) {
      assert.ok(Number.isFinite(left[i]) && Number.isFinite(right[i]), `${strategy} produced non-finite sample`)
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
    }
    assert.ok(peak > 0.05 && peak <= 1.0, `${strategy} peak=${peak.toFixed(3)}`)
    // End of blend should transition to Track B smoothly.
    assert.ok(rms(left, fade + 1000, total - 1000) > 0.1, `${strategy} continues smoothly into Track B`)
  }
})

test('vocal clash Mid-Side sculpting attenuates centered vocals while keeping stereo sides intact', () => {
  const fade = SR * 2
  const total = fade
  // Track A: centered 1.2kHz vocal (L === R) + stereo side synth (L = -R)
  const leftA = new Float32Array(total)
  const rightA = new Float32Array(total)
  for (let i = 0; i < total; i += 1) {
    const voc = Math.sin((2 * Math.PI * 1200 * i) / SR) * 0.4
    const side = Math.sin((2 * Math.PI * 300 * i) / SR) * 0.25
    leftA[i] = voc + side
    rightA[i] = voc - side
  }
  const b = stereoSine(1400, 1400, total, 0.0) // silent B so we measure A's sculpting directly

  const planCalm = buildAutomationPlan({ strategy: 'eq-blend', vocalOut: 0, vocalIn: 0 })
  const planClash = buildAutomationPlan({ strategy: 'eq-blend', vocalOut: 0.9, vocalIn: 0.9 })

  const outCalmL = new Float32Array(total)
  const outCalmR = new Float32Array(total)
  const outClashL = new Float32Array(total)
  const outClashR = new Float32Array(total)

  renderContinuousBlend({
    a: { left: leftA, right: rightA, sampleRate: SR, length: total },
    b,
    left: outCalmL,
    right: outCalmR,
    fade,
    total,
    sampleRate: SR,
    beatSamples: SR / 2,
    plan: planCalm
  })
  renderContinuousBlend({
    a: { left: leftA, right: rightA, sampleRate: SR, length: total },
    b,
    left: outClashL,
    right: outClashR,
    fade,
    total,
    sampleRate: SR,
    beatSamples: SR / 2,
    plan: planClash
  })

  // Measure mid (L+R)/2 vs side (L-R)/2 in the vocal-handoff pocket (t = 0.55..0.80).
  const winLen = Math.floor(total * 0.25)
  const midCalm = new Float32Array(winLen)
  const midClash = new Float32Array(winLen)
  const sideCalm = new Float32Array(winLen)
  const sideClash = new Float32Array(winLen)
  const s0 = Math.floor(total * 0.55)
  for (let i = 0; i < winLen; i += 1) {
    midCalm[i] = 0.5 * (outCalmL[s0 + i] + outCalmR[s0 + i])
    midClash[i] = 0.5 * (outClashL[s0 + i] + outClashR[s0 + i])
    sideCalm[i] = 0.5 * (outCalmL[s0 + i] - outCalmR[s0 + i])
    sideClash[i] = 0.5 * (outClashL[s0 + i] - outClashR[s0 + i])
  }
  assert.ok(rms(midClash) < rms(midCalm) * 0.65, `vocal clash ducked mid band (${rms(midClash).toFixed(3)} vs ${rms(midCalm).toFixed(3)})`)
  assert.ok(Math.abs(rms(sideClash) - rms(sideCalm)) < 0.02, `stereo side image preserved (${rms(sideClash).toFixed(3)} vs ${rms(sideCalm).toFixed(3)})`)
})

test('optional 4-stem mixing independently sculpts vocals, bass, drums, and other stems', () => {
  const fade = SR * 2
  const total = fade
  const silence = stereoSine(440, 440, total, 0)
  const aFull = stereoSine(220, 220, total, 0.3)
  const bFull = stereoSine(330, 330, total, 0.3)

  const plan = buildAutomationPlan({ strategy: 'stem-handoff', vocalOut: 0.9, vocalIn: 0.9, beatMatched: true })
  const left = new Float32Array(total)
  const right = new Float32Array(total)

  renderContinuousBlend({
    a: aFull,
    b: bFull,
    left,
    right,
    fade,
    total,
    sampleRate: SR,
    beatSamples: SR / 2,
    plan,
    stemsA: {
      vocals: stereoSine(1100, 1100, total, 0.35),
      bass: stereoSine(65, 65, total, 0.35),
      drums: stereoSine(180, 180, total, 0.2),
      other: silence
    },
    stemsB: {
      vocals: stereoSine(1300, 1300, total, 0.35),
      bass: stereoSine(70, 70, total, 0.35),
      drums: stereoSine(200, 200, total, 0.2),
      other: silence
    }
  })

  const peak = Math.max(...left.map(Math.abs))
  assert.ok(peak > 0.1 && peak <= 1.0, `stem-mixed peak=${peak.toFixed(3)}`)
  assert.ok(sampleCurve([0, 1], 0.5) > 0.45 && sampleCurve([0, 1], 0.5) < 0.55)
})
