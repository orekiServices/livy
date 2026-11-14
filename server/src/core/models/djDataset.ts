/**
 * Professional DJ Mix Alignment & Supervision Extraction Pipeline.
 *
 * Extracts real DJ transition training examples from legally obtained DJ mixes
 * paired with their corresponding original source tracks:
 *   1. Coarse spectral/chroma anchor search + Subsequence Dynamic Time Warping
 *      (Subsequence-DTW) aligns each original track inside the continuous DJ mix,
 *      recovering exact mix timestamps, source offsets, and the DJ's tempo pitch
 *      adjustment ratio.
 *   2. Over every consecutive track overlap window (Track A → Track B), splits
 *      the aligned mix and warped source tracks into 3 frequency bands (Low,
 *      Mid, High) + vocal center band and solves regularized 2×2 non-negative
 *      least squares (NNLS) at K temporal knots to invert the DJ's true volume,
 *      3-band EQ, bass-swap timing, vocal ducking, filter sweep, and FX tail
 *      supervision signals.
 *   3. Enforces strict provenance tracking so synthetic crossfades are never
 *      silently treated as real professional DJ training data.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { clamp, resample } from '../dsp.ts'
import { CHROMA, FeatureStream, fft } from '../seams/features.ts'
import { DEFAULT_KNOTS } from '../automix/blender.ts'
import { analyzeTrackStructure, type TrackStructure } from '../automix/structure.ts'
import { decodeMp3 } from '../automix/audio.ts'
import {
  AUTOMIX_STRATEGIES,
  SEQ_FEATURE_DIM,
  type AutoMixStrategy,
  type NeuralInput,
  type NeuralTarget
} from './architectures.ts'
import { extractPairFeatures, extractTrackSequences } from './neuralAutomix.ts'

export interface DjMixTrackEntry {
  trackId: string
  title?: string
  artist?: string
  /** Path to the legally obtained original audio file (MP3/WAV) or pre-decoded PCM. */
  audioPath?: string
  /** Optional approximate start time in the DJ mix (seconds) to narrow coarse search. */
  approxStartSec?: number
  /** Optional approximate end time in the DJ mix (seconds). */
  approxEndSec?: number
}

export interface DjMixManifest {
  mixId: string
  djName?: string
  title?: string
  /** License or legal provenance note (e.g. "CC-BY-4.0", "licensed-corpus", "personal-owned"). */
  license: string
  source: 'real-dj-mix'
  mixAudioPath?: string
  tracks: DjMixTrackEntry[]
}

export interface TrackAlignment {
  trackId: string
  mixStartSec: number
  mixEndSec: number
  trackStartSec: number
  trackEndSec: number
  /** DJ playback tempo ratio (>1 = DJ played track faster than original). */
  tempoRatio: number
  /** Mean cosine similarity along the DTW warping path (0..1). */
  confidence: number
  /** Sampled warping anchors `[mixSec, trackSec]`. */
  warpPath: Array<[number, number]>
}

export interface ExtractedTransitionExample {
  exampleId: string
  mixId: string
  trackAId: string
  trackBId: string
  provenance: {
    source: 'real-dj-mix' | 'synthetic'
    license: string
    djName?: string
    mixHash?: string
    alignmentConfidence: number
    extractedAt: number
  }
  alignment: {
    mixOverlapStartSec: number
    mixOverlapEndSec: number
    trackAMixOutSec: number
    trackBMixInSec: number
    durationSec: number
    durationBars: number
    tempoRatioA: number
    tempoRatioB: number
    confidenceA: number
    confidenceB: number
  }
  diagnostics: {
    observedStrategy: AutoMixStrategy
    bassSwapAt: number
    bassSwapWidth: number
    residualEnergyRatio: number
    reconstructionR2: number
    vocalOverlapRatio: number
  }
  input: {
    pair: number[]
    seqA: number[][]
    seqB: number[][]
  }
  target: NeuralTarget
}

export interface AudioBufferLike {
  mono: Float32Array
  left?: Float32Array
  right?: Float32Array
  sampleRate: number
}

/* ------------------------------------------------------------------ *
 * Downsampled chroma+timbre frame matrix for fast Subsequence-DTW
 * ------------------------------------------------------------------ */

interface AlignmentFrames {
  fps: number
  dim: number
  /** Row-major L2-normalized feature vectors `[numFrames * dim]`. */
  data: Float32Array
  count: number
}

function buildAlignmentFrames(mono: Float32Array, sampleRate: number, poolFrames = 8): AlignmentFrames {
  const stream = new FeatureStream(sampleRate)
  stream.push(mono)
  const dim = CHROMA + 6 // 12 chroma + 6 low-order timbre coefficients
  const count = Math.max(1, Math.floor(stream.frames / poolFrames))
  const data = new Float32Array(count * dim)

  for (let i = 0; i < count; i += 1) {
    const start = i * poolFrames
    const end = Math.min(stream.frames, start + poolFrames)
    const span = Math.max(1, end - start)
    const base = i * dim
    for (let f = start; f < end; f += 1) {
      const c = stream.chroma.row(f)
      const t = stream.timbre.row(f)
      for (let k = 0; k < CHROMA; k += 1) data[base + k] += c[k] / span
      // Weight timbre modestly so pitch/harmony dominates alignment even under DJ EQ cuts!
      for (let k = 1; k <= 6; k += 1) data[base + CHROMA + (k - 1)] += ((t[k] ?? 0) / 35) * (0.35 / span)
    }
    let norm = 0
    for (let d = 0; d < dim; d += 1) norm += data[base + d] * data[base + d]
    const inv = norm > 1e-12 ? 1 / Math.sqrt(norm) : 0
    for (let d = 0; d < dim; d += 1) data[base + d] *= inv
  }

  return { fps: stream.fps / poolFrames, dim, data, count }
}

function frameCosine(a: AlignmentFrames, ia: number, b: AlignmentFrames, ib: number): number {
  const dim = a.dim
  const offA = ia * dim
  const offB = ib * dim
  let dot = 0
  for (let d = 0; d < dim; d += 1) dot += a.data[offA + d] * b.data[offB + d]
  return clamp(dot, -1, 1)
}

/**
 * Align an original source track against a continuous DJ mix using coarse
 * anchor search followed by Subsequence Dynamic Time Warping (Subsequence-DTW).
 *
 * Tolerates DJ pitch adjustments (±15%), EQ sculpting (chroma-weighted), and
 * partial plays (where the DJ only plays a subset of the source track).
 */
export function alignTrackInMix(
  mix: AudioBufferLike,
  source: AudioBufferLike,
  options: {
    trackId?: string
    approxStartSec?: number
    approxEndSec?: number
    searchMarginSec?: number
    /** Expected window inside source track to anchor on (defaults to whole source). */
    sourceStartSec?: number
    sourceEndSec?: number
  } = {}
): TrackAlignment {
  const mixFrames = buildAlignmentFrames(mix.mono, mix.sampleRate)
  const srcFrames = buildAlignmentFrames(source.mono, source.sampleRate)
  const fps = mixFrames.fps

  const srcFrom = Math.max(0, Math.floor((options.sourceStartSec ?? 0) * srcFrames.fps))
  const srcTo = Math.min(srcFrames.count, Math.ceil((options.sourceEndSec ?? source.mono.length / source.sampleRate) * srcFrames.fps))
  const M = Math.max(1, srcTo - srcFrom)

  // Determine search window inside the DJ mix.
  let winStart = 0
  let winEnd = mixFrames.count
  if (options.approxStartSec != null) {
    const margin = Math.round((options.searchMarginSec ?? 25) * fps)
    winStart = Math.max(0, Math.floor(options.approxStartSec * fps) - margin)
    const expectedLen = options.approxEndSec != null ? Math.ceil(options.approxEndSec * fps) + margin : winStart + Math.ceil(M * 1.25) + margin * 2
    winEnd = Math.min(mixFrames.count, expectedLen)
  }

  // Coarse diagonal cross-correlation over a probe slice to narrow long mixes cleanly.
  if (winEnd - winStart > M * 3 + 40 && M >= 8) {
    const probeOffset = Math.floor(M * 0.2)
    const probeLen = Math.min(M - probeOffset, 40)
    let bestAnchor = winStart
    let bestScore = -Infinity
    const step = Math.max(1, Math.floor(probeLen / 16))
    for (let start = winStart; start <= winEnd - probeLen; start += 2) {
      let s = 0
      let cnt = 0
      for (let k = 0; k < probeLen; k += step) {
        s += frameCosine(srcFrames, srcFrom + probeOffset + k, mixFrames, start + k)
        cnt += 1
      }
      const avg = s / Math.max(1, cnt)
      if (avg > bestScore) {
        bestScore = avg
        bestAnchor = start - probeOffset
      }
    }
    const pad = Math.round(M * 0.35 + 15)
    winStart = Math.max(0, bestAnchor - pad)
    winEnd = Math.min(mixFrames.count, bestAnchor + M + pad)
  }

  const N = Math.max(1, winEnd - winStart)

  // Subsequence-DTW: cost matrix D[i][j] for source frame i ∈ [0..M-1], mix frame j ∈ [0..N-1].
  // Free starting & ending position along the mix axis (j) allows partial track plays.
  // Step-size-normalized transitions (Müller §7.2.2) ensure (2,1) and (1,2) NEVER skip
  // source frames for free, yielding unbiased DJ tempo pitch-ratio recovery!
  const INF = 1e9
  const D = new Float32Array(M * N).fill(INF)
  const back = new Int8Array(M * N) // 0=start, 1=(1,1), 2=(1,2), 3=(2,1)

  // Precompute local cosine distance matrix C[i][j] = 1 - cos(src[i], mix[j])
  const C = new Float32Array(M * N)
  for (let i = 0; i < M; i += 1) {
    const row = i * N
    for (let j = 0; j < N; j += 1) {
      C[row + j] = 1 - frameCosine(srcFrames, srcFrom + i, mixFrames, winStart + j)
    }
  }

  for (let j = 0; j < N; j += 1) {
    D[j] = C[j]
    back[j] = 0
  }

  for (let i = 1; i < M; i += 1) {
    const row = i * N
    const prev1 = (i - 1) * N
    const prev2 = (i - 2) * N
    for (let j = 0; j < N; j += 1) {
      const localCost = C[row + j]
      let bestCost = INF
      let stepCode = 0

      // (1, 1): 1.0x speed — advances 1 source frame, 1 mix frame
      if (j >= 1) {
        const c11 = D[prev1 + (j - 1)] + localCost
        if (c11 < bestCost) {
          bestCost = c11
          stepCode = 1
        }
      }
      // (1, 2): 0.5x local step (DJ slowed track) — pays average of both mix frames + mild slope penalty
      if (j >= 2) {
        const c12 = D[prev1 + (j - 2)] + 0.5 * (C[row + (j - 1)] + localCost) + 0.02
        if (c12 < bestCost) {
          bestCost = c12
          stepCode = 2
        }
      }
      // (2, 1): 2.0x local step (DJ sped up track) — MUST pay for BOTH source frames (i-1 and i)!
      if (i >= 2 && j >= 1) {
        const c21 = D[prev2 + (j - 1)] + C[prev1 + j] + localCost + 0.02
        if (c21 < bestCost) {
          bestCost = c21
          stepCode = 3
        }
      }
      if (bestCost < INF) {
        D[row + j] = bestCost
        back[row + j] = stepCode
      }
    }
  }

  // Pick minimum normalized path cost over the matched prefix (handles partial track plays cleanly).
  let bestEndI = M - 1
  let bestEndJ = 0
  let bestAvgCost = INF
  const minMatchedFrames = Math.max(4, Math.floor(M * 0.45))

  for (let i = minMatchedFrames - 1; i < M; i += 1) {
    const row = i * N
    for (let j = 0; j < N; j += 1) {
      const c = D[row + j]
      if (c >= INF * 0.5) continue
      const avg = c / (i + 1) - (i / M) * 0.04
      if (avg < bestAvgCost) {
        bestAvgCost = avg
        bestEndI = i
        bestEndJ = j
      }
    }
  }

  // Backtrack warping path.
  const rawPath: Array<[number, number]> = []
  let ci = bestEndI
  let cj = bestEndJ
  let simSum = 0
  while (ci >= 0 && cj >= 0) {
    const mixIdx = winStart + cj
    const srcIdx = srcFrom + ci
    simSum += frameCosine(srcFrames, srcIdx, mixFrames, mixIdx)
    rawPath.push([mixIdx / fps, srcIdx / srcFrames.fps])
    const code = back[ci * N + cj]
    if (code === 0 || ci === 0) break
    if (code === 1) {
      ci -= 1
      cj -= 1
    } else if (code === 2) {
      ci -= 1
      cj -= 2
    } else {
      ci -= 2
      cj -= 1
    }
  }
  rawPath.reverse()

  const first = rawPath[0] ?? [0, 0]
  const last = rawPath[rawPath.length - 1] ?? [0, 0]

  // Robust OLS slope fit over interior [15%..85%] of the warp path (excludes fade/overlap edges).
  let tempoRatio = 1
  const i0 = Math.floor(rawPath.length * 0.15)
  const i1 = Math.max(i0 + 2, Math.ceil(rawPath.length * 0.85))
  const interior = rawPath.slice(i0, i1)
  if (interior.length >= 3) {
    let mx = 0
    let my = 0
    for (const [x, y] of interior) {
      mx += x
      my += y
    }
    mx /= interior.length
    my /= interior.length
    let num = 0
    let den = 0
    for (const [x, y] of interior) {
      num += (x - mx) * (y - my)
      den += (x - mx) * (x - mx)
    }
    if (den > 1e-6) tempoRatio = clamp(num / den, 0.75, 1.35)
  } else {
    const mixSpan = Math.max(1e-3, last[0] - first[0])
    const trackSpan = Math.max(1e-3, last[1] - first[1])
    tempoRatio = clamp(trackSpan / mixSpan, 0.75, 1.35)
  }
  const meanSim = rawPath.length > 0 ? simSum / rawPath.length : 0

  // Downsample warp path to at most 32 anchor points for compact serialization.
  const stride = Math.max(1, Math.floor(rawPath.length / 32))
  const warpPath = rawPath.filter((_, idx) => idx % stride === 0 || idx === rawPath.length - 1)

  return {
    trackId: options.trackId ?? 'unknown',
    mixStartSec: Number(first[0].toFixed(3)),
    mixEndSec: Number(last[0].toFixed(3)),
    trackStartSec: Number(first[1].toFixed(3)),
    trackEndSec: Number(last[1].toFixed(3)),
    tempoRatio: Number(tempoRatio.toFixed(4)),
    confidence: Number(clamp(meanSim, 0, 1).toFixed(4)),
    warpPath
  }
}

/* ------------------------------------------------------------------ *
 * Inverse DJ Mixing Supervision Extraction (regularized 2×2 NNLS)
 * ------------------------------------------------------------------ */

/**
 * Solve min_{a>=0, b>=0} ||a*xA + b*xB - y||^2 + lambda*(a^2 + b^2)
 * using exact Kuhn-Tucker active-set cases for 2 variables.
 */
function solve2x2Nnls(xA: Float32Array, xB: Float32Array, y: Float32Array, lambda = 1e-4): { a: number; b: number; residualSq: number; ySq: number } {
  const n = Math.min(xA.length, xB.length, y.length)
  let aa = lambda
  let bb = lambda
  let ab = 0
  let ay = 0
  let by = 0
  let yy = 0
  for (let i = 0; i < n; i += 1) {
    const va = xA[i]
    const vb = xB[i]
    const vy = y[i]
    aa += va * va
    bb += vb * vb
    ab += va * vb
    ay += va * vy
    by += vb * vy
    yy += vy * vy
  }

  const evalObj = (a: number, b: number) => {
    const res = yy - 2 * a * ay - 2 * b * by + a * a * (aa - lambda) + 2 * a * b * ab + b * b * (bb - lambda)
    return { a, b, obj: res + lambda * (a * a + b * b), residualSq: Math.max(0, res) }
  }

  const candidates = [
    evalObj(0, 0),
    evalObj(clamp(ay / aa, 0, 1.4), 0),
    evalObj(0, clamp(by / bb, 0, 1.4))
  ]

  const det = aa * bb - ab * ab
  if (Math.abs(det) > 1e-10) {
    const aUn = (bb * ay - ab * by) / det
    const bUn = (aa * by - ab * ay) / det
    if (aUn >= 0 && bUn >= 0) {
      candidates.push(evalObj(clamp(aUn, 0, 1.4), clamp(bUn, 0, 1.4)))
    }
  }

  candidates.sort((p, q) => p.obj - q.obj)
  const best = candidates[0]
  return { a: best.a, b: best.b, residualSq: best.residualSq, ySq: yy }
}

/**
 * Compute phase-invariant STFT magnitude frames (1024-pt Hann window, 512 hop)
 * for inverse DJ 3-band EQ / vocal supervision extraction. Solving 2×2 NNLS in
 * the time-frequency magnitude domain is immune to CDJ Master Tempo phase
 * shifts, EQ phase rotation, MP3 encoding, AND collinear sustained chords!
 */
interface StftMagnitudes {
  numFrames: number
  numBins: number
  binHz: number
  /** Row-major `[numFrames * numBins]` magnitude spectrogram. */
  mag: Float32Array
}

function computeStftMagnitudes(sig: Float32Array, sampleRate: number, fftSize = 1024, hop = 512): StftMagnitudes {
  const numBins = fftSize >> 1
  const numFrames = Math.max(1, Math.floor((Math.max(sig.length, fftSize) - fftSize) / hop) + 1)
  const mag = new Float32Array(numFrames * numBins)
  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)
  const win = new Float32Array(fftSize)
  for (let i = 0; i < fftSize; i += 1) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1))
  }

  for (let f = 0; f < numFrames; f += 1) {
    const start = f * hop
    re.fill(0)
    im.fill(0)
    for (let i = 0; i < fftSize; i += 1) {
      re[i] = (sig[start + i] ?? 0) * win[i]
    }
    fft(re, im)
    const row = f * numBins
    for (let b = 0; b < numBins; b += 1) {
      mag[row + b] = Math.hypot(re[b], im[b])
    }
  }
  return { numFrames, numBins, binHz: sampleRate / fftSize, mag }
}

/**
 * Solve 2×2 NNLS over time-frequency STFT magnitude bins inside `[f0..f1)` and
 * frequency range `[minHz..maxHz]`.
 */
function solveStftBandNnls(
  stftA: StftMagnitudes,
  stftB: StftMagnitudes,
  stftMix: StftMagnitudes,
  f0: number,
  f1: number,
  minHz: number,
  maxHz: number
): { a: number; b: number; residualSq: number; ySq: number } {
  const b0 = Math.max(1, Math.floor(minHz / stftMix.binHz))
  const b1 = Math.min(stftMix.numBins - 1, Math.ceil(maxHz / stftMix.binHz))
  const frames = Math.max(1, f1 - f0)
  const bins = Math.max(1, b1 - b0 + 1)
  const len = frames * bins

  const vecA = new Float32Array(len)
  const vecB = new Float32Array(len)
  const vecY = new Float32Array(len)
  let ptr = 0
  for (let f = f0; f < f1; f += 1) {
    const rowA = Math.min(f, stftA.numFrames - 1) * stftA.numBins
    const rowB = Math.min(f, stftB.numFrames - 1) * stftB.numBins
    const rowY = Math.min(f, stftMix.numFrames - 1) * stftMix.numBins
    for (let b = b0; b <= b1; b += 1) {
      vecA[ptr] = stftA.mag[rowA + b]
      vecB[ptr] = stftB.mag[rowB + b]
      vecY[ptr] = stftMix.mag[rowY + b]
      ptr += 1
    }
  }
  return solve2x2Nnls(vecA, vecB, vecY, 1e-4)
}

function classifyObservedStrategy(params: {
  lowA: number[]
  lowB: number[]
  midA: number[]
  midB: number[]
  highA: number[]
  highB: number[]
  filterA: number[]
  filterB: number[]
  reverbSendA: number[]
  delaySendA: number[]
  vocalDuckA: number[]
  vocalDuckB: number[]
  durationSec: number
  bassSwapWidth: number
}): AutoMixStrategy {
  const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length)
  const maxAbs = (arr: number[]) => Math.max(...arr.map((v) => Math.abs(v)))

  if (params.durationSec < 1.0) return 'slam'
  if (maxAbs(params.delaySendA) > 0.35) return 'echo'
  if (mean(params.reverbSendA) > 0.25) return 'wash'
  if (maxAbs(params.filterA) > 0.42 || maxAbs(params.filterB) > 0.42) return 'filter'
  if (Math.max(mean(params.vocalDuckA), mean(params.vocalDuckB)) > 0.32) return 'stem-handoff'
  if (params.bassSwapWidth <= 0.2) return 'bass-swap'
  const midHighDiff = Math.abs(mean(params.lowA) - mean(params.highA)) + Math.abs(mean(params.lowB) - mean(params.highB))
  if (midHighDiff > 0.22) return 'eq-blend'
  return 'crossfade'
}

/**
 * Extract a complete, supervised neural training example from a real DJ
 * transition between Track A and Track B inside a continuous DJ mix.
 */
export function extractDjSupervision(params: {
  mixId: string
  mix: AudioBufferLike
  trackA: AudioBufferLike & { trackId: string }
  trackB: AudioBufferLike & { trackId: string }
  alignmentA: TrackAlignment
  alignmentB: TrackAlignment
  license: string
  djName?: string
  knots?: number
  seqLen?: number
  source?: 'real-dj-mix' | 'synthetic'
}): ExtractedTransitionExample | null {
  const { mix, trackA, trackB, alignmentA, alignmentB } = params
  const knots = params.knots ?? DEFAULT_KNOTS
  const seqLen = params.seqLen ?? 16
  const sr = mix.sampleRate

  // Overlap window in mix time: in real DJ mixes, Track B's DTW anchor begins
  // slightly AFTER fade-in starts and Track A's DTW anchor ends near the chroma
  // crossover (BEFORE Track A finishes fading out). Extend the analysis window
  // outward across the available source-track tails so band-power NNLS captures
  // the complete transition from Track A solo → crossover → Track B solo!
  const rawStart = Math.max(alignmentA.mixStartSec, alignmentB.mixStartSec)
  const rawEnd = Math.min(alignmentA.mixEndSec, alignmentB.mixEndSec)
  const trackADurSec = trackA.mono.length / trackA.sampleRate
  const trackBDurSec = trackB.mono.length / trackB.sampleRate
  const mixDurSec = mix.mono.length / sr

  // Extrapolate how far back Track B's true 0.0s start sits in mix time, and how
  // far forward Track A's remaining tail extends in mix time (capped to ±6s).
  const bHeadAvailMix = Math.min(6, alignmentB.trackStartSec / Math.max(0.5, alignmentB.tempoRatio))
  const aTailAvailMix = Math.min(6, Math.max(0, trackADurSec - alignmentA.trackEndSec) / Math.max(0.5, alignmentA.tempoRatio))
  const aHeadAvailMix = Math.max(0, (rawStart - alignmentA.mixStartSec))
  const bTailAvailMix = Math.max(0, (trackBDurSec - alignmentB.trackStartSec) / Math.max(0.5, alignmentB.tempoRatio))

  const overlapStart = clamp(rawStart - Math.min(bHeadAvailMix, aHeadAvailMix), 0, mixDurSec)
  let overlapEnd = clamp(Math.max(rawEnd, alignmentA.mixEndSec) + aTailAvailMix, overlapStart, Math.min(mixDurSec, overlapStart + bTailAvailMix))
  if (overlapEnd <= overlapStart + 0.35) {
    // Hard cut / short slam: examine a 1.2s window centered on the cut point.
    overlapEnd = Math.min(mixDurSec, overlapStart + 1.2)
  }
  const durationSec = overlapEnd - overlapStart
  if (durationSec < 0.35) return null

  const mixStartSample = Math.max(0, Math.round(overlapStart * sr))
  const mixLenSamples = Math.min(Math.round(durationSec * sr), mix.mono.length - mixStartSample)
  if (mixLenSamples < Math.round(0.35 * sr)) return null
  const mixSlice = mix.mono.subarray(mixStartSample, mixStartSample + mixLenSamples)

  // Map overlap window onto Track A and Track B source timelines (accounting for DJ tempo ratio).
  const trackAMixOutSec = Math.max(0, alignmentA.trackStartSec + (overlapStart - alignmentA.mixStartSec) * alignmentA.tempoRatio)
  const trackAOutEndSec = Math.min(
    trackA.mono.length / trackA.sampleRate,
    trackAMixOutSec + durationSec * alignmentA.tempoRatio
  )
  const trackBMixInSec = Math.max(0, alignmentB.trackStartSec + (overlapStart - alignmentB.mixStartSec) * alignmentB.tempoRatio)
  const trackBInEndSec = Math.min(
    trackB.mono.length / trackB.sampleRate,
    trackBMixInSec + durationSec * alignmentB.tempoRatio
  )

  const rawA = trackA.mono.subarray(
    Math.round(trackAMixOutSec * trackA.sampleRate),
    Math.round(trackAOutEndSec * trackA.sampleRate)
  )
  const rawB = trackB.mono.subarray(
    Math.round(trackBMixInSec * trackB.sampleRate),
    Math.round(trackBInEndSec * trackB.sampleRate)
  )
  if (rawA.length < 256 || rawB.length < 256) return null

  // Resample/warp source segments to match exact mix sample length for band-wise inversion.
  const alignedA = resample(rawA, rawA.length, mixLenSamples)
  const alignedB = resample(rawB, rawB.length, mixLenSamples)

  // Phase-invariant STFT magnitude spectrograms on Mix, Warped A, Warped B.
  const stftMix = computeStftMagnitudes(mixSlice, sr)
  const stftA = computeStftMagnitudes(alignedA, sr)
  const stftB = computeStftMagnitudes(alignedB, sr)

  const lowA: number[] = []
  const midA: number[] = []
  const highA: number[] = []
  const lowB: number[] = []
  const midB: number[] = []
  const highB: number[] = []
  const gainA: number[] = []
  const gainB: number[] = []
  const vocalDuckA: number[] = []
  const vocalDuckB: number[] = []
  const filterA: number[] = []
  const filterB: number[] = []
  const reverbSendA: number[] = []
  const delaySendA: number[] = []

  let totalResidualSq = 0
  let totalYSq = 0
  let vocOverlapAcc = 0

  const totalFrames = stftMix.numFrames
  for (let k = 0; k < knots; k += 1) {
    const f0 = Math.min(totalFrames - 1, Math.floor((k * totalFrames) / knots))
    const f1 = Math.max(f0 + 1, Math.min(totalFrames, Math.floor(((k + 1) * totalFrames) / knots)))

    const lo = solveStftBandNnls(stftA, stftB, stftMix, f0, f1, 20, 200)
    const mi = solveStftBandNnls(stftA, stftB, stftMix, f0, f1, 200, 3600)
    const hi = solveStftBandNnls(stftA, stftB, stftMix, f0, f1, 3600, sr * 0.48)
    const vc = solveStftBandNnls(stftA, stftB, stftMix, f0, f1, 300, 3400)

    totalResidualSq += lo.residualSq + mi.residualSq + hi.residualSq
    totalYSq += lo.ySq + mi.ySq + hi.ySq

    const gA = clamp((lo.a + mi.a + hi.a) / 3, 0, 1)
    const gB = clamp((lo.b + mi.b + hi.b) / 3, 0, 1)
    const lA = clamp(lo.a, 0, 1)
    const mA = clamp(mi.a, 0, 1)
    const hA = clamp(hi.a, 0, 1)
    const lB = clamp(lo.b, 0, 1)
    const mB = clamp(mi.b, 0, 1)
    const hB = clamp(hi.b, 0, 1)

    // Estimate vocal ducking: how much more vocal band was attenuated compared to surrounding mid/high.
    const refA = Math.max(0.05, (mA + hA) * 0.5)
    const refB = Math.max(0.05, (mB + hB) * 0.5)
    const vDuckA = clamp(1 - vc.a / refA, 0, 0.95)
    const vDuckB = clamp(1 - vc.b / refB, 0, 0.95)
    vocOverlapAcc += clamp(vc.a * vc.b, 0, 1)

    // Estimate bi-polar DJ filter tilt from high-vs-low band attenuation ratios.
    const fA = clamp((hA - lA) * 0.85, -1, 1) * (Math.abs(hA - lA) > 0.25 ? 1 : 0.3)
    const fB = clamp((hB - lB) * 0.85, -1, 1) * (Math.abs(hB - lB) > 0.25 ? 1 : 0.3)

    // Residual energy relative to total band energy indicates reverb/delay tails or risers.
    const knotRes = (lo.residualSq + mi.residualSq + hi.residualSq) / Math.max(1e-6, lo.ySq + mi.ySq + hi.ySq)
    const revA = clamp((knotRes - 0.12) * 1.1 * (k / Math.max(1, knots - 1)), 0, 0.8)
    const delA = clamp((knotRes - 0.22) * 0.9 * (lA < 0.25 ? 1 : 0.2), 0, 0.75)

    gainA.push(Number(gA.toFixed(4)))
    gainB.push(Number(gB.toFixed(4)))
    lowA.push(Number(lA.toFixed(4)))
    midA.push(Number(mA.toFixed(4)))
    highA.push(Number(hA.toFixed(4)))
    lowB.push(Number(lB.toFixed(4)))
    midB.push(Number(mB.toFixed(4)))
    highB.push(Number(hB.toFixed(4)))
    vocalDuckA.push(Number(vDuckA.toFixed(4)))
    vocalDuckB.push(Number(vDuckB.toFixed(4)))
    filterA.push(Number(fA.toFixed(4)))
    filterB.push(Number(fB.toFixed(4)))
    reverbSendA.push(Number(revA.toFixed(4)))
    delaySendA.push(Number(delA.toFixed(4)))
  }

  // Locate true bass-swap point via optimal step-dominance split: find split s ∈ [1..knots-1]
  // maximizing Track A low dominance on [0..s-1] + Track B low dominance on [s..knots-1].
  // Immune to silent knots (0 >= 0) or single-knot noise!
  let bestSplit = Math.max(1, Math.round(knots * 0.5))
  let bestSplitScore = -Infinity
  for (let s = 1; s < knots; s += 1) {
    let beforeDiff = 0
    for (let k = 0; k < s; k += 1) beforeDiff += lowA[k] - lowB[k]
    let afterDiff = 0
    for (let k = s; k < knots; k += 1) afterDiff += lowB[k] - lowA[k]
    const score = beforeDiff / s + afterDiff / (knots - s)
    if (score > bestSplitScore) {
      bestSplitScore = score
      bestSplit = s
    }
  }
  const bassSwapAt = clamp(bestSplit / knots, 0.2, 0.85)
  let transKnots = 0
  for (let k = 0; k < knots; k += 1) {
    if (lowA[k] > 0.15 && lowB[k] > 0.15) transKnots += 1
  }
  const bassSwapWidth = clamp((transKnots + 0.5) / knots, 0.05, 0.35)

  // Analyse Track A and Track B structures for neural inputs.
  const structA: TrackStructure = analyzeTrackStructure(trackA.mono, trackA.sampleRate, {
    cacheKey: `dj:${params.mixId}:${trackA.trackId}`
  })
  const structB: TrackStructure = analyzeTrackStructure(trackB.mono, trackB.sampleRate, {
    cacheKey: `dj:${params.mixId}:${trackB.trackId}`
  })

  const pairVec = extractPairFeatures(structA, structB)
  const { seqA, seqB } = extractTrackSequences(structA, structB, seqLen)

  const refBpm = structB.bpm > 40 ? structB.bpm : structA.bpm > 40 ? structA.bpm : 120
  const barSec = (60 / refBpm) * 4
  const durationBars = Math.max(1, Math.round(durationSec / barSec))
  const durNorm = clamp((Math.log2(clamp(durationBars, 2, 32)) - 2) / 3, 0, 1) // 4->0, 8->0.33, 16->0.67, 32->1

  const mixOutOffset = clamp(trackAMixOutSec / Math.max(1, structA.durationSec), 0, 1)
  const mixInOffset = clamp(trackBMixInSec / Math.max(1, structB.durationSec), 0, 1)
  const tempoBlend = clamp(1 - Math.abs(alignmentA.tempoRatio - alignmentB.tempoRatio) * 4, 0, 1)
  const reconstructionR2 = clamp(1 - totalResidualSq / Math.max(1e-6, totalYSq), 0, 1)
  const alignmentConf = Math.min(alignmentA.confidence, alignmentB.confidence)
  const observedStrategy = classifyObservedStrategy({
    lowA,
    lowB,
    midA,
    midB,
    highA,
    highB,
    filterA,
    filterB,
    reverbSendA,
    delaySendA,
    vocalDuckA,
    vocalDuckB,
    durationSec,
    bassSwapWidth
  })
  const strategyIndex = AUTOMIX_STRATEGIES.indexOf(observedStrategy)

  const automation = [
    Number(bassSwapAt.toFixed(4)),
    Number(bassSwapWidth.toFixed(4)),
    ...gainA,
    ...gainB,
    ...lowA,
    ...midA,
    ...highA,
    ...lowB,
    ...midB,
    ...highB,
    ...vocalDuckA,
    ...vocalDuckB,
    ...filterA,
    ...filterB,
    ...reverbSendA,
    ...delaySendA
  ]

  const mixHash = createHash('sha1').update(`${params.mixId}:${trackA.trackId}:${trackB.trackId}`).digest('hex').slice(0, 12)
  return {
    exampleId: `${params.mixId}__${trackA.trackId}__${trackB.trackId}`,
    mixId: params.mixId,
    trackAId: trackA.trackId,
    trackBId: trackB.trackId,
    provenance: {
      source: params.source ?? 'real-dj-mix',
      license: params.license,
      djName: params.djName,
      mixHash,
      alignmentConfidence: Number(alignmentConf.toFixed(4)),
      extractedAt: Date.now()
    },
    alignment: {
      mixOverlapStartSec: Number(overlapStart.toFixed(3)),
      mixOverlapEndSec: Number(overlapEnd.toFixed(3)),
      trackAMixOutSec: Number(trackAMixOutSec.toFixed(3)),
      trackBMixInSec: Number(trackBMixInSec.toFixed(3)),
      durationSec: Number(durationSec.toFixed(3)),
      durationBars,
      tempoRatioA: alignmentA.tempoRatio,
      tempoRatioB: alignmentB.tempoRatio,
      confidenceA: alignmentA.confidence,
      confidenceB: alignmentB.confidence
    },
    diagnostics: {
      observedStrategy,
      bassSwapAt: Number(bassSwapAt.toFixed(3)),
      bassSwapWidth: Number(bassSwapWidth.toFixed(3)),
      residualEnergyRatio: Number(clamp(totalResidualSq / Math.max(1e-6, totalYSq), 0, 1).toFixed(4)),
      reconstructionR2: Number(reconstructionR2.toFixed(4)),
      vocalOverlapRatio: Number((vocOverlapAcc / knots).toFixed(4))
    },
    input: {
      pair: Array.from(pairVec, (v) => Number(v.toFixed(5))),
      seqA: seqA.map((row) => Array.from(row, (v) => Number(v.toFixed(4)))),
      seqB: seqB.map((row) => Array.from(row, (v) => Number(v.toFixed(4))))
    },
    target: {
      stage1: [
        Number(mixOutOffset.toFixed(4)),
        Number(mixInOffset.toFixed(4)),
        Number(durNorm.toFixed(4)),
        Number(tempoBlend.toFixed(4)),
        Number(clamp(alignmentConf * 0.6 + reconstructionR2 * 0.4, 0, 1).toFixed(4))
      ],
      strategyIndex: strategyIndex >= 0 ? strategyIndex : 0,
      automation,
      weight: Number(clamp(0.4 + 0.6 * alignmentConf, 0.25, 1).toFixed(3))
    }
  }
}

/** Decode an MP3 file on disk to mono Float32Array for DJ dataset preparation. */
export async function loadAudioFile(filePath: string): Promise<AudioBufferLike> {
  const buf = fs.readFileSync(filePath)
  const decoded = await decodeMp3(buf)
  if (!decoded) throw new Error(`Could not decode audio file "${filePath}"`)
  const len = decoded.left.length
  const mono = new Float32Array(len)
  for (let i = 0; i < len; i += 1) mono[i] = 0.5 * (decoded.left[i] + decoded.right[i])
  return { mono, left: decoded.left, right: decoded.right, sampleRate: decoded.sampleRate }
}

/**
 * Process a complete DJ mix manifest from disk: align every track against the
 * mix and extract supervised transition examples for every consecutive pair.
 */
export async function extractDatasetFromManifest(
  manifest: DjMixManifest,
  options: { minAlignmentConfidence?: number; knots?: number; seqLen?: number } = {}
): Promise<ExtractedTransitionExample[]> {
  if (manifest.source !== 'real-dj-mix') {
    throw new Error('DJ dataset extraction requires provenance source "real-dj-mix" (synthetic crossfades are rejected)')
  }
  if (!manifest.license || !manifest.license.trim()) {
    throw new Error(`Manifest "${manifest.mixId}" is missing required legal license / provenance metadata`)
  }
  if (!manifest.mixAudioPath) throw new Error(`Manifest "${manifest.mixId}" is missing mixAudioPath`)

  const mixAudio = await loadAudioFile(manifest.mixAudioPath)
  const minConf = options.minAlignmentConfidence ?? 0.45
  const aligned: Array<{ entry: DjMixTrackEntry; audio: AudioBufferLike; alignment: TrackAlignment }> = []

  for (const entry of manifest.tracks) {
    if (!entry.audioPath) continue
    const audio = await loadAudioFile(entry.audioPath)
    const alignment = alignTrackInMix(mixAudio, audio, {
      trackId: entry.trackId,
      approxStartSec: entry.approxStartSec,
      approxEndSec: entry.approxEndSec
    })
    if (alignment.confidence >= minConf) {
      aligned.push({ entry, audio, alignment })
    }
  }

  aligned.sort((a, b) => a.alignment.mixStartSec - b.alignment.mixStartSec)
  const examples: ExtractedTransitionExample[] = []
  for (let i = 0; i < aligned.length - 1; i += 1) {
    const a = aligned[i]
    const b = aligned[i + 1]
    const ex = extractDjSupervision({
      mixId: manifest.mixId,
      mix: mixAudio,
      trackA: { ...a.audio, trackId: a.entry.trackId },
      trackB: { ...b.audio, trackId: b.entry.trackId },
      alignmentA: a.alignment,
      alignmentB: b.alignment,
      license: manifest.license,
      djName: manifest.djName,
      knots: options.knots,
      seqLen: options.seqLen,
      source: 'real-dj-mix'
    })
    if (ex) examples.push(ex)
  }
  return examples
}

/** Write extracted examples to JSONL (one transition example per line). */
export function writeTransitionDataset(filePath: string, examples: ExtractedTransitionExample[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const lines = examples.map((ex) => JSON.stringify(ex)).join('\n')
  fs.writeFileSync(filePath, lines ? `${lines}\n` : '', 'utf8')
}

/** Read extracted transition examples from a JSONL file. */
export function readTransitionDataset(filePath: string): ExtractedTransitionExample[] {
  const text = fs.readFileSync(filePath, 'utf8')
  const out: ExtractedTransitionExample[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    out.push(JSON.parse(trimmed) as ExtractedTransitionExample)
  }
  return out
}

/** Convert an ExtractedTransitionExample into typed NeuralInput/NeuralTarget for model training. */
export function toTrainingSample(example: ExtractedTransitionExample): {
  input: NeuralInput
  target: NeuralTarget
  mixId: string
} {
  return {
    mixId: example.mixId,
    input: {
      pair: Float32Array.from(example.input.pair),
      seqA: example.input.seqA.map((r) => Float32Array.from(r.slice(0, SEQ_FEATURE_DIM))),
      seqB: example.input.seqB.map((r) => Float32Array.from(r.slice(0, SEQ_FEATURE_DIM)))
    },
    target: example.target
  }
}

/** Validate that a dataset consists strictly of real professional DJ transitions with valid provenance. */
export function validateDatasetProvenance(
  examples: ExtractedTransitionExample[],
  options: { allowSynthetic?: boolean; minAlignmentConfidence?: number } = {}
): { valid: ExtractedTransitionExample[]; rejected: number; reasons: string[] } {
  const allowSynthetic = Boolean(options.allowSynthetic)
  const minConf = options.minAlignmentConfidence ?? 0.35
  const valid: ExtractedTransitionExample[] = []
  const reasons: string[] = []
  let rejected = 0

  for (const ex of examples) {
    if (!ex.provenance) {
      rejected += 1
      reasons.push(`${ex.exampleId}: missing provenance`)
      continue
    }
    if (!allowSynthetic && ex.provenance.source !== 'real-dj-mix') {
      rejected += 1
      reasons.push(`${ex.exampleId}: rejected non-real source "${ex.provenance.source}"`)
      continue
    }
    if (!ex.provenance.license || !ex.provenance.license.trim()) {
      rejected += 1
      reasons.push(`${ex.exampleId}: missing license metadata`)
      continue
    }
    if (ex.provenance.alignmentConfidence < minConf) {
      rejected += 1
      reasons.push(`${ex.exampleId}: alignment confidence ${ex.provenance.alignmentConfidence} < ${minConf}`)
      continue
    }
    valid.push(ex)
  }
  return { valid, rejected, reasons: reasons.slice(0, 20) }
}
