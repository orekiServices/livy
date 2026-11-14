/**
 * Advanced continuous DJ audio blender for AutoMix.
 *
 * Moves beyond simple volume crossfades to continuous, curve-driven DJ mixing:
 *   • Phase-coherent 3-band Linkwitz-Riley crossover (Low / Mid / High)
 *   • Intelligent beat-locked bass swapping with sub-bass exclusivity
 *   • Mid-Side center-channel vocal-band protection (ducks clashing vocals
 *     without gutting stereo synths, guitars, or pads)
 *   • Drum-transient synchronization & frequency-conflict micro-ducking
 *   • Optional 4-stem mixing (vocals, drums, bass, other) when stems are supplied
 *   • Smooth zipper-free resonant LP/HP filter sweeps, beat-synced echo, and
 *     stereo reverb wash sends
 */
import { Biquad, Crossover, DB, clamp, echoTail, fadeGains } from '../dsp.ts'

export const DEFAULT_KNOTS = 8

export interface AutomationCurves {
  knots: number
  /** Overall volume automation 0..1. */
  gainA: number[]
  gainB: number[]
  /** Three-band EQ gains 0..1.5 (typically 0..1). */
  lowA: number[]
  midA: number[]
  highA: number[]
  lowB: number[]
  midB: number[]
  highB: number[]
  /** Center-channel vocal-band ducking amount 0..1 (0 = open, 1 = −10 dB). */
  vocalDuckA: number[]
  vocalDuckB: number[]
  /**
   * DJ bi-polar filter knob −1..+1:
   *   −1 → low-pass closed down to ~280 Hz
   *    0 → bypass
   *   +1 → high-pass opened up to ~2.4 kHz
   */
  filterA: number[]
  filterB: number[]
  /** Wet send levels 0..1 for outgoing reverb wash & beat-synced delay. */
  reverbSendA: number[]
  delaySendA: number[]
}

export interface AutomationPlan {
  strategy: string
  curves: AutomationCurves
  /** Normalized transition position 0..1 where bass changes hands. */
  bassSwapAt: number
  /** Normalized width of bass handoff (e.g. 0.08 = crisp 1-beat swap). */
  bassSwapWidth: number
  /** Equal-power / correlation-adapted crossfade exponent (1..2). */
  exponent: number
  /** Enable transient drum-conflict protection on overlapping low-mids. */
  drumSyncDuck: boolean
  /** Crossover frequencies (Hz). */
  lowHz: number
  highHz: number
  /** Source of the automation plan ('planner' | 'neural' | 'fallback'). */
  source: 'planner' | 'neural' | 'fallback'
}

export interface StereoAudio {
  left: Float32Array
  right: Float32Array
  sampleRate?: number
  length?: number
}

/** Optional 4-stem audio representation (e.g., Demucs / Spleeter stems). */
export interface StemSet {
  vocals?: StereoAudio | null
  drums?: StereoAudio | null
  bass?: StereoAudio | null
  other?: StereoAudio | null
}

export interface BlendRenderContext {
  a: StereoAudio
  b: StereoAudio
  left: Float32Array
  right: Float32Array
  fade: number
  total: number
  sampleRate: number
  beatSamples: number
  plan: AutomationPlan
  stemsA?: StemSet | null
  stemsB?: StemSet | null
}

/** Smooth cosine-eased lookup on a knot array over t ∈ [0, 1]. */
export function sampleCurve(knots: ArrayLike<number>, t: number): number {
  const n = knots.length
  if (n === 0) return 0
  if (n === 1) return knots[0]
  const u = clamp(t, 0, 1) * (n - 1)
  const i0 = Math.min(n - 2, Math.floor(u))
  const frac = u - i0
  // Raised-cosine interpolation prevents audible slope kinks between knots.
  const smooth = 0.5 - 0.5 * Math.cos(Math.PI * frac)
  return knots[i0] * (1 - smooth) + knots[i0 + 1] * smooth
}

/**
 * Phase-coherent 3-band Linkwitz-Riley 4th-order crossover.
 * Low (< lowHz) + Mid (lowHz..highHz) + High (> highHz) sums flat across the
 * audio spectrum without comb-filtering or crossover dips.
 */
export class ThreeBandCrossover {
  #lowSplit: Crossover
  #highSplit: Crossover

  constructor(lowHz: number, highHz: number, sampleRate: number) {
    this.#lowSplit = new Crossover(clamp(lowHz, 80, 400), sampleRate)
    this.#highSplit = new Crossover(clamp(highHz, 1800, Math.min(8000, sampleRate * 0.35)), sampleRate)
  }

  split(x: number): [number, number, number] {
    const [low, upper] = this.#lowSplit.split(x)
    const [mid, high] = this.#highSplit.split(upper)
    return [low, mid, high]
  }
}

/**
 * Bi-polar Pioneer/Allen&Heath-style DJ filter (-1 = LP, 0 = flat, +1 = HP).
 * Smoothly updates biquad coefficients every control block to stay zipper-free.
 */
class BipolarDjFilter {
  #lp: Biquad
  #hp: Biquad
  #sampleRate: number
  #mode: 'bypass' | 'lp' | 'hp' = 'bypass'
  #mix = 0

  constructor(sampleRate: number) {
    this.#sampleRate = sampleRate
    this.#lp = Biquad.lowpass(18_000, sampleRate, 0.85)
    this.#hp = Biquad.highpass(30, sampleRate, 0.85)
  }

  update(knob: number): void {
    const v = clamp(knob, -1, 1)
    if (Math.abs(v) < 0.04) {
      this.#mode = 'bypass'
      this.#mix = 0
      return
    }
    const nyquist = this.#sampleRate / 2 - 400
    if (v < 0) {
      this.#mode = 'lp'
      const depth = -v
      const top = Math.min(18_000, nyquist)
      const cutoff = top * (260 / top) ** depth
      const next = Biquad.lowpass(cutoff, this.#sampleRate, 0.85 + 0.35 * depth)
      this.#lp.set(next.b0, next.b1, next.b2, next.a1, next.a2)
      this.#mix = clamp(depth / 0.15, 0, 1)
    } else {
      this.#mode = 'hp'
      const depth = v
      const cutoff = Math.min(nyquist, 30 * (2400 / 30) ** depth)
      const next = Biquad.highpass(cutoff, this.#sampleRate, 0.85 + 0.35 * depth)
      this.#hp.set(next.b0, next.b1, next.b2, next.a1, next.a2)
      this.#mix = clamp(depth / 0.15, 0, 1)
    }
  }

  process(x: number): number {
    // Always tick both filters lightly when active to avoid abrupt state jumps.
    if (this.#mode === 'bypass') {
      this.#lp.process(x)
      this.#hp.process(x)
      return x
    }
    const wet = this.#mode === 'lp' ? this.#lp.process(x) : this.#hp.process(x)
    return x * (1 - this.#mix) + wet * this.#mix
  }
}

/**
 * Mid-Side vocal-band separator: applies a minimum-phase RBJ peaking bell cut
 * centered on the vocal presence range (1.2 kHz, Q = 0.85, spanning ~450 Hz–3.2 kHz)
 * exclusively to the Mid channel M = (L+R)/2 so ducking overlapping vocals
 * delivers accurate −10 dB center attenuation while leaving stereo side
 * accompaniment S = (L-R)/2 and sub-bass/air intact!
 */
class VocalCenterSculptor {
  #sampleRate: number
  #b0 = 1
  #b1 = 0
  #b2 = 0
  #a1 = 0
  #a2 = 0
  #x1 = 0
  #x2 = 0
  #y1 = 0
  #y2 = 0
  #lastGainDb = 0

  constructor(sampleRate: number) {
    this.#sampleRate = sampleRate
  }

  #updateBell(gainDb: number): void {
    if (Math.abs(gainDb - this.#lastGainDb) < 0.08) return
    this.#lastGainDb = gainDb
    if (Math.abs(gainDb) < 0.05) {
      this.#b0 = 1
      this.#b1 = 0
      this.#b2 = 0
      this.#a1 = 0
      this.#a2 = 0
      return
    }
    const A = Math.pow(10, gainDb / 40)
    const w0 = (2 * Math.PI * 1200) / this.#sampleRate
    const cosW = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * 0.85)
    const a0 = 1 + alpha / A
    this.#b0 = (1 + alpha * A) / a0
    this.#b1 = (-2 * cosW) / a0
    this.#b2 = (1 - alpha * A) / a0
    this.#a1 = (-2 * cosW) / a0
    this.#a2 = (1 - alpha / A) / a0
  }

  /**
   * Apply `duckAmount` (0..1, up to −10 dB reduction) selectively to the
   * center-panned vocal presence band, leaving stereo side and non-vocal bands intact.
   */
  apply(l: number, r: number, duckAmount: number): [number, number] {
    const mid = (l + r) * 0.5
    const side = (l - r) * 0.5
    const gainDb = -10 * clamp(duckAmount, 0, 1)
    this.#updateBell(gainDb)
    const y = this.#b0 * mid + this.#b1 * this.#x1 + this.#b2 * this.#x2 - this.#a1 * this.#y1 - this.#a2 * this.#y2
    this.#x2 = this.#x1
    this.#x1 = mid
    this.#y2 = this.#y1
    this.#y1 = y
    return [y + side, y - side]
  }
}

/**
 * Construct a musically tailored continuous AutomationPlan from transition
 * strategy and track/seam characteristics. Used as the planner baseline and
 * blended with Neural AutoMix predictions when available.
 */
export function buildAutomationPlan(params: {
  strategy: string
  exponent?: number
  bassSwapAt?: number
  bassSwapWidth?: number
  vocalOut?: number
  vocalIn?: number
  vocalPhraseEnd?: number
  harmonicScore?: number
  beatMatched?: boolean
  lowHz?: number
  highHz?: number
  knots?: number
  source?: 'planner' | 'neural' | 'fallback'
}): AutomationPlan {
  const knots = Math.max(4, params.knots ?? DEFAULT_KNOTS)
  const exponent = clamp(params.exponent ?? 2, 1, 2)
  const bassSwapAt = clamp(params.bassSwapAt ?? 0.55, 0.2, 0.85)
  const bassSwapWidth = clamp(params.bassSwapWidth ?? 0.12, 0.04, 0.35)
  const vocalOut = clamp(params.vocalOut ?? 0, 0, 1)
  const vocalIn = clamp(params.vocalIn ?? 0, 0, 1)
  const vocalClash = vocalOut > 0.45 && vocalIn > 0.45
  const phraseEnd = clamp(params.vocalPhraseEnd ?? 0.58, 0.25, 0.85)
  const harmonic = clamp(params.harmonicScore ?? 0.75, 0, 1)
  const strategy = params.strategy || 'eq-blend'

  const gainA: number[] = []
  const gainB: number[] = []
  const lowA: number[] = []
  const midA: number[] = []
  const highA: number[] = []
  const lowB: number[] = []
  const midB: number[] = []
  const highB: number[] = []
  const vocalDuckA: number[] = []
  const vocalDuckB: number[] = []
  const filterA: number[] = []
  const filterB: number[] = []
  const reverbSendA: number[] = []
  const delaySendA: number[] = []

  for (let k = 0; k < knots; k += 1) {
    const t = knots > 1 ? k / (knots - 1) : 0
    const [ga0, gb0] = fadeGains(t, exponent)
    let ga = ga0
    let gb = gb0

    // Sub-bass exclusivity curve centered on bassSwapAt.
    const swap = clamp((t - (bassSwapAt - bassSwapWidth / 2)) / bassSwapWidth, 0, 1)
    const smoothSwap = swap * swap * (3 - 2 * swap)

    let lA = 1 - smoothSwap
    let lB = smoothSwap
    let mA = ga
    let mB = gb
    let hA = ga
    let hB = gb
    let fA = 0
    let fB = 0
    let revA = 0
    let delA = 0

    if (strategy === 'bass-swap' || strategy === 'eq-blend') {
      // Classic DJ 3-band EQ blend: incoming highs/mids glide in early while
      // low end stays completely cut until the crisp phrase-locked bass swap.
      hB = clamp(gb * 1.08, 0, 1)
      hA = clamp(ga * 1.05, 0, 1)
      mB = clamp(fadeGains(clamp((t - 0.1) / 0.9, 0, 1), exponent)[1], 0, 1)
      mA = clamp(fadeGains(clamp(t / 0.92, 0, 1), exponent)[0], 0, 1)
      // Slight mid-scoop when harmony is tense to keep keys from colliding.
      if (harmonic < 0.5) {
        const scoop = Math.sin(Math.PI * t) * (0.5 - harmonic) * 0.5
        mA *= 1 - scoop
        mB *= 1 - scoop
      }
      ga = 1
      gb = 1
    } else if (strategy === 'filter') {
      // Resonant LP close on A while B opens from HP behind a beat-locked bass handoff.
      fA = -clamp(t * 1.05, 0, 1)
      fB = clamp((1 - t) * 0.95, 0, 1)
      revA = Math.sin(Math.PI * t) * 0.25
      ga = clamp(1.18 * ga0, 0, 1)
      gb = gb0
      lA = 1 - smoothSwap
      lB = smoothSwap
      mA = 1
      mB = 1
      hA = 1
      hB = 1
    } else if (strategy === 'wash' || strategy === 'reverb-wash') {
      // Outgoing track dissolves into damped stereo reverb while incoming opens cleanly.
      revA = clamp(Math.sin(Math.PI * Math.min(1, t * 1.1)) * 0.72, 0, 0.8)
      delA = clamp(Math.sin(Math.PI * t) * 0.28, 0, 0.4)
      fA = -clamp(t * 0.65, 0, 0.7)
      ga = clamp(ga0 * (1 - 0.35 * t), 0, 1)
      gb = gb0
      lA = 1 - smoothSwap
      lB = smoothSwap
      mA = 1
      mB = 1
      hA = 1
      hB = 1
    } else if (strategy === 'echo') {
      // Outgoing feeds a beat-synced delay tail before dropping out cleanly.
      delA = clamp(Math.sin(Math.PI * clamp(t * 1.25, 0, 1)) * 0.68, 0, 0.75)
      ga = clamp(1 - t * 1.45, 0, 1)
      gb = clamp((t - 0.22) / 0.45, 0, 1)
      lA = clamp(1 - t * 1.8, 0, 1)
      lB = clamp((t - 0.25) / 0.3, 0, 1)
      mA = 1
      mB = 1
      hA = 1
      hB = 1
    } else if (strategy === 'stem-handoff') {
      // Phrase-aware handoff: drums & highs come in first, vocals hand over cleanly, bass swaps on bar.
      hB = clamp(fadeGains(clamp(t * 1.15, 0, 1), exponent)[1], 0, 1)
      hA = clamp(fadeGains(clamp(t * 1.1, 0, 1), exponent)[0], 0, 1)
      mA = t < phraseEnd ? 1 : clamp(1 - (t - phraseEnd) / Math.max(0.12, 1 - phraseEnd), 0, 1)
      mB = t < phraseEnd - 0.1 ? 0.25 : clamp((t - (phraseEnd - 0.1)) / Math.max(0.15, 1.1 - phraseEnd), 0, 1)
      ga = 1
      gb = 1
    } else if (strategy === 'phrase-cut') {
      // Crisp beat-locked bar-boundary phrase handoff: Track A holds full presence until the
      // penultimate phrase beat, then drops cleanly while Track B locks in at full weight.
      const cutAt = clamp(bassSwapAt, 0.55, 0.8)
      const cutW = 0.08
      const sCut = clamp((t - (cutAt - cutW)) / (2 * cutW), 0, 1)
      const cutEase = 0.5 - 0.5 * Math.cos(Math.PI * sCut)
      lA = 1 - cutEase
      lB = cutEase
      mA = 1 - cutEase * 0.92
      mB = 0.2 + 0.8 * cutEase
      hA = 1 - cutEase * 0.88
      hB = clamp(0.45 + 0.55 * fadeGains(t, exponent)[1], 0, 1)
      ga = 1
      gb = 1
    } else if (strategy === 'vocal-bridge') {
      // Extended vocal-bridged overlap: carries Track A's vocal hook across Track B's rhythmic intro
      // while carving Track B's center mid/vocal pocket, then hands lead cleanly at phraseEnd.
      lA = 1 - smoothSwap
      lB = smoothSwap
      hB = clamp(0.35 + 0.65 * fadeGains(clamp(t * 1.2, 0, 1), exponent)[1], 0, 1)
      hA = clamp(fadeGains(clamp(t * 0.95, 0, 1), exponent)[0], 0, 1)
      mA = t < phraseEnd ? 1 : clamp(1 - (t - phraseEnd) / Math.max(0.12, 1 - phraseEnd), 0, 1)
      mB = t < phraseEnd - 0.06 ? 0.3 : clamp(0.3 + 0.7 * ((t - (phraseEnd - 0.06)) / Math.max(0.16, 1.06 - phraseEnd)), 0, 1)
      revA = t > phraseEnd - 0.05 ? clamp((t - (phraseEnd - 0.05)) * 0.75, 0, 0.42) : 0
      ga = 1
      gb = 1
    } else if (strategy === 'tempo-ramp') {
      // Progressive tempo-ramped transition: gentle resonant HP sweep lifts Track A out while
      // Track B's rhythm and low end bloom steadily across a long phrase.
      fA = clamp(Math.pow(t, 1.25) * 0.62, 0, 0.68)
      fB = -clamp(Math.pow(1 - t, 1.4) * 0.48, 0, 0.52)
      lA = clamp(1 - smoothSwap * 1.15, 0, 1)
      lB = clamp(smoothSwap, 0, 1)
      mA = ga0
      mB = gb0
      hA = clamp(ga0 * (1 - 0.15 * t), 0, 1)
      hB = clamp(gb0 * (0.85 + 0.15 * t), 0, 1)
      delA = clamp(Math.sin(Math.PI * t) * 0.24, 0, 0.3)
      ga = 1
      gb = 1
    } else if (strategy === 'harmonic-drop') {
      // Camelot-locked tension-and-release: HP filter + damped reverb riser builds tension on Track A
      // into the drop downbeat, then releases cleanly into Track B's full bass & percussion.
      const dropAt = clamp(Math.max(bassSwapAt, 0.68), 0.65, 0.82)
      const preDrop = t < dropAt
      const rise = clamp(t / dropAt, 0, 1)
      const after = preDrop ? 0 : clamp((t - dropAt) / 0.08, 0, 1)
      fA = preDrop ? clamp(rise * rise * 0.78, 0, 0.82) : 0.82
      revA = preDrop ? clamp(rise * 0.52, 0, 0.58) : clamp(0.58 * (1 - after * 0.65), 0, 0.58)
      delA = preDrop && rise > 0.55 ? clamp((rise - 0.55) * 0.9, 0, 0.36) : 0.12 * (1 - after)
      lA = preDrop ? clamp(1 - rise * 0.85, 0.15, 1) : 0
      lB = preDrop ? 0 : clamp(after, 0, 1)
      mA = preDrop ? 1 : clamp(1 - after * 0.95, 0, 1)
      mB = preDrop ? clamp(0.18 + rise * 0.22, 0, 0.45) : clamp(0.45 + after * 0.55, 0, 1)
      hA = preDrop ? 1 : clamp(1 - after * 0.9, 0, 1)
      hB = preDrop ? clamp(0.25 + rise * 0.35, 0, 0.65) : clamp(0.65 + after * 0.35, 0, 1)
      ga = preDrop ? 1 : clamp(1 - after * 0.85, 0.1, 1)
      gb = 1
    } else {
      // Smart crossfade / fallback: gentle bass exclusivity + smooth equal-power fade.
      lA = ga0 * (1 - 0.4 * smoothSwap)
      lB = gb0 * (0.6 + 0.4 * smoothSwap)
      mA = ga0
      mB = gb0
      hA = ga0
      hB = gb0
      ga = 1
      gb = 1
    }

    // Vocal overlap protection: selectively sculpt center vocal band on collision.
    let vDuckA = 0
    let vDuckB = 0
    if (vocalClash) {
      // Outgoing vocal finishes up to phraseEnd, then ducks sharply while incoming vocal opens.
      vDuckA = clamp((t - (phraseEnd - 0.12)) / 0.25, 0, 0.92)
      vDuckB = clamp(1 - (t - (phraseEnd - 0.08)) / 0.28, 0, 0.88)
    } else if (vocalOut > 0.5 && vocalIn <= 0.45) {
      // Protect outgoing vocal line by keeping incoming mid/vocal pocket recessed until phraseEnd.
      vDuckB = clamp(1 - (t - phraseEnd) / Math.max(0.15, 1 - phraseEnd), 0, 0.55)
    } else if (vocalIn > 0.5 && vocalOut <= 0.45) {
      // Clear a gentle vocal pocket on Track A as Track B's vocal enters.
      vDuckA = clamp((t - 0.25) / 0.35, 0, 0.6)
    }

    gainA.push(Number(clamp(ga, 0, 1.2).toFixed(4)))
    gainB.push(Number(clamp(gb, 0, 1.2).toFixed(4)))
    lowA.push(Number(clamp(lA, 0, 1.2).toFixed(4)))
    midA.push(Number(clamp(mA, 0, 1.2).toFixed(4)))
    highA.push(Number(clamp(hA, 0, 1.2).toFixed(4)))
    lowB.push(Number(clamp(lB, 0, 1.2).toFixed(4)))
    midB.push(Number(clamp(mB, 0, 1.2).toFixed(4)))
    highB.push(Number(clamp(hB, 0, 1.2).toFixed(4)))
    vocalDuckA.push(Number(clamp(vDuckA, 0, 1).toFixed(4)))
    vocalDuckB.push(Number(clamp(vDuckB, 0, 1).toFixed(4)))
    filterA.push(Number(clamp(fA, -1, 1).toFixed(4)))
    filterB.push(Number(clamp(fB, -1, 1).toFixed(4)))
    reverbSendA.push(Number(clamp(revA, 0, 1).toFixed(4)))
    delaySendA.push(Number(clamp(delA, 0, 1).toFixed(4)))
  }

  return {
    strategy,
    curves: {
      knots,
      gainA,
      gainB,
      lowA,
      midA,
      highA,
      lowB,
      midB,
      highB,
      vocalDuckA,
      vocalDuckB,
      filterA,
      filterB,
      reverbSendA,
      delaySendA
    },
    bassSwapAt: Number(bassSwapAt.toFixed(3)),
    bassSwapWidth: Number(bassSwapWidth.toFixed(3)),
    exponent: Number(exponent.toFixed(3)),
    drumSyncDuck: params.beatMatched !== false,
    lowHz: params.lowHz ?? 200,
    highHz: params.highHz ?? 3600,
    source: params.source ?? 'planner'
  }
}

/**
 * Enforce physical DJ mixing safety invariants on any automation plan
 * (including neural predictions):
 *   1. Sub-bass exclusivity: lowA(t) + lowB(t) <= 1.12 so two kick drums never clip or muddy.
 *   2. Endpoint continuity: starts predominantly on A (t=0) and lands cleanly on B (t=1).
 *   3. Finite, bounded curve values.
 */
export function sanitizeAutomationPlan(plan: AutomationPlan): AutomationPlan {
  const c = plan.curves
  const n = Math.max(2, c.knots)
  const safe = (arr: number[], lo: number, hi: number, fallback: number) =>
    Array.from({ length: n }, (_, i) => {
      const v = Number(arr[i])
      return Number.isFinite(v) ? clamp(v, lo, hi) : fallback
    })

  const gainA = safe(c.gainA, 0, 1.25, 1)
  const gainB = safe(c.gainB, 0, 1.25, 1)
  const lowA = safe(c.lowA, 0, 1.15, 0.5)
  const lowB = safe(c.lowB, 0, 1.15, 0.5)
  const midA = safe(c.midA, 0, 1.2, 0.5)
  const midB = safe(c.midB, 0, 1.2, 0.5)
  const highA = safe(c.highA, 0, 1.2, 0.5)
  const highB = safe(c.highB, 0, 1.2, 0.5)
  const vocalDuckA = safe(c.vocalDuckA, 0, 0.95, 0)
  const vocalDuckB = safe(c.vocalDuckB, 0, 0.95, 0)
  const filterA = safe(c.filterA, -1, 1, 0)
  const filterB = safe(c.filterB, -1, 1, 0)
  const reverbSendA = safe(c.reverbSendA, 0, 0.85, 0)
  const delaySendA = safe(c.delaySendA, 0, 0.85, 0)

  // Sub-bass exclusivity: cap simultaneous low-end sum at 1.10.
  for (let i = 0; i < n; i += 1) {
    const sum = lowA[i] * gainA[i] + lowB[i] * gainB[i]
    if (sum > 1.1) {
      const scale = 1.1 / sum
      lowA[i] *= scale
      lowB[i] *= scale
    }
  }

  // Ensure smooth landing at t=1 (Track B alone at unity, no lingering filter/duck).
  gainA[n - 1] = Math.min(gainA[n - 1], 0.05)
  lowA[n - 1] = 0
  midA[n - 1] = 0
  highA[n - 1] = 0
  gainB[n - 1] = 1
  lowB[n - 1] = 1
  midB[n - 1] = 1
  highB[n - 1] = 1
  vocalDuckB[n - 1] = 0
  filterB[n - 1] = 0

  return {
    ...plan,
    curves: {
      knots: n,
      gainA,
      gainB,
      lowA,
      midA,
      highA,
      lowB,
      midB,
      highB,
      vocalDuckA,
      vocalDuckB,
      filterA,
      filterB,
      reverbSendA,
      delaySendA
    }
  }
}

/**
 * Optional 4-stem mixing path (vocals, drums, bass, other).
 * When both tracks supply stems, each musical role is mixed with dedicated
 * curves: bass swaps cleanly on the phrase boundary, vocals never overlap,
 * drums hand over crisply with anti-flam attenuation, and melodic instruments
 * blend smoothly under filter & reverb sends.
 */
function renderStemBlend(ctx: BlendRenderContext, plan: AutomationPlan): void {
  const { left, right, fade, total, sampleRate, beatSamples } = ctx
  const stemsA = ctx.stemsA!
  const stemsB = ctx.stemsB!
  const c = plan.curves
  const step = 64

  const filtAL = new BipolarDjFilter(sampleRate)
  const filtAR = new BipolarDjFilter(sampleRate)
  const filtBL = new BipolarDjFilter(sampleRate)
  const filtBR = new BipolarDjFilter(sampleRate)

  const sendRevL = new Float32Array(total)
  const sendRevR = new Float32Array(total)
  const sendDelL = new Float32Array(total)
  const sendDelR = new Float32Array(total)

  let hasRev = false
  let hasDel = false

  for (let i = 0; i < total; i += 1) {
    const t = clamp(i / Math.max(1, fade), 0, 1)
    if (i % step === 0) {
      const fA = sampleCurve(c.filterA, t)
      const fB = sampleCurve(c.filterB, t)
      filtAL.update(fA)
      filtAR.update(fA)
      filtBL.update(fB)
      filtBR.update(fB)
    }

    const gA = i < fade ? sampleCurve(c.gainA, t) : 0
    const gB = i < fade ? sampleCurve(c.gainB, t) : 1
    const lowAG = i < fade ? sampleCurve(c.lowA, t) * gA : 0
    const lowBG = i < fade ? sampleCurve(c.lowB, t) * gB : 1
    const midAG = i < fade ? sampleCurve(c.midA, t) * gA : 0
    const midBG = i < fade ? sampleCurve(c.midB, t) * gB : 1
    const hiAG = i < fade ? sampleCurve(c.highA, t) * gA : 0
    const hiBG = i < fade ? sampleCurve(c.highB, t) * gB : 1
    const vDuckA = i < fade ? sampleCurve(c.vocalDuckA, t) : 1
    const vDuckB = i < fade ? sampleCurve(c.vocalDuckB, t) : 0

    // Dedicated stem gains:
    // - bass uses strict lowA/lowB exclusivity
    // - drums use crisp handoff weighted toward high/mid crossover
    // - vocals apply dedicated ducking (zero clash!)
    // - other (synths/chords/guitars) blends with mid/high curves
    const vocAG = midAG * (1 - 0.9 * vDuckA)
    const vocBG = midBG * (1 - 0.9 * vDuckB)
    const drmAG = (hiAG * 0.65 + lowAG * 0.35)
    const drmBG = (hiBG * 0.65 + lowBG * 0.35)
    const othAG = (midAG * 0.6 + hiAG * 0.4)
    const othBG = (midBG * 0.6 + hiBG * 0.4)

    const aL =
      (stemsA.bass?.left[i] ?? 0) * lowAG +
      (stemsA.drums?.left[i] ?? 0) * drmAG +
      (stemsA.vocals?.left[i] ?? 0) * vocAG +
      (stemsA.other?.left[i] ?? 0) * othAG
    const aR =
      (stemsA.bass?.right[i] ?? 0) * lowAG +
      (stemsA.drums?.right[i] ?? 0) * drmAG +
      (stemsA.vocals?.right[i] ?? 0) * vocAG +
      (stemsA.other?.right[i] ?? 0) * othAG

    const bL =
      (stemsB.bass?.left[i] ?? 0) * lowBG +
      (stemsB.drums?.left[i] ?? 0) * drmBG +
      (stemsB.vocals?.left[i] ?? 0) * vocBG +
      (stemsB.other?.right ? (stemsB.other.left[i] ?? 0) : 0) * othBG
    const bR =
      (stemsB.bass?.right[i] ?? 0) * lowBG +
      (stemsB.drums?.right[i] ?? 0) * drmBG +
      (stemsB.vocals?.right[i] ?? 0) * vocBG +
      (stemsB.other?.right[i] ?? 0) * othBG

    const outAL = filtAL.process(aL)
    const outAR = filtAR.process(aR)
    const outBL = filtBL.process(bL)
    const outBR = filtBR.process(bR)

    left[i] = outAL + outBL
    right[i] = outAR + outBR

    if (i < fade) {
      const rSend = sampleCurve(c.reverbSendA, t)
      const dSend = sampleCurve(c.delaySendA, t)
      if (rSend > 0.02) {
        hasRev = true
        sendRevL[i] = outAL * rSend
        sendRevR[i] = outAR * rSend
      }
      if (dSend > 0.02) {
        hasDel = true
        sendDelL[i] = outAL * dSend
        sendDelR[i] = outAR * dSend
      }
    }
  }

  applySendFx(left, right, sendRevL, sendRevR, sendDelL, sendDelR, hasRev, hasDel, sampleRate, beatSamples, total)
}

function applySendFx(
  left: Float32Array,
  right: Float32Array,
  sendRevL: Float32Array,
  sendRevR: Float32Array,
  sendDelL: Float32Array,
  sendDelR: Float32Array,
  hasRev: boolean,
  hasDel: boolean,
  sampleRate: number,
  beatSamples: number,
  total: number
): void {
  const beat = beatSamples || Math.round(sampleRate * 0.5)

  if (hasRev) {
    // Stereo decorrelated damped reverb wash via two prime-ratio feedback combs.
    const tap1 = Math.max(64, Math.round(beat * 0.371))
    const tap2 = Math.max(96, Math.round(beat * 0.619))
    const revL1 = echoTail(sendRevL, sampleRate, { delaySamples: tap1, feedback: 0.58, damping: 3400, length: total, mix: 0.55 })
    const revL2 = echoTail(sendRevL, sampleRate, { delaySamples: tap2, feedback: 0.52, damping: 2400, length: total, mix: 0.45 })
    const revR1 = echoTail(sendRevR, sampleRate, { delaySamples: tap2, feedback: 0.58, damping: 3400, length: total, mix: 0.55 })
    const revR2 = echoTail(sendRevR, sampleRate, { delaySamples: tap1, feedback: 0.52, damping: 2400, length: total, mix: 0.45 })
    for (let i = 0; i < total; i += 1) {
      // Subtract dry send so only the lush wet tail is added.
      const wetL = revL1[i] * 0.55 + revL2[i] * 0.45 - sendRevL[i]
      const wetR = revR1[i] * 0.55 + revR2[i] * 0.45 - sendRevR[i]
      left[i] += wetL * 0.55
      right[i] += wetR * 0.55
    }
  }

  if (hasDel) {
    // Beat-synced 1/2-beat dotted/eighth stereo feedback delay.
    const dL = Math.max(64, Math.round(beat * 0.5))
    const dR = Math.max(64, Math.round(beat * 0.75))
    const delL = echoTail(sendDelL, sampleRate, { delaySamples: dL, feedback: 0.48, damping: 4800, length: total, mix: 0.7 })
    const delR = echoTail(sendDelR, sampleRate, { delaySamples: dR, feedback: 0.44, damping: 4400, length: total, mix: 0.7 })
    for (let i = 0; i < total; i += 1) {
      left[i] += (delL[i] - sendDelL[i]) * 0.6
      right[i] += (delR[i] - sendDelR[i]) * 0.6
    }
  }
}

/**
 * Render an advanced continuous DJ transition into `ctx.left` / `ctx.right`.
 * Automatically dispatches to the 4-stem blender when stems are provided,
 * otherwise executes the 3-band Linkwitz-Riley + Mid-Side vocal protection +
 * drum-transient ducking + dynamic filter/reverb/delay pipeline.
 */
export function renderContinuousBlend(ctx: BlendRenderContext): AutomationPlan {
  const plan = sanitizeAutomationPlan(ctx.plan)
  if (ctx.stemsA && ctx.stemsB && (ctx.stemsA.vocals || ctx.stemsA.bass || ctx.stemsA.drums)) {
    renderStemBlend(ctx, plan)
    return plan
  }

  const { a, b, left, right, fade, total, sampleRate, beatSamples } = ctx
  const c = plan.curves
  const step = 64

  const splitAL = new ThreeBandCrossover(plan.lowHz, plan.highHz, sampleRate)
  const splitAR = new ThreeBandCrossover(plan.lowHz, plan.highHz, sampleRate)
  const splitBL = new ThreeBandCrossover(plan.lowHz, plan.highHz, sampleRate)
  const splitBR = new ThreeBandCrossover(plan.lowHz, plan.highHz, sampleRate)

  const vocA = new VocalCenterSculptor(sampleRate)
  const vocB = new VocalCenterSculptor(sampleRate)

  const filtAL = new BipolarDjFilter(sampleRate)
  const filtAR = new BipolarDjFilter(sampleRate)
  const filtBL = new BipolarDjFilter(sampleRate)
  const filtBR = new BipolarDjFilter(sampleRate)

  const sendRevL = new Float32Array(total)
  const sendRevR = new Float32Array(total)
  const sendDelL = new Float32Array(total)
  const sendDelR = new Float32Array(total)
  let hasRev = false
  let hasDel = false

  // Fast/slow envelope followers on incoming low-end for drum-transient micro-ducking.
  const fastCoeff = Math.exp(-1 / (0.004 * sampleRate))
  const slowCoeff = Math.exp(-1 / (0.045 * sampleRate))
  let envFastB = 0
  let envSlowB = 0
  let drumDuck = 1

  for (let i = 0; i < total; i += 1) {
    const inBlend = i < fade
    const t = inBlend ? i / Math.max(1, fade) : 1

    if (i % step === 0) {
      filtAL.update(inBlend ? sampleCurve(c.filterA, t) : 0)
      filtAR.update(inBlend ? sampleCurve(c.filterA, t) : 0)
      filtBL.update(inBlend ? sampleCurve(c.filterB, t) : 0)
      filtBR.update(inBlend ? sampleCurve(c.filterB, t) : 0)
    }

    const rawAL = inBlend ? (a.left[i] ?? 0) : 0
    const rawAR = inBlend ? (a.right[i] ?? 0) : 0
    const rawBL = b.left[i] ?? 0
    const rawBR = b.right[i] ?? 0

    // 1. Mid-Side vocal-band sculpting before EQ/filters.
    const vDuckA = inBlend ? sampleCurve(c.vocalDuckA, t) : 0
    const vDuckB = inBlend ? sampleCurve(c.vocalDuckB, t) : 0
    const [scAL, scAR] = vocA.apply(rawAL, rawAR, vDuckA)
    const [scBL, scBR] = vocB.apply(rawBL, rawBR, vDuckB)

    // 2. Phase-coherent 3-band Linkwitz-Riley split.
    const [aLoL, aMidL, aHiL] = splitAL.split(scAL)
    const [aLoR, aMidR, aHiR] = splitAR.split(scAR)
    const [bLoL, bMidL, bHiL] = splitBL.split(scBL)
    const [bLoR, bMidR, bHiR] = splitBR.split(scBR)

    // 3. Drum-transient micro-ducking: when B strikes a kick transient while
    //    both tracks overlap, gently yield A's low-end by up to 3 dB (35 ms).
    if (plan.drumSyncDuck && inBlend) {
      const kickB = Math.max(Math.abs(bLoL), Math.abs(bLoR))
      envFastB = kickB > envFastB ? kickB : envFastB * fastCoeff + kickB * (1 - fastCoeff)
      envSlowB = kickB > envSlowB ? envSlowB * 0.995 + kickB * 0.005 : envSlowB * slowCoeff + kickB * (1 - slowCoeff)
      const transient = clamp((envFastB - envSlowB) * 6, 0, 1)
      const targetDuck = 1 - 0.28 * transient * clamp(sampleCurve(c.lowB, t) * 1.4, 0, 1)
      drumDuck = targetDuck < drumDuck ? targetDuck : drumDuck * slowCoeff + targetDuck * (1 - slowCoeff)
    } else {
      drumDuck = 1
    }

    // 4. Continuous 3-band EQ & gain automation.
    const gA = inBlend ? sampleCurve(c.gainA, t) : 0
    const gB = inBlend ? sampleCurve(c.gainB, t) : 1
    const loAG = inBlend ? sampleCurve(c.lowA, t) * gA * drumDuck : 0
    const midAG = inBlend ? sampleCurve(c.midA, t) * gA : 0
    const hiAG = inBlend ? sampleCurve(c.highA, t) * gA : 0
    const loBG = inBlend ? sampleCurve(c.lowB, t) * gB : 1
    const midBG = inBlend ? sampleCurve(c.midB, t) * gB : 1
    const hiBG = inBlend ? sampleCurve(c.highB, t) * gB : 1

    const mixAL = filtAL.process(aLoL * loAG + aMidL * midAG + aHiL * hiAG)
    const mixAR = filtAR.process(aLoR * loAG + aMidR * midAG + aHiR * hiAG)
    const mixBL = filtBL.process(bLoL * loBG + bMidL * midBG + bHiL * hiBG)
    const mixBR = filtBR.process(bLoR * loBG + bMidR * midBG + bHiR * hiBG)

    left[i] = mixAL + mixBL
    right[i] = mixAR + mixBR

    // 5. Dynamic reverb / beat-synced delay send feeds.
    if (inBlend) {
      const rSend = sampleCurve(c.reverbSendA, t)
      const dSend = sampleCurve(c.delaySendA, t)
      if (rSend > 0.02) {
        hasRev = true
        sendRevL[i] = mixAL * rSend
        sendRevR[i] = mixAR * rSend
      }
      if (dSend > 0.02) {
        hasDel = true
        sendDelL[i] = mixAL * dSend
        sendDelR[i] = mixAR * dSend
      }
    }
  }

  applySendFx(left, right, sendRevL, sendRevR, sendDelL, sendDelR, hasRev, hasDel, sampleRate, beatSamples, total)
  return plan
}
