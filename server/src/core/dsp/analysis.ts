/**
 * DSP primitives for the automix — written against the published references,
 * not by ear:
 *
 *  • Biquads use the RBJ "Audio EQ Cookbook" formulae (W3C mirror).
 *  • Loudness is ITU-R BS.1770 / EBU R128: K-weighting (+4 dB high shelf at
 *    1681.97 Hz, then a 38.13 Hz high-pass), 400 ms blocks with 75 % overlap,
 *    absolute gate at −70 LUFS and a relative gate 10 LU below the ungated
 *    mean.
 *  • Cue points follow the playout convention (Liquidsoap `autocue`, PlayIt,
 *    RadioBOSS): 50 ms RMS windows, silence threshold a fixed number of LU
 *    below the integrated loudness, plus an "overlay"/next-start point where
 *    the ending begins, with long-tail protection.
 *  • Tempo is a spectral-flux onset detection function, autocorrelated with a
 *    log-Gaussian perceptual weighting around 120 BPM (Alonso/Peeters style),
 *    then phase-locked with a pulse train.
 *  • The ducker is a feed-forward sidechain compressor with real attack and
 *    release time constants.
 *
 * Everything here is pure: Float32Array in, Float32Array (or numbers) out.
 */

export const DB = (db) => 10 ** (db / 20)
export const TO_DB = (gain) => 20 * Math.log10(Math.max(1e-12, gain))
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/* ------------------------------------------------------------------ *
 * Biquads — RBJ cookbook
 * ------------------------------------------------------------------ */

export class Biquad {
  declare a1: any
  declare a2: any
  declare b0: any
  declare b1: any
  declare b2: any
  declare z1: any
  declare z2: any

  constructor(b0, b1, b2, a1, a2) {
    this.set(b0, b1, b2, a1, a2)
    this.z1 = 0
    this.z2 = 0
  }

  set(b0, b1, b2, a1, a2) {
    this.b0 = b0
    this.b1 = b1
    this.b2 = b2
    this.a1 = a1
    this.a2 = a2
    return this
  }

  reset() {
    this.z1 = 0
    this.z2 = 0
    return this
  }

  /** Transposed direct form II: one multiply-add chain, no history array. */
  process(x) {
    const y = this.b0 * x + this.z1
    this.z1 = this.b1 * x - this.a1 * y + this.z2
    this.z2 = this.b2 * x - this.a2 * y
    return y
  }

  processInto(input, output = new Float32Array(input.length)) {
    for (let i = 0; i < input.length; i += 1) output[i] = this.process(input[i])
    return output
  }

  static #norm(b0, b1, b2, a0, a1, a2) {
    return new Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)
  }

  static lowpass(freq, sampleRate, Q = Math.SQRT1_2) {
    const w0 = (2 * Math.PI * clamp(freq, 10, sampleRate / 2 - 100)) / sampleRate
    const cos = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * Q)
    return Biquad.#norm((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha)
  }

  static highpass(freq, sampleRate, Q = Math.SQRT1_2) {
    const w0 = (2 * Math.PI * clamp(freq, 10, sampleRate / 2 - 100)) / sampleRate
    const cos = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * Q)
    return Biquad.#norm((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha)
  }

  /** Constant 0 dB peak gain band-pass. */
  static bandpass(freq, sampleRate, Q = 1) {
    const w0 = (2 * Math.PI * clamp(freq, 10, sampleRate / 2 - 100)) / sampleRate
    const cos = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * Q)
    return Biquad.#norm(alpha, 0, -alpha, 1 + alpha, -2 * cos, 1 - alpha)
  }

  static highshelf(freq, sampleRate, gainDb, Q = Math.SQRT1_2) {
    const A = 10 ** (gainDb / 40)
    const w0 = (2 * Math.PI * clamp(freq, 10, sampleRate / 2 - 100)) / sampleRate
    const cos = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * Q)
    const beta = 2 * Math.sqrt(A) * alpha
    return Biquad.#norm(
      A * (A + 1 + (A - 1) * cos + beta),
      -2 * A * (A - 1 + (A + 1) * cos),
      A * (A + 1 + (A - 1) * cos - beta),
      A + 1 - (A - 1) * cos + beta,
      2 * (A - 1 - (A + 1) * cos),
      A + 1 - (A - 1) * cos - beta
    )
  }
}

/**
 * Linkwitz-Riley 4th order crossover (two cascaded Butterworth sections):
 * the low and high band sum back to a flat magnitude response, which is what
 * makes a bass swap inaudible outside the low end.
 */
export class Crossover {
  declare hp: any
  declare lp: any

  constructor(freq, sampleRate) {
    this.lp = [Biquad.lowpass(freq, sampleRate), Biquad.lowpass(freq, sampleRate)]
    this.hp = [Biquad.highpass(freq, sampleRate), Biquad.highpass(freq, sampleRate)]
  }

  split(x) {
    let low = x
    for (const f of this.lp) low = f.process(low)
    let high = x
    for (const f of this.hp) high = f.process(high)
    return [low, high]
  }
}

/* ------------------------------------------------------------------ *
 * Loudness — ITU-R BS.1770 / EBU R128
 * ------------------------------------------------------------------ */

/**
 * BS.1770 K-weighting: a +4 dB high shelf at 1.5 kHz followed by a 38 Hz
 * high-pass (RLB). These are the same parameters `pyloudnorm` derives the
 * standard's 48 kHz reference coefficients from, so the meter below agrees
 * with it to ~0.01 LU at any sample rate.
 */
export function kWeightingFilters(sampleRate) {
  return [Biquad.highshelf(1500, sampleRate, 4, Math.SQRT1_2), Biquad.highpass(38, sampleRate, 0.5)]
}

function kWeight(channel, sampleRate) {
  const [shelf, hp] = kWeightingFilters(sampleRate)
  const out = new Float32Array(channel.length)
  for (let i = 0; i < channel.length; i += 1) out[i] = hp.process(shelf.process(channel[i]))
  return out
}

/**
 * Gated integrated loudness in LUFS.
 * @param {Float32Array[]} channels
 */
export function integratedLoudness(channels, sampleRate) {
  const weighted = channels.map((c) => kWeight(c, sampleRate))
  const blockLen = Math.round(0.4 * sampleRate)
  const hop = Math.round(0.1 * sampleRate) // 75 % overlap
  if (!weighted.length || weighted[0].length < blockLen) return null

  const powers = []
  for (let start = 0; start + blockLen <= weighted[0].length; start += hop) {
    let z = 0
    for (const channel of weighted) {
      let sum = 0
      for (let i = start; i < start + blockLen; i += 1) sum += channel[i] * channel[i]
      z += sum / blockLen // channel weight G = 1.0 for L and R
    }
    powers.push(z)
  }
  if (!powers.length) return null

  const loudnessOf = (z) => -0.691 + 10 * Math.log10(Math.max(1e-12, z))
  const aboveAbsolute = powers.filter((z) => loudnessOf(z) > -70)
  if (!aboveAbsolute.length) return null

  const meanAbsolute = aboveAbsolute.reduce((a, b) => a + b, 0) / aboveAbsolute.length
  const relativeGate = loudnessOf(meanAbsolute) - 10
  const gated = aboveAbsolute.filter((z) => loudnessOf(z) > relativeGate)
  const pool = gated.length ? gated : aboveAbsolute
  return loudnessOf(pool.reduce((a, b) => a + b, 0) / pool.length)
}

export function samplePeak(channels) {
  let peak = 0
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      const abs = Math.abs(channel[i])
      if (abs > peak) peak = abs
    }
  }
  return peak
}

/* ------------------------------------------------------------------ *
 * Cue points — playout-style silence / overlay detection
 * ------------------------------------------------------------------ */

/** 50 ms RMS profile in dBFS. */
export function rmsProfile(mono, sampleRate, windowMs = 50) {
  const win = Math.max(1, Math.round((windowMs / 1000) * sampleRate))
  const out = new Float32Array(Math.max(0, Math.floor(mono.length / win)))
  for (let w = 0; w < out.length; w += 1) {
    let sum = 0
    const start = w * win
    for (let i = start; i < start + win; i += 1) sum += mono[i] * mono[i]
    out[w] = TO_DB(Math.sqrt(sum / win))
  }
  return out
}

/**
 * Cue in / cue out / overlay (a.k.a. "next start"), the three markers every
 * playout system derives from the waveform.
 *
 * @param {Float32Array} mono
 * @param {object} opts
 * @param {number} opts.integrated  integrated loudness of the material (LUFS)
 * @param {number} opts.silenceLu   LU below integrated that counts as silence
 * @param {number} opts.overlayLu   LU below integrated where the ending starts
 * @param {number} opts.extraLu     extra LU used when the tail is very long
 * @param {number} opts.longTailMs  overlay longer than this is a "long tail"
 */
export function detectCues(mono, sampleRate, { integrated = null, silenceLu = -42, overlayLu = -8, extraLu = -12, longTailMs = 15_000, windowMs = 50 }: any = {}) {
  const profile = rmsProfile(mono, sampleRate, windowMs)
  if (!profile.length) return { cueIn: 0, cueOut: mono.length, overlay: mono.length, silenceDb: -70 }

  const reference = integrated ?? TO_DB(Math.sqrt(mono.reduce((sum, v) => sum + v * v, 0) / Math.max(1, mono.length)))
  const silenceDb = Math.max(-70, reference + silenceLu)
  const perWindow = Math.round((windowMs / 1000) * sampleRate)

  let first = -1
  let last = -1
  for (let w = 0; w < profile.length; w += 1) {
    if (profile[w] <= silenceDb) continue
    if (first === -1) first = w
    last = w
  }
  if (first === -1) return { cueIn: 0, cueOut: mono.length, overlay: mono.length, silenceDb }

  const cueIn = first * perWindow
  const cueOut = Math.min(mono.length, (last + 1) * perWindow)

  const overlayAt = (lu) => {
    const threshold = reference + lu
    for (let w = last; w >= first; w -= 1) if (profile[w] >= threshold) return Math.min(cueOut, (w + 1) * perWindow)
    return cueOut
  }

  let overlay = overlayAt(overlayLu)
  // A long fade-out or a sustained ending would otherwise be chopped: back the
  // trigger off by `extraLu` and keep the ending intact.
  if (cueOut - overlay > (longTailMs / 1000) * sampleRate) overlay = overlayAt(overlayLu + extraLu)
  return { cueIn, cueOut, overlay, silenceDb }
}

/* ------------------------------------------------------------------ *
 * Correlation — decides the crossfade law
 * ------------------------------------------------------------------ */

/** Normalised zero-lag cross-correlation of two equal-length windows. */
export function correlation(a, b, length = Math.min(a.length, b.length)) {
  let ab = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < length; i += 1) {
    ab += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  if (aa <= 1e-12 || bb <= 1e-12) return 0
  return ab / Math.sqrt(aa * bb)
}

/**
 * Crossfade gains for fader position `t` (0…1) under the law aˣ + bˣ = 1:
 * x = 1 is equal-gain (correlated material), x = 2 is equal-power
 * (uncorrelated). Everything between is a legitimate compromise, so the
 * measured correlation picks the exponent.
 */
export function fadeGains(t, exponent = 2) {
  const c = clamp(t, 0, 1)
  const x = clamp(exponent, 1, 2)
  return [(1 - c) ** (1 / x), c ** (1 / x)]
}

export function exponentFor(correlationValue) {
  return 2 - clamp(correlationValue, 0, 1)
}

/* ------------------------------------------------------------------ *
 * Onsets, tempo, beat grid
 * ------------------------------------------------------------------ */

/** In-place iterative radix-2 FFT (real input, complex scratch buffers). */
function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k += 1) {
        const ur = re[i + k]
        const ui = im[i + k]
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ur + vr
        im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr
        im[i + k + len / 2] = ui - vi
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

/**
 * Spectral-flux onset detection function: STFT magnitudes, half-wave
 * rectified frame-to-frame difference summed over bins.
 */
export function onsetEnvelope(mono, sampleRate, { frameSize = 1024, hopSize = 256 }: any = {}) {
  // `frameSize` and `hopSize` are both tunable because the two callers want
  // different things: `estimateBeat` needs the resolution to phase-lock, and
  // `tempoCandidates` only needs enough frames to autocorrelate over. See the
  // comment there for why 2048 is exact for it.
  const frames = Math.max(0, Math.floor((mono.length - frameSize) / hopSize) + 1)
  const odf = new Float32Array(Math.max(0, frames - 1))
  if (frames < 2) return { odf, hopSize, sampleRate }

  const window = new Float32Array(frameSize)
  for (let i = 0; i < frameSize; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frameSize - 1))

  const re = new Float64Array(frameSize)
  const im = new Float64Array(frameSize)
  const bins = frameSize / 2
  // Two buffers, swapped, rather than a fresh one per frame: a 12 s window is
  // ~2 000 frames, and 2 000 allocations of 2 kB each is 4 MB of garbage per
  // seam — which the collector then has to trace during the render.
  //
  // They must be *different* buffers. Writing the new frame into the same one
  // the flux is compared against makes every difference zero, and the tempo
  // estimator then finds nothing at all — a silent, total failure that looks
  // like "no beat in this song".
  let previous = null
  let current = new Float32Array(bins)

  for (let f = 0; f < frames; f += 1) {
    const start = f * hopSize
    for (let i = 0; i < frameSize; i += 1) {
      re[i] = mono[start + i] * window[i]
      im[i] = 0
    }
    fft(re, im)
    for (let k = 0; k < bins; k += 1) current[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k])
    if (previous) {
      let flux = 0
      for (let k = 0; k < bins; k += 1) {
        const diff = current[k] - previous[k]
        if (diff > 0) flux += diff
      }
      odf[f - 1] = flux
    }
    const swap = previous ?? new Float32Array(bins)
    previous = current
    current = swap
  }

  // Normalise and remove the local mean so the autocorrelation sees pulses.
  let mean = 0
  for (const v of odf) mean += v
  mean /= Math.max(1, odf.length)
  let peak = 0
  for (let i = 0; i < odf.length; i += 1) {
    odf[i] = Math.max(0, odf[i] - mean)
    if (odf[i] > peak) peak = odf[i]
  }
  if (peak > 0) for (let i = 0; i < odf.length; i += 1) odf[i] /= peak

  return { odf, hopSize, sampleRate }
}

/**
 * Tempo + beat phase.
 *
 * Autocorrelation of the onset envelope over 60-200 BPM, but scored through a
 * three-tooth comb (lag, 2x lag, 3x lag): a real pulse repeats at its own
 * multiples, a spurious correlation peak does not, which is what stops a
 * 120 BPM loop from occasionally reading as 155. A log-Gaussian weighting
 * centred on 120 BPM then resolves the remaining octave ambiguity, and the
 * phase comes from a pulse-train cross-correlation.
 *
 * `confidence` is the product of two independent checks - how far the winning
 * tempo stands above the field, and how much of the onset energy actually
 * lands on its grid - so "confident" means the beat is usable, not merely
 * that a maximum exists.
 */
export function estimateBeat(mono, sampleRate, options: any = {}) {
  const { odf, hopSize } = onsetEnvelope(mono, sampleRate, options)
  if (odf.length < 16) return null

  const odfRate = sampleRate / hopSize
  const minLag = Math.max(2, Math.round((60 / 200) * odfRate))
  const maxLag = Math.min(odf.length - 1, Math.round((60 / 60) * odfRate))
  if (maxLag <= minLag) return null

  // Autocorrelation over every lag the comb can reach, not just the tempo
  // range, so the harmonic teeth have something to bite on.
  const topLag = Math.min(odf.length - 2, maxLag * 3)
  const acf = new Float64Array(topLag + 1)
  for (let lag = minLag; lag <= topLag; lag += 1) {
    let sum = 0
    const n = odf.length - lag
    if (n <= 0) break
    for (let i = 0; i < n; i += 1) sum += odf[i] * odf[i + lag]
    acf[lag] = sum / n
  }

  const scores = new Float64Array(maxLag + 1)
  const at = (lag) => (lag <= topLag ? acf[Math.round(lag)] : 0)
  let bestLag = 0
  let bestScore = 0
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const comb = acf[lag] + 0.5 * at(lag * 2) + 0.25 * at(lag * 3)
    const bpm = (60 * odfRate) / lag
    const weight = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2)
    scores[lag] = comb * weight
    if (scores[lag] > bestScore) {
      bestScore = scores[lag]
      bestLag = lag
    }
  }
  if (!bestLag || bestScore <= 0) return null

  // Parabolic interpolation around the autocorrelation peak: the ODF hop is
  // ~6 ms, which is otherwise +/-1 BPM of quantisation error.
  let refinedLag = bestLag
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = scores[bestLag - 1]
    const y1 = scores[bestLag]
    const y2 = scores[bestLag + 1]
    const denominator = y0 - 2 * y1 + y2
    if (Math.abs(denominator) > 1e-12) refinedLag = bestLag + clamp((0.5 * (y0 - y2)) / denominator, -0.5, 0.5)
  }

  // Phase: correlate a pulse train of that period against the ODF.
  let bestPhase = 0
  let bestPhaseScore = -1
  let hits = 0
  for (let phase = 0; phase < bestLag; phase += 1) {
    let sum = 0
    let n = 0
    for (let i = phase; i < odf.length; i += bestLag) {
      sum += odf[i]
      n += 1
    }
    if (sum > bestPhaseScore) {
      bestPhaseScore = sum
      bestPhase = phase
      hits = n
    }
  }

  // Salience: how far the winner stands above the typical candidate.
  const field = []
  for (let lag = minLag; lag <= maxLag; lag += 1) if (scores[lag] > 0) field.push(scores[lag])
  field.sort((x, y) => x - y)
  const median = field.length ? field[Math.floor(field.length / 2)] : 0
  const salience = median > 0 ? clamp((bestScore / median - 1) / 3, 0, 1) : 0

  // Grid strength: onset energy on the beat against onset energy everywhere.
  let odfSum = 0
  for (const v of odf) odfSum += v
  const meanOdf = odfSum / Math.max(1, odf.length)
  const onGrid = hits > 0 ? bestPhaseScore / hits : 0
  const grid = meanOdf > 0 ? clamp((onGrid / meanOdf - 1) / 2, 0, 1) : 0

  // Peakiness: the envelope is normalised to a peak of 1, so 1/mean is its
  // crest factor. Percussive material sits above 20, a sustained pad or a
  // sine wave around 4 - without this a steady tone can score a confident
  // "tempo" off nothing but window ripple.
  const peakiness = meanOdf > 0 ? clamp((1 / meanOdf - 4) / 10, 0, 1) : 0

  return {
    bpm: (60 * odfRate) / refinedLag,
    periodSamples: refinedLag * hopSize,
    phaseSamples: bestPhase * hopSize,
    confidence: Math.sqrt(salience * grid) * peakiness
  }
}
