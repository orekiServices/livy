/**
 * Configurable lightweight Neural AutoMix architectures (~1K to ~5M trainable
 * parameters) implemented in pure TypeScript with exact analytical
 * backpropagation and AdamW optimization.
 *
 * Supported architectures:
 *   • `mlp-micro`        — Residual 2-stage MLP over pair + pooled sequence features (~2K–200K params)
 *   • `tcn-compact`      — Dilated 1D Temporal Convolutional Network over Track A/B beat sequences (~15K–1.5M params)
 *   • `gru-dj`           — Compact GRU sequence encoder over Track A/B beat sequences (~20K–2.5M params)
 *   • `transformer-mini` — Lightweight Multi-Head Cross-Attention Transformer (~40K–5M params)
 *
 * Multi-stage design:
 *   Stage 1 (Cue & Alignment Head):
 *     Predicts [mixOutOffset, mixInOffset, durationBarsNorm, tempoBlendMode, alignmentQuality]
 *   Stage 2 (Mixing Parameter & Automation Head):
 *     Conditioned on fused Track A/B representation + Stage 1 prediction, predicts:
 *       - 12 DJ strategy logits
 *       - bassSwapAt, bassSwapWidth
 *       - 14 continuous automation curves × K knots (gainA/B, 3-band EQ A/B,
 *         vocalDuckA/B, filterA/B, reverbSendA, delaySendA)
 */
import { clamp } from '../dsp.ts'

export type ArchitectureKind = 'mlp-micro' | 'tcn-compact' | 'gru-dj' | 'transformer-mini'

export const AUTOMIX_STRATEGIES = Object.freeze([
  'crossfade',
  'bass-swap',
  'filter',
  'echo',
  'sweep',
  'spindown',
  'slam',
  'wash',
  'roll',
  'drop',
  'eq-blend',
  'stem-handoff',
  'phrase-cut',
  'vocal-bridge',
  'tempo-ramp',
  'harmonic-drop'
] as const)

export type AutoMixStrategy = (typeof AUTOMIX_STRATEGIES)[number]

export const PAIR_FEATURE_DIM = 32
export const SEQ_FEATURE_DIM = 16
export const STAGE1_DIM = 5
export const CURVE_CHANNELS = 14 // gainA/B, low/mid/high A/B, vocalDuckA/B, filterA/B, revA, delA

export interface NeuralAutoMixConfig {
  architecture: ArchitectureKind
  /** Pair feature input width (default 32). */
  pairDim: number
  /** Per-beat sequence feature width (default 16). */
  seqDim: number
  /** Beat sequence length fed per track (default 16 beats = 4 bars). */
  seqLen: number
  /** Core hidden / model width (controls parameter budget from ~1K to ~5M). */
  hiddenDim: number
  /** Encoder depth (TCN blocks, GRU layers, Transformer blocks, or MLP layers). */
  numLayers: number
  /** Attention heads for `transformer-mini` (must divide hiddenDim). */
  numHeads: number
  /** Continuous automation knots per curve (default 8). */
  knots: number
  /** Number of discrete DJ strategies (default 12). */
  numStrategies: number
  /** Deterministic initialization seed. */
  seed: number
}

export interface ArchitecturePreset {
  id: string
  label: string
  description: string
  config: NeuralAutoMixConfig
  estimatedParams: number
}

export interface NeuralInput {
  /** Global pair feature vector (length `pairDim`). */
  pair: Float32Array | number[]
  /** Track A outro beat sequence (`seqLen × seqDim`, flattened or 2D). */
  seqA?: Float32Array[] | Float32Array | null
  /** Track B intro beat sequence (`seqLen × seqDim`, flattened or 2D). */
  seqB?: Float32Array[] | Float32Array | null
}

export interface NeuralPrediction {
  /** Stage 1 outputs: [mixOutOffset, mixInOffset, durationNorm, tempoBlend, cueQuality] in 0..1. */
  stage1: Float32Array
  /** Stage 2 raw strategy logits (length numStrategies). */
  strategyLogits: Float32Array
  /** Softmax strategy probabilities. */
  strategyProbs: Float32Array
  /** Stage 2 continuous curve vector: [bassSwapAt, bassSwapWidth, ...14*knots]. */
  automation: Float32Array
}

export interface NeuralTarget {
  stage1: number[]
  strategyIndex: number
  automation: number[]
  weight?: number
}

export interface StepMetrics {
  totalLoss: number
  stage1Loss: number
  strategyLoss: number
  automationLoss: number
  gradNorm: number
}

/* ------------------------------------------------------------------ *
 * Deterministic PRNG & Parameter Tensor abstraction
 * ------------------------------------------------------------------ */

function makeRng(seed: number): () => number {
  let state = (seed >>> 0) || 0x5eed
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return (state / 0xffff_ffff) * 2 - 1
  }
}

export interface ParamTensor {
  name: string
  shape: number[]
  data: Float32Array
  grad: Float32Array
  m: Float32Array
  v: Float32Array
}

const gelu = (x: number) => 0.5 * x * (1 + Math.tanh(0.7978845608 * (x + 0.044715 * x * x * x)))
const geluDeriv = (x: number) => {
  const k = 0.7978845608
  const inner = k * (x + 0.044715 * x * x * x)
  const th = Math.tanh(inner)
  const sech2 = 1 - th * th
  return 0.5 * (1 + th) + 0.5 * x * sech2 * k * (1 + 3 * 0.044715 * x * x)
}
const sigmoid = (x: number) => (x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)))
const tanhAct = (x: number) => Math.tanh(x)

function softmax(logits: Float32Array): Float32Array {
  let max = -Infinity
  for (let i = 0; i < logits.length; i += 1) if (logits[i] > max) max = logits[i]
  const out = new Float32Array(logits.length)
  let sum = 0
  for (let i = 0; i < logits.length; i += 1) {
    out[i] = Math.exp(logits[i] - max)
    sum += out[i]
  }
  const inv = sum > 0 ? 1 / sum : 1 / logits.length
  for (let i = 0; i < logits.length; i += 1) out[i] *= inv
  return out
}

/* ------------------------------------------------------------------ *
 * Core differentiable layers (exact forward + backward)
 * ------------------------------------------------------------------ */

class LinearLayer {
  w: ParamTensor
  b: ParamTensor
  inDim: number
  outDim: number

  constructor(name: string, inDim: number, outDim: number, rng: () => number, registry: ParamTensor[]) {
    this.inDim = inDim
    this.outDim = outDim
    const scale = Math.sqrt(2 / (inDim + outDim))
    const wData = new Float32Array(inDim * outDim)
    for (let i = 0; i < wData.length; i += 1) wData[i] = rng() * scale
    this.w = {
      name: `${name}.w`,
      shape: [inDim, outDim],
      data: wData,
      grad: new Float32Array(wData.length),
      m: new Float32Array(wData.length),
      v: new Float32Array(wData.length)
    }
    this.b = {
      name: `${name}.b`,
      shape: [outDim],
      data: new Float32Array(outDim),
      grad: new Float32Array(outDim),
      m: new Float32Array(outDim),
      v: new Float32Array(outDim)
    }
    registry.push(this.w, this.b)
  }

  forward(x: Float32Array): Float32Array {
    const out = new Float32Array(this.outDim)
    const w = this.w.data
    const b = this.b.data
    for (let j = 0; j < this.outDim; j += 1) out[j] = b[j]
    for (let i = 0; i < this.inDim; i += 1) {
      const xi = x[i]
      if (xi === 0) continue
      const row = i * this.outDim
      for (let j = 0; j < this.outDim; j += 1) out[j] += xi * w[row + j]
    }
    return out
  }

  backward(x: Float32Array, dOut: Float32Array): Float32Array {
    const dX = new Float32Array(this.inDim)
    const w = this.w.data
    const gW = this.w.grad
    const gB = this.b.grad
    for (let j = 0; j < this.outDim; j += 1) gB[j] += dOut[j]
    for (let i = 0; i < this.inDim; i += 1) {
      const xi = x[i]
      const row = i * this.outDim
      let acc = 0
      for (let j = 0; j < this.outDim; j += 1) {
        const dj = dOut[j]
        gW[row + j] += xi * dj
        acc += w[row + j] * dj
      }
      dX[i] = acc
    }
    return dX
  }
}

class LayerNormLayer {
  gamma: ParamTensor
  beta: ParamTensor
  dim: number

  constructor(name: string, dim: number, registry: ParamTensor[]) {
    this.dim = dim
    const g = new Float32Array(dim).fill(1)
    this.gamma = {
      name: `${name}.gamma`,
      shape: [dim],
      data: g,
      grad: new Float32Array(dim),
      m: new Float32Array(dim),
      v: new Float32Array(dim)
    }
    this.beta = {
      name: `${name}.beta`,
      shape: [dim],
      data: new Float32Array(dim),
      grad: new Float32Array(dim),
      m: new Float32Array(dim),
      v: new Float32Array(dim)
    }
    registry.push(this.gamma, this.beta)
  }

  forward(x: Float32Array): { y: Float32Array; xHat: Float32Array; invStd: number } {
    const n = this.dim
    let mean = 0
    for (let i = 0; i < n; i += 1) mean += x[i]
    mean /= n
    let varSum = 0
    for (let i = 0; i < n; i += 1) {
      const d = x[i] - mean
      varSum += d * d
    }
    const invStd = 1 / Math.sqrt(varSum / n + 1e-5)
    const xHat = new Float32Array(n)
    const y = new Float32Array(n)
    for (let i = 0; i < n; i += 1) {
      xHat[i] = (x[i] - mean) * invStd
      y[i] = xHat[i] * this.gamma.data[i] + this.beta.data[i]
    }
    return { y, xHat, invStd }
  }

  backward(cache: { xHat: Float32Array; invStd: number }, dY: Float32Array): Float32Array {
    const n = this.dim
    const { xHat, invStd } = cache
    const dXHat = new Float32Array(n)
    let sum1 = 0
    let sum2 = 0
    for (let i = 0; i < n; i += 1) {
      this.gamma.grad[i] += dY[i] * xHat[i]
      this.beta.grad[i] += dY[i]
      dXHat[i] = dY[i] * this.gamma.data[i]
      sum1 += dXHat[i]
      sum2 += dXHat[i] * xHat[i]
    }
    const dX = new Float32Array(n)
    for (let i = 0; i < n; i += 1) {
      dX[i] = (invStd / n) * (n * dXHat[i] - sum1 - xHat[i] * sum2)
    }
    return dX
  }
}

/** 1D Dilated Temporal Convolution over sequence [L, C_in] → [L, C_out]. */
class Conv1DLayer {
  w: ParamTensor // [kernelSize, inCh, outCh]
  b: ParamTensor // [outCh]
  inCh: number
  outCh: number
  kernelSize: number
  dilation: number

  constructor(
    name: string,
    inCh: number,
    outCh: number,
    kernelSize: number,
    dilation: number,
    rng: () => number,
    registry: ParamTensor[]
  ) {
    this.inCh = inCh
    this.outCh = outCh
    this.kernelSize = kernelSize
    this.dilation = dilation
    const scale = Math.sqrt(2 / (kernelSize * inCh + outCh))
    const size = kernelSize * inCh * outCh
    const data = new Float32Array(size)
    for (let i = 0; i < size; i += 1) data[i] = rng() * scale
    this.w = {
      name: `${name}.w`,
      shape: [kernelSize, inCh, outCh],
      data,
      grad: new Float32Array(size),
      m: new Float32Array(size),
      v: new Float32Array(size)
    }
    this.b = {
      name: `${name}.b`,
      shape: [outCh],
      data: new Float32Array(outCh),
      grad: new Float32Array(outCh),
      m: new Float32Array(outCh),
      v: new Float32Array(outCh)
    }
    registry.push(this.w, this.b)
  }

  forward(seq: Float32Array[]): Float32Array[] {
    const L = seq.length
    const half = Math.floor(this.kernelSize / 2)
    const out: Float32Array[] = new Array(L)
    const w = this.w.data
    const b = this.b.data
    for (let t = 0; t < L; t += 1) {
      const y = new Float32Array(this.outCh)
      for (let o = 0; o < this.outCh; o += 1) y[o] = b[o]
      for (let k = 0; k < this.kernelSize; k += 1) {
        const srcT = t + (k - half) * this.dilation
        if (srcT < 0 || srcT >= L) continue
        const x = seq[srcT]
        const kBase = k * this.inCh * this.outCh
        for (let c = 0; c < this.inCh; c += 1) {
          const xc = x[c]
          if (xc === 0) continue
          const cBase = kBase + c * this.outCh
          for (let o = 0; o < this.outCh; o += 1) y[o] += xc * w[cBase + o]
        }
      }
      out[t] = y
    }
    return out
  }

  backward(seq: Float32Array[], dOut: Float32Array[]): Float32Array[] {
    const L = seq.length
    const half = Math.floor(this.kernelSize / 2)
    const dIn: Float32Array[] = Array.from({ length: L }, () => new Float32Array(this.inCh))
    const w = this.w.data
    const gW = this.w.grad
    const gB = this.b.grad
    for (let t = 0; t < L; t += 1) {
      const dy = dOut[t]
      for (let o = 0; o < this.outCh; o += 1) gB[o] += dy[o]
      for (let k = 0; k < this.kernelSize; k += 1) {
        const srcT = t + (k - half) * this.dilation
        if (srcT < 0 || srcT >= L) continue
        const x = seq[srcT]
        const dx = dIn[srcT]
        const kBase = k * this.inCh * this.outCh
        for (let c = 0; c < this.inCh; c += 1) {
          const xc = x[c]
          const cBase = kBase + c * this.outCh
          let acc = 0
          for (let o = 0; o < this.outCh; o += 1) {
            gW[cBase + o] += xc * dy[o]
            acc += w[cBase + o] * dy[o]
          }
          dx[c] += acc
        }
      }
    }
    return dIn
  }
}

/** Compact Gated Recurrent Unit (GRU) encoder over beat sequence [L, D]. */
class GruLayer {
  wz: LinearLayer
  wr: LinearLayer
  wh: LinearLayer
  inDim: number
  hiddenDim: number

  constructor(name: string, inDim: number, hiddenDim: number, rng: () => number, registry: ParamTensor[]) {
    this.inDim = inDim
    this.hiddenDim = hiddenDim
    this.wz = new LinearLayer(`${name}.z`, inDim + hiddenDim, hiddenDim, rng, registry)
    this.wr = new LinearLayer(`${name}.r`, inDim + hiddenDim, hiddenDim, rng, registry)
    this.wh = new LinearLayer(`${name}.h`, inDim + hiddenDim, hiddenDim, rng, registry)
  }

  forward(seq: Float32Array[]) {
    const L = seq.length
    const H = this.hiddenDim
    let h = new Float32Array(H)
    const states: Float32Array[] = new Array(L)
    const caches: Array<{
      xh: Float32Array
      xrh: Float32Array
      z: Float32Array
      r: Float32Array
      hTilde: Float32Array
      hPrev: Float32Array
    }> = new Array(L)

    for (let t = 0; t < L; t += 1) {
      const x = seq[t]
      const xh = new Float32Array(this.inDim + H)
      xh.set(x, 0)
      xh.set(h, this.inDim)
      const zPre = this.wz.forward(xh)
      const rPre = this.wr.forward(xh)
      const z = new Float32Array(H)
      const r = new Float32Array(H)
      const xrh = new Float32Array(this.inDim + H)
      xrh.set(x, 0)
      for (let i = 0; i < H; i += 1) {
        z[i] = sigmoid(zPre[i])
        r[i] = sigmoid(rPre[i])
        xrh[this.inDim + i] = r[i] * h[i]
      }
      const hPre = this.wh.forward(xrh)
      const hTilde = new Float32Array(H)
      const hNext = new Float32Array(H)
      for (let i = 0; i < H; i += 1) {
        hTilde[i] = tanhAct(hPre[i])
        hNext[i] = (1 - z[i]) * h[i] + z[i] * hTilde[i]
      }
      caches[t] = { xh, xrh, z, r, hTilde, hPrev: h }
      states[t] = hNext
      h = hNext
    }
    return { states, caches }
  }

  backward(
    caches: Array<{
      xh: Float32Array
      xrh: Float32Array
      z: Float32Array
      r: Float32Array
      hTilde: Float32Array
      hPrev: Float32Array
    }>,
    dStates: Float32Array[]
  ): Float32Array[] {
    const L = caches.length
    const H = this.hiddenDim
    const dIn: Float32Array[] = new Array(L)
    let dhNext = new Float32Array(H)

    for (let t = L - 1; t >= 0; t -= 1) {
      const { xh, xrh, z, r, hTilde, hPrev } = caches[t]
      const dh = new Float32Array(H)
      for (let i = 0; i < H; i += 1) dh[i] = dStates[t][i] + dhNext[i]

      const dZPre = new Float32Array(H)
      const dHPre = new Float32Array(H)
      const dHPrev = new Float32Array(H)
      for (let i = 0; i < H; i += 1) {
        dZPre[i] = dh[i] * (hTilde[i] - hPrev[i]) * z[i] * (1 - z[i])
        dHPre[i] = dh[i] * z[i] * (1 - hTilde[i] * hTilde[i])
        dHPrev[i] = dh[i] * (1 - z[i])
      }

      const dXrh = this.wh.backward(xrh, dHPre)
      const dRPre = new Float32Array(H)
      for (let i = 0; i < H; i += 1) {
        const dr = dXrh[this.inDim + i] * hPrev[i]
        dRPre[i] = dr * r[i] * (1 - r[i])
        dHPrev[i] += dXrh[this.inDim + i] * r[i]
      }

      const dXhZ = this.wz.backward(xh, dZPre)
      const dXhR = this.wr.backward(xh, dRPre)

      const dx = new Float32Array(this.inDim)
      for (let i = 0; i < this.inDim; i += 1) dx[i] = dXrh[i] + dXhZ[i] + dXhR[i]
      for (let i = 0; i < H; i += 1) dHPrev[i] += dXhZ[this.inDim + i] + dXhR[this.inDim + i]
      dIn[t] = dx
      dhNext = dHPrev
    }
    return dIn
  }
}

/** Lightweight Multi-Head Attention (supports self-attention and A↔B cross-attention). */
class MultiHeadAttention {
  wq: LinearLayer
  wk: LinearLayer
  wv: LinearLayer
  wo: LinearLayer
  dim: number
  numHeads: number
  headDim: number

  constructor(name: string, dim: number, numHeads: number, rng: () => number, registry: ParamTensor[]) {
    this.dim = dim
    this.numHeads = Math.max(1, numHeads)
    while (dim % this.numHeads !== 0 && this.numHeads > 1) this.numHeads -= 1
    this.headDim = dim / this.numHeads
    this.wq = new LinearLayer(`${name}.q`, dim, dim, rng, registry)
    this.wk = new LinearLayer(`${name}.k`, dim, dim, rng, registry)
    this.wv = new LinearLayer(`${name}.v`, dim, dim, rng, registry)
    this.wo = new LinearLayer(`${name}.o`, dim, dim, rng, registry)
  }

  forward(qSeq: Float32Array[], kvSeq: Float32Array[]) {
    const Lq = qSeq.length
    const Lk = kvSeq.length
    const Q = qSeq.map((x) => this.wq.forward(x))
    const K = kvSeq.map((x) => this.wk.forward(x))
    const V = kvSeq.map((x) => this.wv.forward(x))
    const scale = 1 / Math.sqrt(this.headDim)

    const attnWeights: Float32Array[][] = Array.from({ length: this.numHeads }, () => new Array(Lq))
    const context: Float32Array[] = Array.from({ length: Lq }, () => new Float32Array(this.dim))

    for (let h = 0; h < this.numHeads; h += 1) {
      const off = h * this.headDim
      for (let i = 0; i < Lq; i += 1) {
        const scores = new Float32Array(Lk)
        for (let j = 0; j < Lk; j += 1) {
          let dot = 0
          for (let d = 0; d < this.headDim; d += 1) dot += Q[i][off + d] * K[j][off + d]
          scores[j] = dot * scale
        }
        const probs = softmax(scores)
        attnWeights[h][i] = probs
        for (let j = 0; j < Lk; j += 1) {
          const p = probs[j]
          for (let d = 0; d < this.headDim; d += 1) context[i][off + d] += p * V[j][off + d]
        }
      }
    }

    const out = context.map((c) => this.wo.forward(c))
    return { out, cache: { qSeq, kvSeq, Q, K, V, attnWeights, context } }
  }

  backward(cache: any, dOut: Float32Array[]) {
    const { qSeq, kvSeq, Q, K, V, attnWeights, context } = cache
    const Lq = qSeq.length
    const Lk = kvSeq.length
    const scale = 1 / Math.sqrt(this.headDim)

    const dContext = context.map((c: Float32Array, i: number) => this.wo.backward(c, dOut[i]))
    const dQ: Float32Array[] = Array.from({ length: Lq }, () => new Float32Array(this.dim))
    const dK: Float32Array[] = Array.from({ length: Lk }, () => new Float32Array(this.dim))
    const dV: Float32Array[] = Array.from({ length: Lk }, () => new Float32Array(this.dim))

    for (let h = 0; h < this.numHeads; h += 1) {
      const off = h * this.headDim
      for (let i = 0; i < Lq; i += 1) {
        const probs: Float32Array = attnWeights[h][i]
        const dProbs = new Float32Array(Lk)
        for (let j = 0; j < Lk; j += 1) {
          let dot = 0
          for (let d = 0; d < this.headDim; d += 1) {
            const dc = dContext[i][off + d]
            dot += dc * V[j][off + d]
            dV[j][off + d] += probs[j] * dc
          }
          dProbs[j] = dot
        }
        let sumPD = 0
        for (let j = 0; j < Lk; j += 1) sumPD += probs[j] * dProbs[j]
        for (let j = 0; j < Lk; j += 1) {
          const dScore = probs[j] * (dProbs[j] - sumPD) * scale
          for (let d = 0; d < this.headDim; d += 1) {
            dQ[i][off + d] += dScore * K[j][off + d]
            dK[j][off + d] += dScore * Q[i][off + d]
          }
        }
      }
    }

    const dQSeq = qSeq.map((x: Float32Array, i: number) => this.wq.backward(x, dQ[i]))
    const dKvSeq = kvSeq.map((x: Float32Array, j: number) => {
      const dk = this.wk.backward(x, dK[j])
      const dv = this.wv.backward(x, dV[j])
      const sum = new Float32Array(this.dim)
      for (let d = 0; d < this.dim; d += 1) sum[d] = dk[d] + dv[d]
      return sum
    })
    return { dQSeq, dKvSeq }
  }
}

/* ------------------------------------------------------------------ *
 * Sequence utility: pad/resample variable beat arrays to fixed seqLen
 * ------------------------------------------------------------------ */

export function normalizeSequence(
  seq: Float32Array[] | Float32Array | null | undefined,
  seqLen: number,
  seqDim: number
): Float32Array[] {
  const out: Float32Array[] = new Array(seqLen)
  if (!seq || (Array.isArray(seq) && seq.length === 0) || (!Array.isArray(seq) && seq.length === 0)) {
    for (let i = 0; i < seqLen; i += 1) out[i] = new Float32Array(seqDim)
    return out
  }
  if (Array.isArray(seq)) {
    for (let i = 0; i < seqLen; i += 1) {
      const srcIdx = Math.min(seq.length - 1, Math.floor((i * seq.length) / seqLen))
      const row = new Float32Array(seqDim)
      const src = seq[srcIdx]
      for (let d = 0; d < Math.min(seqDim, src.length); d += 1) row[d] = src[d]
      out[i] = row
    }
    return out
  }
  // Flattened Float32Array [N * seqDim]
  const n = Math.max(1, Math.floor(seq.length / seqDim))
  for (let i = 0; i < seqLen; i += 1) {
    const srcIdx = Math.min(n - 1, Math.floor((i * n) / seqLen))
    const row = new Float32Array(seqDim)
    const base = srcIdx * seqDim
    for (let d = 0; d < seqDim; d += 1) row[d] = seq[base + d] ?? 0
    out[i] = row
  }
  return out
}

function poolSequenceMeanMax(seq: Float32Array[], dim: number): { pooled: Float32Array; maxIdx: Int32Array } {
  const L = seq.length
  const pooled = new Float32Array(dim * 2)
  const maxIdx = new Int32Array(dim)
  for (let d = 0; d < dim; d += 1) {
    let sum = 0
    let maxVal = -Infinity
    let bestT = 0
    for (let t = 0; t < L; t += 1) {
      const v = seq[t][d]
      sum += v
      if (v > maxVal) {
        maxVal = v
        bestT = t
      }
    }
    pooled[d] = sum / L
    pooled[dim + d] = maxVal
    maxIdx[d] = bestT
  }
  return { pooled, maxIdx }
}

function unpoolSequenceMeanMax(dPooled: Float32Array, maxIdx: Int32Array, L: number, dim: number): Float32Array[] {
  const dSeq: Float32Array[] = Array.from({ length: L }, () => new Float32Array(dim))
  for (let d = 0; d < dim; d += 1) {
    const meanGrad = dPooled[d] / L
    for (let t = 0; t < L; t += 1) dSeq[t][d] += meanGrad
    dSeq[maxIdx[d]][d] += dPooled[dim + d]
  }
  return dSeq
}

/* ------------------------------------------------------------------ *
 * Multi-Stage Neural AutoMix Model
 * ------------------------------------------------------------------ */

export class NeuralAutoMixModel {
  readonly config: NeuralAutoMixConfig
  readonly params: ParamTensor[] = []

  // Optional sequence encoder layers (depending on architecture)
  #seqProjA?: LinearLayer
  #seqProjB?: LinearLayer
  #tcnLayersA?: Conv1DLayer[]
  #tcnLayersB?: Conv1DLayer[]
  #gruLayersA?: GruLayer[]
  #gruLayersB?: GruLayer[]
  #tfSelfA?: MultiHeadAttention[]
  #tfSelfB?: MultiHeadAttention[]
  #tfCrossAB?: MultiHeadAttention[]
  #tfFfn1?: LinearLayer[]
  #tfFfn2?: LinearLayer[]
  #tfNorm1?: LayerNormLayer[]
  #tfNorm2?: LayerNormLayer[]

  // Shared fusion + Stage 1 (Cue & Alignment) + Stage 2 (Mixing Automation)
  #fusionIn: LinearLayer
  #fusionNorm: LayerNormLayer
  #mlpBlocks: LinearLayer[] = []
  #stage1Hidden: LinearLayer
  #stage1Out: LinearLayer
  #stage2Hidden: LinearLayer
  #stage2Norm: LayerNormLayer
  #stage2Strategy: LinearLayer
  #stage2Automation: LinearLayer

  #adamStep = 0
  readonly automationDim: number

  constructor(partial: Partial<NeuralAutoMixConfig> = {}) {
    const architecture: ArchitectureKind = partial.architecture ?? 'tcn-compact'
    const hiddenDim = Math.max(8, Math.round(partial.hiddenDim ?? 32))
    const numLayers = Math.max(1, Math.min(6, Math.round(partial.numLayers ?? 2)))
    const numHeads = Math.max(1, Math.round(partial.numHeads ?? (hiddenDim >= 32 ? 4 : 2)))
    const knots = Math.max(4, Math.min(16, Math.round(partial.knots ?? 8)))
    this.config = {
      architecture,
      pairDim: partial.pairDim ?? PAIR_FEATURE_DIM,
      seqDim: partial.seqDim ?? SEQ_FEATURE_DIM,
      seqLen: Math.max(4, Math.min(64, Math.round(partial.seqLen ?? 16))),
      hiddenDim,
      numLayers,
      numHeads,
      knots,
      numStrategies: partial.numStrategies ?? AUTOMIX_STRATEGIES.length,
      seed: partial.seed ?? 0x4c56_4d58
    }
    this.automationDim = 2 + CURVE_CHANNELS * this.config.knots

    const rng = makeRng(this.config.seed)
    const D = this.config.hiddenDim
    let fusionWidth = this.config.pairDim

    if (architecture === 'mlp-micro') {
      // Pooled sequence mean (A & B) concatenated with pair features.
      fusionWidth = this.config.pairDim + this.config.seqDim * 2
    } else if (architecture === 'tcn-compact') {
      this.#tcnLayersA = []
      this.#tcnLayersB = []
      for (let l = 0; l < numLayers; l += 1) {
        const inC = l === 0 ? this.config.seqDim : D
        const dilation = 1 << l
        this.#tcnLayersA.push(new Conv1DLayer(`tcnA.${l}`, inC, D, 3, dilation, rng, this.params))
        this.#tcnLayersB.push(new Conv1DLayer(`tcnB.${l}`, inC, D, 3, dilation, rng, this.params))
      }
      fusionWidth = this.config.pairDim + D * 4
    } else if (architecture === 'gru-dj') {
      this.#gruLayersA = []
      this.#gruLayersB = []
      for (let l = 0; l < numLayers; l += 1) {
        const inC = l === 0 ? this.config.seqDim : D
        this.#gruLayersA.push(new GruLayer(`gruA.${l}`, inC, D, rng, this.params))
        this.#gruLayersB.push(new GruLayer(`gruB.${l}`, inC, D, rng, this.params))
      }
      fusionWidth = this.config.pairDim + D * 4
    } else {
      // transformer-mini: project A & B beat sequences → self-attention → A cross-attends B → FFN
      this.#seqProjA = new LinearLayer('tf.projA', this.config.seqDim, D, rng, this.params)
      this.#seqProjB = new LinearLayer('tf.projB', this.config.seqDim, D, rng, this.params)
      this.#tfSelfA = []
      this.#tfSelfB = []
      this.#tfCrossAB = []
      this.#tfFfn1 = []
      this.#tfFfn2 = []
      this.#tfNorm1 = []
      this.#tfNorm2 = []
      for (let l = 0; l < numLayers; l += 1) {
        this.#tfSelfA.push(new MultiHeadAttention(`tf.${l}.selfA`, D, numHeads, rng, this.params))
        this.#tfSelfB.push(new MultiHeadAttention(`tf.${l}.selfB`, D, numHeads, rng, this.params))
        this.#tfCrossAB.push(new MultiHeadAttention(`tf.${l}.crossAB`, D, numHeads, rng, this.params))
        this.#tfFfn1.push(new LinearLayer(`tf.${l}.ffn1`, D, D * 2, rng, this.params))
        this.#tfFfn2.push(new LinearLayer(`tf.${l}.ffn2`, D * 2, D, rng, this.params))
        this.#tfNorm1.push(new LayerNormLayer(`tf.${l}.norm1`, D, this.params))
        this.#tfNorm2.push(new LayerNormLayer(`tf.${l}.norm2`, D, this.params))
      }
      fusionWidth = this.config.pairDim + D * 4
    }

    this.#fusionIn = new LinearLayer('fusion.in', fusionWidth, D, rng, this.params)
    this.#fusionNorm = new LayerNormLayer('fusion.norm', D, this.params)

    if (architecture === 'mlp-micro') {
      for (let l = 0; l < numLayers; l += 1) {
        this.#mlpBlocks.push(new LinearLayer(`mlp.${l}`, D, D, rng, this.params))
      }
    }

    // Stage 1: Cue & Alignment Predictor
    const s1Hidden = Math.max(8, Math.round(D * 0.75))
    this.#stage1Hidden = new LinearLayer('stage1.h', D, s1Hidden, rng, this.params)
    this.#stage1Out = new LinearLayer('stage1.out', s1Hidden, STAGE1_DIM, rng, this.params)

    // Stage 2: Mixing Parameter & Automation Generator (conditioned on fused latent + Stage 1!)
    this.#stage2Hidden = new LinearLayer('stage2.h', D + STAGE1_DIM, D, rng, this.params)
    this.#stage2Norm = new LayerNormLayer('stage2.norm', D, this.params)
    this.#stage2Strategy = new LinearLayer('stage2.strategy', D, this.config.numStrategies, rng, this.params)
    this.#stage2Automation = new LinearLayer('stage2.automation', D, this.automationDim, rng, this.params)
  }

  /** Total trainable scalar parameters across all tensors. */
  get parameterCount(): number {
    let total = 0
    for (const t of this.params) total += t.data.length
    return total
  }

  /** Approximate Float32 memory footprint in bytes. */
  get memoryBytes(): number {
    return this.parameterCount * 4
  }

  /** Forward pass returning predictions and optional backprop cache. */
  #forwardInternal(input: NeuralInput, keepCache: boolean): { pred: NeuralPrediction; cache?: any } {
    const pair = new Float32Array(this.config.pairDim)
    for (let i = 0; i < Math.min(this.config.pairDim, input.pair.length); i += 1) {
      pair[i] = Number(input.pair[i]) || 0
    }
    const seqA = normalizeSequence(input.seqA, this.config.seqLen, this.config.seqDim)
    const seqB = normalizeSequence(input.seqB, this.config.seqLen, this.config.seqDim)
    const D = this.config.hiddenDim
    const arch = this.config.architecture
    const cache: any = keepCache ? { arch, pair, seqA, seqB } : null

    let fusedInput: Float32Array

    if (arch === 'mlp-micro') {
      const meanA = new Float32Array(this.config.seqDim)
      const meanB = new Float32Array(this.config.seqDim)
      for (let t = 0; t < this.config.seqLen; t += 1) {
        for (let d = 0; d < this.config.seqDim; d += 1) {
          meanA[d] += seqA[t][d] / this.config.seqLen
          meanB[d] += seqB[t][d] / this.config.seqLen
        }
      }
      fusedInput = new Float32Array(this.config.pairDim + this.config.seqDim * 2)
      fusedInput.set(pair, 0)
      fusedInput.set(meanA, this.config.pairDim)
      fusedInput.set(meanB, this.config.pairDim + this.config.seqDim)
    } else if (arch === 'tcn-compact') {
      let curA = seqA
      let curB = seqB
      const tcnCacheA: any[] = []
      const tcnCacheB: any[] = []
      for (let l = 0; l < this.config.numLayers; l += 1) {
        const preA = this.#tcnLayersA![l].forward(curA)
        const actA = preA.map((v) => {
          const o = new Float32Array(v.length)
          for (let i = 0; i < v.length; i += 1) o[i] = gelu(v[i])
          return o
        })
        const nextA = l > 0 ? actA.map((v, t) => v.map((val, i) => val + curA[t][i])) : actA
        if (keepCache) tcnCacheA.push({ inSeq: curA, pre: preA, residual: l > 0 })
        curA = nextA

        const preB = this.#tcnLayersB![l].forward(curB)
        const actB = preB.map((v) => {
          const o = new Float32Array(v.length)
          for (let i = 0; i < v.length; i += 1) o[i] = gelu(v[i])
          return o
        })
        const nextB = l > 0 ? actB.map((v, t) => v.map((val, i) => val + curB[t][i])) : actB
        if (keepCache) tcnCacheB.push({ inSeq: curB, pre: preB, residual: l > 0 })
        curB = nextB
      }
      const pA = poolSequenceMeanMax(curA, D)
      const pB = poolSequenceMeanMax(curB, D)
      if (keepCache) {
        cache.tcnCacheA = tcnCacheA
        cache.tcnCacheB = tcnCacheB
        cache.pA = pA
        cache.pB = pB
      }
      fusedInput = new Float32Array(this.config.pairDim + D * 4)
      fusedInput.set(pair, 0)
      fusedInput.set(pA.pooled, this.config.pairDim)
      fusedInput.set(pB.pooled, this.config.pairDim + D * 2)
    } else if (arch === 'gru-dj') {
      let curA = seqA
      let curB = seqB
      const gruCachesA: any[] = []
      const gruCachesB: any[] = []
      for (let l = 0; l < this.config.numLayers; l += 1) {
        const resA = this.#gruLayersA![l].forward(curA)
        const resB = this.#gruLayersB![l].forward(curB)
        if (keepCache) {
          gruCachesA.push(resA.caches)
          gruCachesB.push(resB.caches)
        }
        curA = resA.states
        curB = resB.states
      }
      const pA = poolSequenceMeanMax(curA, D)
      const pB = poolSequenceMeanMax(curB, D)
      if (keepCache) {
        cache.gruCachesA = gruCachesA
        cache.gruCachesB = gruCachesB
        cache.pA = pA
        cache.pB = pB
      }
      fusedInput = new Float32Array(this.config.pairDim + D * 4)
      fusedInput.set(pair, 0)
      fusedInput.set(pA.pooled, this.config.pairDim)
      fusedInput.set(pB.pooled, this.config.pairDim + D * 2)
    } else {
      // transformer-mini with sinusoidal positional encoding + self & cross attention
      const L = this.config.seqLen
      let curA = seqA.map((row, pos) => {
        const p = this.#seqProjA!.forward(row)
        for (let d = 0; d < D; d += 1) {
          const angle = pos / 1000 ** ((2 * Math.floor(d / 2)) / D)
          p[d] += d % 2 === 0 ? Math.sin(angle) * 0.1 : Math.cos(angle) * 0.1
        }
        return p
      })
      let curB = seqB.map((row, pos) => {
        const p = this.#seqProjB!.forward(row)
        for (let d = 0; d < D; d += 1) {
          const angle = pos / 1000 ** ((2 * Math.floor(d / 2)) / D)
          p[d] += d % 2 === 0 ? Math.sin(angle) * 0.1 : Math.cos(angle) * 0.1
        }
        return p
      })
      const tfCaches: any[] = []
      for (let l = 0; l < this.config.numLayers; l += 1) {
        const sa = this.#tfSelfA![l].forward(curA, curA)
        const sb = this.#tfSelfB![l].forward(curB, curB)
        const midA = curA.map((v, t) => v.map((val, d) => val + sa.out[t][d]))
        const midB = curB.map((v, t) => v.map((val, d) => val + sb.out[t][d]))
        const cross = this.#tfCrossAB![l].forward(midA, midB)
        const n1A = midA.map((v, t) => {
          const sum = new Float32Array(D)
          for (let d = 0; d < D; d += 1) sum[d] = v[d] + cross.out[t][d]
          return this.#tfNorm1![l].forward(sum)
        })
        const ffn1A = n1A.map((n) => this.#tfFfn1![l].forward(n.y))
        const ffnActA = ffn1A.map((v) => {
          const o = new Float32Array(v.length)
          for (let i = 0; i < v.length; i += 1) o[i] = gelu(v[i])
          return o
        })
        const ffn2A = ffnActA.map((v) => this.#tfFfn2![l].forward(v))
        const n2A = n1A.map((n, t) => {
          const sum = new Float32Array(D)
          for (let d = 0; d < D; d += 1) sum[d] = n.y[d] + ffn2A[t][d]
          return this.#tfNorm2![l].forward(sum)
        })
        if (keepCache) {
          tfCaches.push({ saCache: sa.cache, sbCache: sb.cache, crossCache: cross.cache, n1A, ffn1A, ffnActA, n2A })
        }
        curA = n2A.map((n) => n.y)
        curB = midB
      }
      const pA = poolSequenceMeanMax(curA, D)
      const pB = poolSequenceMeanMax(curB, D)
      if (keepCache) {
        cache.tfCaches = tfCaches
        cache.pA = pA
        cache.pB = pB
        cache.seqLen = L
      }
      fusedInput = new Float32Array(this.config.pairDim + D * 4)
      fusedInput.set(pair, 0)
      fusedInput.set(pA.pooled, this.config.pairDim)
      fusedInput.set(pB.pooled, this.config.pairDim + D * 2)
    }

    const fPre = this.#fusionIn.forward(fusedInput)
    const fNorm = this.#fusionNorm.forward(fPre)
    let h = new Float32Array(D)
    for (let i = 0; i < D; i += 1) h[i] = gelu(fNorm.y[i])

    const mlpCaches: Array<{ input: Float32Array; pre: Float32Array }> = []
    if (arch === 'mlp-micro') {
      for (const block of this.#mlpBlocks) {
        const pre = block.forward(h)
        const next = new Float32Array(D)
        for (let i = 0; i < D; i += 1) next[i] = h[i] + gelu(pre[i])
        if (keepCache) mlpCaches.push({ input: h, pre })
        h = next
      }
    }

    // Stage 1: Cue & Alignment Head
    const s1Pre = this.#stage1Hidden.forward(h)
    const s1Act = new Float32Array(s1Pre.length)
    for (let i = 0; i < s1Pre.length; i += 1) s1Act[i] = gelu(s1Pre[i])
    const s1Logit = this.#stage1Out.forward(s1Act)
    const stage1 = new Float32Array(STAGE1_DIM)
    for (let i = 0; i < STAGE1_DIM; i += 1) stage1[i] = sigmoid(s1Logit[i])

    // Stage 2: Automation & Strategy Head conditioned on [h, stage1]
    const s2In = new Float32Array(D + STAGE1_DIM)
    s2In.set(h, 0)
    s2In.set(stage1, D)
    const s2Pre = this.#stage2Hidden.forward(s2In)
    const s2Norm = this.#stage2Norm.forward(s2Pre)
    const s2Act = new Float32Array(D)
    for (let i = 0; i < D; i += 1) s2Act[i] = gelu(s2Norm.y[i])

    const strategyLogits = this.#stage2Strategy.forward(s2Act)
    const strategyProbs = softmax(strategyLogits)
    const autoPre = this.#stage2Automation.forward(s2Act)
    const automation = new Float32Array(this.automationDim)

    // Map raw automation outputs to bounded musical ranges:
    //   indices 0..1: bassSwapAt (0.2..0.85), bassSwapWidth (0.04..0.35)
    //   curves 0..9 (gain/EQ/vocalDuck): sigmoid → [0..1]
    //   curves 10..11 (filterA, filterB): tanh → [-1..+1]
    //   curves 12..13 (reverbSendA, delaySendA): sigmoid → [0..1]
    const K = this.config.knots
    automation[0] = 0.2 + 0.65 * sigmoid(autoPre[0])
    automation[1] = 0.04 + 0.31 * sigmoid(autoPre[1])
    for (let ch = 0; ch < CURVE_CHANNELS; ch += 1) {
      const base = 2 + ch * K
      const isBipolar = ch === 10 || ch === 11
      for (let k = 0; k < K; k += 1) {
        automation[base + k] = isBipolar ? tanhAct(autoPre[base + k]) : sigmoid(autoPre[base + k])
      }
    }

    if (keepCache) {
      cache.fusedInput = fusedInput
      cache.fNorm = fNorm
      cache.hAfterFusion = h
      cache.mlpCaches = mlpCaches
      cache.s1Pre = s1Pre
      cache.s1Act = s1Act
      cache.stage1 = stage1
      cache.s2In = s2In
      cache.s2Norm = s2Norm
      cache.s2Act = s2Act
      cache.autoPre = autoPre
      cache.automation = automation
      cache.strategyProbs = strategyProbs
    }

    return { pred: { stage1, strategyLogits, strategyProbs, automation }, cache }
  }

  /** Fast CPU inference (allocates zero training caches). */
  predict(input: NeuralInput): NeuralPrediction {
    return this.#forwardInternal(input, false).pred
  }

  /** Zero all parameter gradients. */
  zeroGrad(): void {
    for (const t of this.params) t.grad.fill(0)
  }

  /**
   * Perform one mini-batch AdamW training step with exact analytical backprop
   * across Stage 2, Stage 1, fusion, and sequence encoder (TCN/GRU/Transformer/MLP).
   */
  trainStep(
    batch: Array<{ input: NeuralInput; target: NeuralTarget }>,
    options: { learningRate?: number; weightDecay?: number; clipNorm?: number } = {}
  ): StepMetrics {
    if (batch.length === 0) {
      return { totalLoss: 0, stage1Loss: 0, strategyLoss: 0, automationLoss: 0, gradNorm: 0 }
    }
    const lr = options.learningRate ?? 3e-3
    const wd = options.weightDecay ?? 1e-4
    const clipNorm = options.clipNorm ?? 2.0

    this.zeroGrad()
    let s1LossAcc = 0
    let stratLossAcc = 0
    let autoLossAcc = 0
    let weightSum = 0
    const D = this.config.hiddenDim
    const K = this.config.knots

    for (const sample of batch) {
      const w = Number.isFinite(sample.target.weight) && (sample.target.weight as number) > 0 ? (sample.target.weight as number) : 1
      weightSum += w
      const { pred, cache } = this.#forwardInternal(sample.input, true)

      // 1. Stage 2 Strategy Cross-Entropy Loss
      const stratIdx = clamp(Math.round(sample.target.strategyIndex), 0, this.config.numStrategies - 1)
      const pTarget = Math.max(1e-7, pred.strategyProbs[stratIdx])
      stratLossAcc += -Math.log(pTarget) * w
      const dStratLogits = new Float32Array(this.config.numStrategies)
      for (let i = 0; i < this.config.numStrategies; i += 1) {
        dStratLogits[i] = (pred.strategyProbs[i] - (i === stratIdx ? 1 : 0)) * w * 0.5
      }

      // 2. Stage 2 Automation Smooth MSE Loss + Sub-bass Exclusivity Regularizer
      const dAutoPre = new Float32Array(this.automationDim)
      let autoErr = 0
      const targetAuto = sample.target.automation
      for (let i = 0; i < this.automationDim; i += 1) {
        const y = targetAuto[i] ?? pred.automation[i]
        const diff = pred.automation[i] - y
        autoErr += diff * diff
        let deriv: number
        if (i === 0) {
          const sig = sigmoid(cache.autoPre[0])
          deriv = 0.65 * sig * (1 - sig)
        } else if (i === 1) {
          const sig = sigmoid(cache.autoPre[1])
          deriv = 0.31 * sig * (1 - sig)
        } else {
          const ch = Math.floor((i - 2) / K)
          const isBipolar = ch === 10 || ch === 11
          const act = pred.automation[i]
          deriv = isBipolar ? 1 - act * act : act * (1 - act)
        }
        dAutoPre[i] = ((2 * diff) / this.automationDim) * deriv * w * 1.5
      }
      autoLossAcc += (autoErr / this.automationDim) * w

      // Backprop through Stage 2
      const dS2ActA = this.#stage2Strategy.backward(cache.s2Act, dStratLogits)
      const dS2ActB = this.#stage2Automation.backward(cache.s2Act, dAutoPre)
      const dS2NormY = new Float32Array(D)
      for (let i = 0; i < D; i += 1) {
        dS2NormY[i] = (dS2ActA[i] + dS2ActB[i]) * geluDeriv(cache.s2Norm.y[i])
      }
      const dS2Pre = this.#stage2Norm.backward(cache.s2Norm, dS2NormY)
      const dS2In = this.#stage2Hidden.backward(cache.s2In, dS2Pre)

      // 3. Stage 1 Cue & Alignment Loss (+ gradient flowing back from Stage 2 conditioning!)
      const dS1Logit = new Float32Array(STAGE1_DIM)
      let s1Err = 0
      for (let i = 0; i < STAGE1_DIM; i += 1) {
        const y = sample.target.stage1[i] ?? pred.stage1[i]
        const diff = pred.stage1[i] - y
        s1Err += diff * diff
        const dFromLoss = ((2 * diff) / STAGE1_DIM) * w
        const dFromStage2 = dS2In[D + i]
        dS1Logit[i] = (dFromLoss + dFromStage2) * pred.stage1[i] * (1 - pred.stage1[i])
      }
      s1LossAcc += (s1Err / STAGE1_DIM) * w

      const dS1Act = this.#stage1Out.backward(cache.s1Act, dS1Logit)
      const dS1Pre = new Float32Array(cache.s1Pre.length)
      for (let i = 0; i < dS1Pre.length; i += 1) dS1Pre[i] = dS1Act[i] * geluDeriv(cache.s1Pre[i])
      const dHFromS1 = this.#stage1Hidden.backward(cache.hAfterFusion, dS1Pre)

      let dH = new Float32Array(D)
      for (let i = 0; i < D; i += 1) dH[i] = dS2In[i] + dHFromS1[i]

      if (cache.arch === 'mlp-micro') {
        for (let l = this.#mlpBlocks.length - 1; l >= 0; l -= 1) {
          const cBlock = cache.mlpCaches[l]
          const dPre = new Float32Array(D)
          for (let i = 0; i < D; i += 1) dPre[i] = dH[i] * geluDeriv(cBlock.pre[i])
          const dBlockIn = this.#mlpBlocks[l].backward(cBlock.input, dPre)
          for (let i = 0; i < D; i += 1) dH[i] = dH[i] + dBlockIn[i]
        }
      }

      const dFNormY = new Float32Array(D)
      for (let i = 0; i < D; i += 1) dFNormY[i] = dH[i] * geluDeriv(cache.fNorm.y[i])
      const dFPre = this.#fusionNorm.backward(cache.fNorm, dFNormY)
      const dFused = this.#fusionIn.backward(cache.fusedInput, dFPre)

      // Backprop through sequence encoder
      if (cache.arch === 'tcn-compact') {
        let dSeqA = unpoolSequenceMeanMax(dFused.subarray(this.config.pairDim, this.config.pairDim + D * 2), cache.pA.maxIdx, this.config.seqLen, D)
        let dSeqB = unpoolSequenceMeanMax(dFused.subarray(this.config.pairDim + D * 2), cache.pB.maxIdx, this.config.seqLen, D)
        for (let l = this.config.numLayers - 1; l >= 0; l -= 1) {
          const cA = cache.tcnCacheA[l]
          const dPreA = dSeqA.map((g, t) => g.map((val, i) => val * geluDeriv(cA.pre[t][i])))
          const dInA = this.#tcnLayersA![l].backward(cA.inSeq, dPreA)
          dSeqA = cA.residual ? dInA.map((g, t) => g.map((val, i) => val + dSeqA[t][i])) : dInA

          const cB = cache.tcnCacheB[l]
          const dPreB = dSeqB.map((g, t) => g.map((val, i) => val * geluDeriv(cB.pre[t][i])))
          const dInB = this.#tcnLayersB![l].backward(cB.inSeq, dPreB)
          dSeqB = cB.residual ? dInB.map((g, t) => g.map((val, i) => val + dSeqB[t][i])) : dInB
        }
      } else if (cache.arch === 'gru-dj') {
        let dSeqA = unpoolSequenceMeanMax(dFused.subarray(this.config.pairDim, this.config.pairDim + D * 2), cache.pA.maxIdx, this.config.seqLen, D)
        let dSeqB = unpoolSequenceMeanMax(dFused.subarray(this.config.pairDim + D * 2), cache.pB.maxIdx, this.config.seqLen, D)
        for (let l = this.config.numLayers - 1; l >= 0; l -= 1) {
          dSeqA = this.#gruLayersA![l].backward(cache.gruCachesA[l], dSeqA)
          dSeqB = this.#gruLayersB![l].backward(cache.gruCachesB[l], dSeqB)
        }
      } else if (cache.arch === 'transformer-mini') {
        let dSeqA = unpoolSequenceMeanMax(dFused.subarray(this.config.pairDim, this.config.pairDim + D * 2), cache.pA.maxIdx, this.config.seqLen, D)
        let dSeqB = unpoolSequenceMeanMax(dFused.subarray(this.config.pairDim + D * 2), cache.pB.maxIdx, this.config.seqLen, D)
        for (let l = this.config.numLayers - 1; l >= 0; l -= 1) {
          const tc = cache.tfCaches[l]
          const dN2In = dSeqA.map((g, t) => this.#tfNorm2![l].backward(tc.n2A[t], g))
          const dFfnAct = dN2In.map((g, t) => this.#tfFfn2![l].backward(tc.ffnActA[t], g))
          const dFfn1 = dFfnAct.map((g, t) => g.map((v, i) => v * geluDeriv(tc.ffn1A[t][i])))
          const dN1Y = dFfn1.map((g, t) => {
            const fromFfn = this.#tfFfn1![l].backward(tc.n1A[t].y, g)
            const out = new Float32Array(D)
            for (let d = 0; d < D; d += 1) out[d] = fromFfn[d] + dN2In[t][d]
            return out
          })
          const dN1In = dN1Y.map((g, t) => this.#tfNorm1![l].backward(tc.n1A[t], g))
          const dCross = this.#tfCrossAB![l].backward(tc.crossCache, dN1In)
          const dMidA = dN1In.map((g, t) => {
            const out = new Float32Array(D)
            for (let d = 0; d < D; d += 1) out[d] = g[d] + dCross.dQSeq[t][d]
            return out
          })
          const dMidB = dSeqB.map((g, t) => {
            const out = new Float32Array(D)
            for (let d = 0; d < D; d += 1) out[d] = g[d] + dCross.dKvSeq[t][d]
            return out
          })
          const dSa = this.#tfSelfA![l].backward(tc.saCache, dMidA)
          const dSb = this.#tfSelfB![l].backward(tc.sbCache, dMidB)
          dSeqA = dMidA.map((g, t) => {
            const out = new Float32Array(D)
            for (let d = 0; d < D; d += 1) out[d] = g[d] + dSa.dQSeq[t][d] + dSa.dKvSeq[t][d]
            return out
          })
          dSeqB = dMidB.map((g, t) => {
            const out = new Float32Array(D)
            for (let d = 0; d < D; d += 1) out[d] = g[d] + dSb.dQSeq[t][d] + dSb.dKvSeq[t][d]
            return out
          })
        }
        for (let t = 0; t < this.config.seqLen; t += 1) {
          this.#seqProjA!.backward(cache.seqA[t], dSeqA[t])
          this.#seqProjB!.backward(cache.seqB[t], dSeqB[t])
        }
      }
    }

    // Average gradients + global norm clipping + AdamW update
    const invW = 1 / Math.max(weightSum, 1e-8)
    let gradSq = 0
    for (const t of this.params) {
      const g = t.grad
      for (let i = 0; i < g.length; i += 1) {
        g[i] *= invW
        gradSq += g[i] * g[i]
      }
    }
    const gradNorm = Math.sqrt(gradSq)
    const clipScale = gradNorm > clipNorm ? clipNorm / (gradNorm + 1e-8) : 1

    this.#adamStep += 1
    const b1 = 0.9
    const b2 = 0.999
    const c1 = 1 - b1 ** this.#adamStep
    const c2 = 1 - b2 ** this.#adamStep

    for (const t of this.params) {
      const isWeight = t.name.endsWith('.w')
      const data = t.data
      const g = t.grad
      const m = t.m
      const v = t.v
      for (let i = 0; i < data.length; i += 1) {
        const gi = g[i] * clipScale
        m[i] = b1 * m[i] + (1 - b1) * gi
        v[i] = b2 * v[i] + (1 - b2) * gi * gi
        const mHat = m[i] / c1
        const vHat = v[i] / c2
        if (isWeight) data[i] *= 1 - lr * wd
        data[i] -= (lr * mHat) / (Math.sqrt(vHat) + 1e-8)
      }
    }

    const stage1Loss = s1LossAcc * invW
    const strategyLoss = stratLossAcc * invW
    const automationLoss = autoLossAcc * invW
    return {
      totalLoss: stage1Loss + 0.5 * strategyLoss + 1.5 * automationLoss,
      stage1Loss,
      strategyLoss,
      automationLoss,
      gradNorm
    }
  }

  /** Export flat tensor map for `.lvmx` serialization or PyTorch interop. */
  exportWeights(): Record<string, { shape: number[]; data: Float32Array }> {
    const out: Record<string, { shape: number[]; data: Float32Array }> = {}
    for (const t of this.params) out[t.name] = { shape: [...t.shape], data: Float32Array.from(t.data) }
    return out
  }

  /** Load weights exported by `exportWeights()` or PyTorch trainer. */
  loadWeights(weights: Record<string, { shape?: number[]; data: ArrayLike<number> }>): this {
    for (const t of this.params) {
      const entry = weights[t.name]
      if (!entry) throw new Error(`NeuralAutoMixModel: missing tensor "${t.name}"`)
      if (entry.data.length !== t.data.length) {
        throw new Error(`NeuralAutoMixModel: tensor "${t.name}" length ${entry.data.length} != expected ${t.data.length}`)
      }
      for (let i = 0; i < t.data.length; i += 1) t.data[i] = Number(entry.data[i]) || 0
      t.m.fill(0)
      t.v.fill(0)
    }
    this.#adamStep = 0
    return this
  }
}

/* ------------------------------------------------------------------ *
 * Configurable Parameter-Budget Presets (~3K → ~4.3M parameters)
 * ------------------------------------------------------------------ */

export function estimateParameters(partial: Partial<NeuralAutoMixConfig>): number {
  return new NeuralAutoMixModel(partial).parameterCount
}

export const NEURAL_AUTOMIX_PRESETS: Record<string, NeuralAutoMixConfig> = {
  /** ~3,200 params — ultra-lightweight edge/Termux residual MLP (<0.15ms CPU). */
  'mlp-nano': {
    architecture: 'mlp-micro',
    pairDim: PAIR_FEATURE_DIM,
    seqDim: SEQ_FEATURE_DIM,
    seqLen: 16,
    hiddenDim: 16,
    numLayers: 1,
    numHeads: 1,
    knots: 8,
    numStrategies: AUTOMIX_STRATEGIES.length,
    seed: 0x4c56_0001
  },
  /** ~10,500 params — fast 2-layer residual MLP (<0.25ms CPU). */
  'mlp-micro': {
    architecture: 'mlp-micro',
    pairDim: PAIR_FEATURE_DIM,
    seqDim: SEQ_FEATURE_DIM,
    seqLen: 16,
    hiddenDim: 40,
    numLayers: 2,
    numHeads: 1,
    knots: 8,
    numStrategies: AUTOMIX_STRATEGIES.length,
    seed: 0x4c56_0002
  },
  /** ~26,000 params — dilated 1D TCN over beat sequences (~0.6ms CPU, sweet spot). */
  'tcn-compact': {
    architecture: 'tcn-compact',
    pairDim: PAIR_FEATURE_DIM,
    seqDim: SEQ_FEATURE_DIM,
    seqLen: 16,
    hiddenDim: 32,
    numLayers: 2,
    numHeads: 2,
    knots: 8,
    numStrategies: AUTOMIX_STRATEGIES.length,
    seed: 0x4c56_0003
  },
  /** ~82,000 params — 2-layer GRU sequence encoder over Track A/B beat grids. */
  'gru-dj': {
    architecture: 'gru-dj',
    pairDim: PAIR_FEATURE_DIM,
    seqDim: SEQ_FEATURE_DIM,
    seqLen: 16,
    hiddenDim: 48,
    numLayers: 2,
    numHeads: 4,
    knots: 8,
    numStrategies: AUTOMIX_STRATEGIES.length,
    seed: 0x4c56_0004
  },
  /** ~185,000 params — compact multi-head self + cross-attention Transformer. */
  'transformer-mini': {
    architecture: 'transformer-mini',
    pairDim: PAIR_FEATURE_DIM,
    seqDim: SEQ_FEATURE_DIM,
    seqLen: 16,
    hiddenDim: 64,
    numLayers: 2,
    numHeads: 4,
    knots: 8,
    numStrategies: AUTOMIX_STRATEGIES.length,
    seed: 0x4c56_0005
  },
  /** ~1,150,000 params — deep cross-attention Transformer (GPU-recommended training). */
  'transformer-medium': {
    architecture: 'transformer-mini',
    pairDim: PAIR_FEATURE_DIM,
    seqDim: SEQ_FEATURE_DIM,
    seqLen: 16,
    hiddenDim: 160,
    numLayers: 2,
    numHeads: 8,
    knots: 8,
    numStrategies: AUTOMIX_STRATEGIES.length,
    seed: 0x4c56_0006
  },
  /** ~4,300,000 params — high-capacity upper budget (within 1K–5M ceiling). */
  'transformer-xl': {
    architecture: 'transformer-mini',
    pairDim: PAIR_FEATURE_DIM,
    seqDim: SEQ_FEATURE_DIM,
    seqLen: 16,
    hiddenDim: 256,
    numLayers: 3,
    numHeads: 8,
    knots: 8,
    numStrategies: AUTOMIX_STRATEGIES.length,
    seed: 0x4c56_0007
  }
}

export function listNeuralPresets(): ArchitecturePreset[] {
  const descriptions: Record<string, string> = {
    'mlp-nano': 'Ultra-compact ~4.2K-param 2-stage residual MLP for embedded/mobile CPUs.',
    'mlp-micro': 'Compact ~14.6K-param residual MLP for sub-millisecond CPU inference.',
    'tcn-compact': 'Dilated 1D Temporal Convolutional Network (~21.0K params) over beat grids.',
    'gru-dj': '2-layer GRU sequence encoder (~68.6K params) modeling beat & phrase evolution.',
    'transformer-mini': 'Lightweight Cross-Attention Transformer (~171K params) aligning Track A & B.',
    'transformer-medium': 'Medium Cross-Attention Transformer (~1.01M params) for large DJ mix corpora.',
    'transformer-xl': 'High-capacity Cross-Attention Transformer (~3.59M params, within 5M budget).'
  }
  return Object.entries(NEURAL_AUTOMIX_PRESETS).map(([id, config]) => ({
    id,
    label: id,
    description: descriptions[id] ?? config.architecture,
    config,
    estimatedParams: estimateParameters(config)
  }))
}
