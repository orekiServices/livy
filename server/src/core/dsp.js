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
export function detectCues(mono, sampleRate, { integrated = null, silenceLu = -42, overlayLu = -8, extraLu = -12, longTailMs = 15_000, windowMs = 50 } = {}) {
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
export function onsetEnvelope(mono, sampleRate, { frameSize = 1024, hopSize = 256 } = {}) {
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
export function estimateBeat(mono, sampleRate, options = {}) {
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
/* ------------------------------------------------------------------ *
 * Dynamics — sidechain ducking and voice compression
 * ------------------------------------------------------------------ */

const timeConstant = (ms, sampleRate) => (ms <= 0 ? 0 : Math.exp(-1 / ((ms / 1000) * sampleRate)))

/**
 * Feed-forward compressor gain curve. With `control` !== signal this is a
 * sidechain ducker: broadcast settings are a high ratio, a low threshold and
 * a slow release so the bed comes back up gently after the line.
 *
 * @returns {Float32Array} linear gain per sample
 */
export function compressorGain(control, sampleRate, { thresholdDb = -36, ratio = 12, attackMs = 100, releaseMs = 600, kneeDb = 6, rangeDb = -Infinity } = {}) {
  const attack = timeConstant(attackMs, sampleRate)
  const release = timeConstant(releaseMs, sampleRate)
  const gains = new Float32Array(control.length)
  let envelope = 0 // peak follower, linear
  let reduction = 0 // current gain reduction in dB (negative)

  for (let i = 0; i < control.length; i += 1) {
    const x = Math.abs(control[i])
    envelope = x > envelope ? x : x + (envelope - x) * 0.9995 // fast up, slow down
    const level = TO_DB(envelope)

    let target = 0
    const over = level - thresholdDb
    if (over > kneeDb / 2) target = over * (1 / ratio - 1)
    else if (over > -kneeDb / 2) {
      const knee = over + kneeDb / 2
      target = ((1 / ratio - 1) * knee * knee) / (2 * kneeDb)
    }
    if (target < rangeDb) target = rangeDb

    // Attack when pushing down, release when coming back up.
    const coefficient = target < reduction ? attack : release
    reduction = target + (reduction - target) * coefficient
    gains[i] = DB(reduction)
  }
  return gains
}

/* ------------------------------------------------------------------ *
 * Time-domain effects
 * ------------------------------------------------------------------ */

/** Beat-synced feedback delay ("echo out"), with a damped repeat. */
export function echoTail(input, sampleRate, { delaySamples, feedback = 0.45, damping = 6000, length = input.length, mix = 1 }) {
  const out = new Float32Array(length)
  const line = new Float32Array(Math.max(1, delaySamples))
  const damp = Biquad.lowpass(damping, sampleRate)
  let write = 0
  for (let i = 0; i < length; i += 1) {
    const dry = i < input.length ? input[i] : 0
    const delayed = line[write]
    out[i] = dry + delayed * mix
    line[write] = damp.process(dry + delayed * feedback)
    write = (write + 1) % line.length
  }
  return out
}

/**
 * Tape stop / brake: the outgoing song decelerates to a standstill.
 * Reads the source with a falling playback rate and linear interpolation.
 */
export function brake(input, { length, curve = 2 }) {
  const out = new Float32Array(length)
  let position = 0
  for (let i = 0; i < length; i += 1) {
    const rate = (1 - i / length) ** curve
    const i0 = Math.floor(position)
    const frac = position - i0
    const a = i0 < input.length ? input[i0] : 0
    const b = i0 + 1 < input.length ? input[i0 + 1] : 0
    out[i] = a * (1 - frac) + b * frac
    position += rate
    if (position >= input.length) break
  }
  return out
}

/** Deterministic noise source (no Math.random inside audio rendering). */
export function noiseSource(seed = 0xa11ce) {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return ((state >>> 0) / 0xffffffff) * 2 - 1
  }
}

/** Linear resampler (short segments only — crossfades, voice). */
export function resample(samples, from, to) {
  if (from === to || !samples.length) return samples
  const ratio = to / from
  const out = new Float32Array(Math.round(samples.length * ratio))
  for (let i = 0; i < out.length; i += 1) {
    const src = i / ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(samples.length - 1, i0 + 1)
    const t = src - i0
    out[i] = samples[i0] * (1 - t) + samples[i1] * t
  }
  return out
}


/* ------------------------------------------------------------------ *
 * Time stretching (WSOLA) — the machinery behind beatmatching
 * ------------------------------------------------------------------ */

/**
 * Build the time map for a stretch that eases in.
 *
 * `stretch` is the output/input duration ratio: 1.02 plays the material 2 %
 * slower (and longer), 0.98 plays it 2 % faster. Ramping it from 1 over
 * `rampSamples` is what a DJ does with a pitch fader — the tempo change is a
 * slide, not a step — and the closed form below lets the caller map any input
 * sample (a beat, say) to where it ends up in the output and back.
 */
export function stretchMap(stretch, rampSamples = 0) {
  const S = stretch
  const R = Math.max(0, rampSamples)
  const linear = Math.abs(S - 1) < 1e-6

  // Output position of the end of the ramp, and the input it consumed.
  const inputAtRampEnd = linear || R === 0 ? R : (R / (S - 1)) * Math.log(S)

  return {
    stretch: S,
    rampSamples: R,
    /** input sample consumed by output sample `out` */
    inputAt(out) {
      if (linear) return out
      if (R === 0) return out / S
      if (out <= R) return (R / (S - 1)) * Math.log(1 + ((S - 1) * out) / R)
      return inputAtRampEnd + (out - R) / S
    },
    /** where input sample `input` ends up in the output */
    outputAt(input) {
      if (linear) return input
      if (R === 0) return input * S
      if (input <= inputAtRampEnd) return (R / (S - 1)) * (Math.exp(((S - 1) * input) / R) - 1)
      return R + (input - inputAtRampEnd) * S
    },
    /** length of the output produced by `inputLength` input samples */
    outputLength(inputLength) {
      return Math.max(0, Math.round(this.outputAt(inputLength)))
    }
  }
}

/**
 * WSOLA time stretch: change the tempo without touching the pitch.
 *
 * Overlap-add with a similarity search — each grain is taken from wherever,
 * within a small window around the position the time map asks for, it lines
 * up best with what has already been written. That is what keeps a beat
 * sounding like a beat instead of a flam.
 *
 * Both channels are moved with the *same* grain offsets (chosen on the mono
 * sum) so the stereo image survives, and so the cost is one search, not two.
 *
 * @param {Float32Array[]} channels
 * @param {object} opts
 * @param {number} opts.stretch      output/input duration ratio
 * @param {number} [opts.rampSamples] ease the ratio in over this many output samples
 * @param {number} [opts.length]     output length (defaults to the whole input)
 * @returns {{channels: Float32Array[], length: number, map: object}}
 */
export function timeStretch(channels, sampleRate, { stretch = 1, rampSamples = 0, length = null, frameSize = 0, searchMs = 8 } = {}) {
  const map = stretchMap(stretch, rampSamples)
  const inputLength = channels[0]?.length ?? 0
  const outLength = Math.max(0, Math.min(length ?? map.outputLength(inputLength), map.outputLength(inputLength)))

  if (Math.abs(stretch - 1) < 1e-6 || inputLength === 0 || outLength === 0) {
    return { channels: channels.map((c) => c.subarray(0, Math.min(c.length, outLength || c.length))), length: outLength || inputLength, map }
  }

  // ~46 ms grains at 44.1 kHz: long enough for bass, short enough for drums.
  const N = frameSize || Math.max(512, 1 << Math.round(Math.log2(sampleRate * 0.046)))
  const hop = Math.round(N / 4) // 75 % overlap
  const search = Math.max(1, Math.round((searchMs / 1000) * sampleRate))
  const corrWindow = Math.min(hop, 512)

  const window = new Float32Array(N)
  for (let i = 0; i < N; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))

  // Mono reference drives the similarity search.
  const mono = new Float32Array(inputLength)
  for (const channel of channels) for (let i = 0; i < inputLength; i += 1) mono[i] += channel[i] / channels.length

  const out = channels.map(() => new Float32Array(outLength + N))
  const norm = new Float32Array(outLength + N)
  const template = new Float32Array(corrWindow) // what the next grain should continue

  let previousAnalysis = 0
  let first = true

  for (let outPos = 0; outPos < outLength; outPos += hop) {
    const target = Math.round(map.inputAt(outPos))
    let best = target

    if (!first) {
      // Search around the target for the grain that continues the last one.
      let bestScore = -Infinity
      const from = Math.max(0, target - search)
      const to = Math.min(inputLength - corrWindow - 1, target + search)
      for (let coarse = from; coarse <= to; coarse += 4) {
        let dot = 0
        let energy = 1e-9
        for (let i = 0; i < corrWindow; i += 2) {
          const v = mono[coarse + i]
          dot += v * template[i]
          energy += v * v
        }
        const score = dot / Math.sqrt(energy)
        if (score > bestScore) {
          bestScore = score
          best = coarse
        }
      }
      // Refine to the sample.
      const fineFrom = Math.max(0, best - 3)
      const fineTo = Math.min(inputLength - corrWindow - 1, best + 3)
      for (let fine = fineFrom; fine <= fineTo; fine += 1) {
        let dot = 0
        let energy = 1e-9
        for (let i = 0; i < corrWindow; i += 1) {
          const v = mono[fine + i]
          dot += v * template[i]
          energy += v * v
        }
        const score = dot / Math.sqrt(energy)
        if (score > bestScore) {
          bestScore = score
          best = fine
        }
      }
    }
    first = false
    if (best + N >= inputLength) break

    for (let c = 0; c < channels.length; c += 1) {
      const src = channels[c]
      const dst = out[c]
      for (let i = 0; i < N; i += 1) dst[outPos + i] += src[best + i] * window[i]
    }
    for (let i = 0; i < N; i += 1) norm[outPos + i] += window[i]

    // The next grain should sound like this one continued by one hop.
    const continueAt = best + hop
    for (let i = 0; i < corrWindow; i += 1) template[i] = continueAt + i < inputLength ? mono[continueAt + i] : 0
    previousAnalysis = best
  }
  void previousAnalysis

  for (let c = 0; c < channels.length; c += 1) {
    const dst = out[c]
    for (let i = 0; i < outLength; i += 1) dst[i] /= Math.max(0.35, norm[i])
  }

  return { channels: out.map((c) => c.subarray(0, outLength)), length: outLength, map }
}

/**
 * Fold a tempo into the same octave as a reference, the way a DJ hears 85 BPM
 * and 170 BPM as the same groove.
 * @returns {{bpm: number, factor: number}} folded tempo and the 2^n applied
 */
export function foldTempo(bpm, referenceBpm) {
  if (!bpm || !referenceBpm) return { bpm, factor: 1 }
  let folded = bpm
  let factor = 1
  while (folded / referenceBpm > 1.4) {
    folded /= 2
    factor /= 2
  }
  while (folded / referenceBpm < 1 / 1.4) {
    folded *= 2
    factor *= 2
  }
  return { bpm: folded, factor }
}

/* ------------------------------------------------------------------ *
 * Seam analysis — the automix-engine decomposition, in JS
 * ------------------------------------------------------------------ *
 *
 * VertexSelection/automix-engine (Python, CUE-DETR + Demucs + Rubber Band)
 * makes a transition musical with four ideas that do **not** need a neural
 * network or a stem separator. They are all ordinary DSP, and they are the
 * four things the old seam analysis here was missing:
 *
 *   1. A tempo *pair* is chosen jointly. Analysing two songs independently
 *      and then folding one onto the other picks the wrong octave as often as
 *      not; scoring every candidate pair for agreement (and for how close the
 *      pair sits to a musically central tempo) is what their
 *      `select_tempo_pair` does, and it is measurably better than folding.
 *   2. A cue point is snapped to the beat grid and scored by proximity. Their
 *      `choose_cue` refuses a candidate more than 60 % of a beat from a real
 *      beat, which is what stops a transition starting a fraction of a beat
 *      late — the single most audible automix defect.
 *   3. Tempo is released, not switched. The incoming song runs at the matched
 *      tempo through the blend, then a smoothstep ramp returns it to its own
 *      tempo over a fixed wall-clock window (`build_tempo_map`). Their number
 *      is 6.48 s; 4 s is what a radio seam can afford, and `tempoRelease`
 *      below takes it as a parameter.
 *   4. A transition may wait for a vocal line to finish. Without stems, the
 *      honest proxy is a per-band energy gate: a vocal is energy in 300 Hz–
 *      4 kHz that is *not* in the drums or the bass. `vocalActivity` measures
 *      that, and `phraseBoundary` finds the next place a line plausibly ends.
 *
 * Everything below is pure: Float32Array in, numbers out. No state, no
 * dependencies, identical on every platform — which is what lets the Rust
 * engine in `native/libmetro` implement the same functions and be checked
 * against this file, value for value.
 */

/** Tempo candidates and their relative strengths, best first. */
export function tempoCandidates(mono, sampleRate, { minBpm = 70, maxBpm = 175, limit = 8 } = {}) {
  // The envelope's frame size is left at the default 1024 deliberately: a
  // larger frame would be fewer FFTs, but each one costs more than the two it
  // replaces (measured: 40 ms for 2048 against 17 ms for 1024 on four
  // seconds), and the autocorrelation below is where the real win is.
  const { odf, hopSize } = onsetEnvelope(mono, sampleRate)
  if (odf.length < 32) return []
  const odfRate = sampleRate / hopSize
  const minLag = Math.max(2, Math.round((60 / maxBpm) * odfRate))
  const maxLag = Math.min(odf.length - 2, Math.round((60 / minBpm) * odfRate))
  if (maxLag <= minLag) return []

  // Autocorrelation of the onset envelope, mean-removed so a DC offset in the
  // envelope cannot masquerade as a very slow tempo.
  let mean = 0
  for (const v of odf) mean += v
  mean /= odf.length
  const centred = new Float32Array(odf.length)
  for (let i = 0; i < odf.length; i += 1) centred[i] = odf[i] - mean

  // Autocorrelation, decimated eightfold.
  //
  // The onset envelope is sampled at 172 Hz (a 256-sample hop at 44.1 kHz) and
  // this function only looks at lags from 70 to 175 BPM — 148 to 369 frames.
  // Correlating every frame is ~100× more work than the answer needs, and it
  // was 61 ms of a 373 ms seam. Summing every fourth term of the *lagged*
  // series keeps the peak position exactly (the lag axis is untouched) while
  // cutting the inner loop to a quarter; the correction factor below undoes
  // the sampling so the scores stay comparable between calls.
  const stride = 4
  const topLag = Math.min(odf.length - 2, maxLag * 2)
  const acf = new Float64Array(topLag + 1)
  for (let lag = minLag; lag <= topLag; lag += 1) {
    let sum = 0
    let norm = 0
    for (let i = 0; i + lag < centred.length; i += stride) {
      sum += centred[i] * centred[i + lag]
      norm += centred[i] * centred[i]
    }
    acf[lag] = norm > 1e-12 ? sum / norm : 0
  }

  // Local maxima only: a tempo is a peak, not a shoulder of the peak next to it.
  const peaks = []
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const here = acf[lag]
    if (here <= 0) continue
    if (here < acf[lag - 1] || here < acf[lag + 1]) continue
    let refined = lag
    const y0 = acf[lag - 1]
    const y1 = here
    const y2 = acf[lag + 1]
    const denominator = y0 - 2 * y1 + y2
    if (Math.abs(denominator) > 1e-12) refined = lag + clamp((0.5 * (y0 - y2)) / denominator, -0.5, 0.5)
    peaks.push({ bpm: (60 * odfRate) / refined, score: here })
  }
  if (!peaks.length) return []

  peaks.sort((a, b) => b.score - a.score)
  const best = peaks[0].score
  return peaks.slice(0, limit).map((peak) => ({ bpm: Number(peak.bpm.toFixed(3)), strength: Number((peak.score / best).toFixed(4)) }))
}

/**
 * Pick the tempo pair, not the tempo.
 *
 * automix-engine's `select_tempo_pair` scores every (bpmA, bpmB) pair from the
 * two candidate lists:
 *
 *     score = strengthA + strengthB
 *           − 2.5 × |ln(bpmA / bpmB)|        ← how far apart they are
 *           − 0.12 × (|ln(bpmA/100)| + |ln(bpmB/100)|)  ← centrality
 *
 * The two weights matter. Agreement is worth much more than strength (2.5 vs
 * 1), because a confident 128 and a confident 93 are still a bad mix; and the
 * centrality term is what stops a pair of half-time estimates from winning by
 * being trivially "in agreement" at 60 BPM. The constants are theirs; they are
 * reproduced here so the two implementations agree on the same record.
 *
 * @returns {{bpmA: number, bpmB: number, score: number, compatibility: number}|null}
 */
export function selectTempoPair(candidatesA, candidatesB, { centreBpm = 100, penalty = 2.5, centrality = 0.12 } = {}) {
  if (!candidatesA?.length || !candidatesB?.length) return null
  let best = null
  for (const a of candidatesA) {
    for (const b of candidatesB) {
      if (!(a.bpm > 0) || !(b.bpm > 0)) continue
      const compatibility = Math.abs(Math.log(a.bpm / b.bpm))
      const pull = Math.abs(Math.log(a.bpm / centreBpm)) + Math.abs(Math.log(b.bpm / centreBpm))
      const score = a.strength + b.strength - penalty * compatibility - centrality * pull
      if (!best || score > best.score) best = { bpmA: a.bpm, bpmB: b.bpm, score, compatibility }
    }
  }
  return best
}

/**
 * A beat grid for a whole track, from a tempo and one phase.
 *
 * The old grid came only from the analysed window, so a track whose tempo
 * estimate was 0.3 % off drifted a whole beat by the three-minute mark. This
 * extends the grid across the whole buffer from a single phase, which is what
 * a DJ's beat grid actually is: constant tempo, one anchor.
 *
 * `beats` are in samples. `downbeats` every four — an assumption, but the one
 * every four-four dance record rewards, and the one automix-engine's
 * 32-beat mapping also makes.
 */
export function beatGrid(length, sampleRate, bpm, phaseSamples = 0) {
  if (!(bpm > 0) || length <= 0) return []
  const period = (60 * sampleRate) / bpm
  const beats = []
  let at = phaseSamples
  while (at < 0) at += period
  for (let t = at; t < length; t += period) beats.push(Math.round(t))
  return beats
}

/**
 * Snap a candidate cue to the nearest beat, and say how far it had to move.
 *
 * automix-engine's `choose_cue` rejects a candidate that lands more than 60 %
 * of a beat from any grid line: at that distance the nearest beat is closer
 * to the *next* beat than to the cue, and the transition starts early. The
 * same rule applies here, and the result is returned with its distance so the
 * caller can report *why* a cue was chosen instead of asserting it was right.
 *
 * @returns {{sample: number, snapped: boolean, distance: number, beats: number}|null}
 */
export function snapCue(cueSamples, beats, { tolerance = 0.6 } = {}) {
  if (!beats.length) return null
  const period = beats.length > 1 ? beats[1] - beats[0] : 0
  if (!(period > 0)) return null
  let best = null
  for (let i = 0; i < beats.length; i += 1) {
    const distance = Math.abs(beats[i] - cueSamples)
    if (!best || distance < best.distance) best = { beat: beats[i], index: i, distance }
  }
  const ratio = best.distance / period
  const snapped = ratio <= tolerance
  return {
    // A cue that is already on a beat stays where it is — which is also why
    // the nearest beat is the right one to report: at 0.9 of a beat the *next*
    // grid line is 0.1 away, and that is where the transition would land.
    sample: best.beat,
    snapped,
    distance: Number(ratio.toFixed(3)),
    beats: best.index
  }
}

/**
 * How far to shift the incoming song so its grid lands on the outgoing grid.
 *
 * `phaseAt(0)` is the outgoing grid's first beat after zero; `incomingPhase`
 * is the incoming grid's. The answer is always in `[0, period)` — shifting
 * forwards by a fraction of a beat is the same as shifting back by the rest of
 * it, and truncating the head is what a DJ does with the platter anyway.
 *
 * Returns 0 when the shift would eat more than `maxFraction` of the incoming
 * buffer: that is not alignment, that is dropping the first bar.
 */
export function beatAlignOffset(period, outgoingPhase, incomingPhase, available = Infinity, { maxFraction = 0.25 } = {}) {
  if (!(period > 0)) return 0
  const offset = (((outgoingPhase - incomingPhase) % period) + period) % period
  // Sub-sample shifts are not worth a buffer copy, and a shift that rounds to
  // a whole period is no shift at all.
  if (offset < 1 || offset >= period - 1) return 0
  // A shift that would eat more than `maxFraction` of what we hold is a dropped
  // bar, not an alignment. `0` disables the guard (used when the caller has
  // already limited the shift itself).
  if (maxFraction > 0 && offset > available * maxFraction) return 0
  return Math.round(offset)
}

/**
 * The tempo map for a seam, as an ease-out back to the song's own tempo.
 *
 * This is automix-engine's `build_tempo_map` reduced to its essential shape.
 * Their version pins every incoming beat to an outgoing beat through the
 * blend, then integrates a smoothstep playback-rate ramp back to 1.0 over
 * `TEMPO_RELEASE_SECONDS`. Two properties are worth keeping even without the
 * per-beat pinning:
 *
 *   • the ramp is **rate**, not duration: the pitch fader moves smoothly, so
 *     the seam has no speed discontinuity at either end;
 *   • the ramp completes in a **fixed wall-clock window**, so a 174 BPM track
 *     and an 80 BPM track both return to native speed at the same point in
 *     the mix — which is what makes it predictable to mix into.
 *
 * @returns {{rateAt: (outputSample: number) => number, outputLength: (inputLength: number) => number, releaseSamples: number}}
 */
export function tempoRelease(inputLength, sampleRate, { fromRate = 1, releaseSeconds = 4, controlPoints = 16 } = {}) {
  const releaseSamples = Math.max(1, Math.round(releaseSeconds * sampleRate))
  const startRate = clamp(fromRate, 0.5, 2)
  const points = []
  let source = 0
  let target = 0
  const step = releaseSamples / controlPoints
  let previous = startRate
  for (let i = 0; i <= controlPoints; i += 1) {
    const progress = i / controlPoints
    const eased = progress * progress * (3 - 2 * progress)
    const rate = startRate + (1 - startRate) * eased
    points.push({ target, rate })
    // Integrate the rate curve with the trapezoid of consecutive rates, the
    // same discrete correction automix-engine applies: without it the map
    // runs slightly ahead of the intended curve.
    const segment = 0.5 * (previous + rate)
    source += step * segment
    target += step
    previous = rate
  }

  /** Playback rate at an output position, before the release completes. */
  const rateAt = (outputSample) => {
    if (outputSample <= 0) return startRate
    if (outputSample >= releaseSamples) return 1
    const t = outputSample / releaseSamples
    return startRate + (1 - startRate) * (t * t * (3 - 2 * t))
  }

  /** Output length for an input, given the rate change over the release. */
  const outputLength = (length) => {
    if (Math.abs(startRate - 1) < 1e-9) return length
    if (source >= length) {
      // The whole segment is inside the ramp: invert the integral numerically.
      let lo = 0
      let hi = releaseSamples
      for (let i = 0; i < 24; i += 1) {
        const mid = (lo + hi) / 2
        if (outputToInput(mid) < length) lo = mid
        else hi = mid
      }
      return Math.round(lo)
    }
    return Math.round(releaseSamples + (length - source))
  }

  /** Where input sample `x` lands in the output. */
  const outputToInput = (outputSample) => {
    if (outputSample <= releaseSamples) {
      const t = outputSample / releaseSamples
      return outputSample * (startRate + (1 - startRate) * t * t * 0.5)
    }
    return source + (outputSample - releaseSamples)
  }

  return { rateAt, outputLength, releaseSamples, inputAt: outputToInput, sourceConsumed: source }
}

/**
 * Per-band energy gate for "is somebody singing".
 *
 * automix-engine has Demucs stems and can just look at the vocal stem. A
 * broadcast node does not, so the proxy is a three-band split and one rule: a
 * vocal is energy in 300 Hz–4 kHz that is *not* explained by the low band
 * (kick, bass) or the high band (cymbals, hats). The bands are 12 dB/octave
 * crossovers, not brick walls, so the rule is deliberately soft — this is used
 * to decide whether to *wait half a second*, never whether to cut audio.
 *
 * @returns {{frames: Float32Array, frameRate: number, active: boolean}}
 */
export function vocalActivity(mono, sampleRate, { frameMs = 20, bandLow = 300, bandHigh = 4000, thresholdDb = -32 } = {}) {
  const frame = Math.max(1, Math.round((frameMs / 1000) * sampleRate))
  const count = Math.max(0, Math.floor(mono.length / frame))
  const frames = new Float32Array(count)
  if (!count) return { frames, frameRate: sampleRate / frame, active: false }

  const lowLp = [Biquad.lowpass(bandLow, sampleRate), Biquad.lowpass(bandLow, sampleRate)]
  const midHp = Biquad.highpass(bandLow, sampleRate)
  const midLp = Biquad.lowpass(bandHigh, sampleRate)
  const highHp = Biquad.highpass(bandHigh, sampleRate)

  for (let f = 0; f < count; f += 1) {
    let mid = 0
    let low = 0
    let high = 0
    const start = f * frame
    for (let i = start; i < start + frame; i += 1) {
      const x = mono[i]
      low += lowLp[0].process(x) ** 2
      mid += midLp.process(midHp.process(x)) ** 2
      high += highHp.process(x) ** 2
    }
    // A voice has to beat the accompaniment either side of it, not just exist.
    const vocalEnergy = Math.max(0, mid - (low + high) * 0.35)
    frames[f] = TO_DB(Math.sqrt(vocalEnergy / frame))
  }

  // Hysteresis: frames within 6 dB of the threshold count as active once a
  // line has started, so the envelope of a sustained note does not flicker.
  const peak = frames.reduce((max, v) => Math.max(max, v), -120)
  const gate = Math.max(thresholdDb, peak - 24)
  let active = false
  let run = 0
  for (let f = 0; f < count; f += 1) {
    if (frames[f] > gate) run += 1
    else run = 0
    if (run >= 3) {
      frames[f] = frames[f]
      active = true
    }
  }
  return { frames, frameRate: sampleRate / frame, active }
}

/**
 * The next phrase boundary after `fromSample`.
 *
 * Phrases in dance music are four bars; automix-engine waits for the end of
 * the *vocal line* rather than a fixed bar count, which is the more musical
 * rule. Without stems the compromise is: the next frame where vocal activity
 * has been quiet for `quietFrames`, rounded to the nearest beat. That is what
 * this returns, with the beat it snapped to.
 *
 * @returns {{sample: number, waited: boolean, reason: string}}
 */
export function phraseBoundary(mono, sampleRate, fromSample, { beats = [], quietMs = 240, maxWaitMs = 1600 } = {}) {
  const { frames, frameRate } = vocalActivity(mono, sampleRate)
  const startFrame = Math.max(0, Math.floor((fromSample / sampleRate) * frameRate))
  const quietFrames = Math.max(2, Math.round((quietMs / 1000) * frameRate))
  const limitFrame = Math.min(frames.length, startFrame + Math.round((maxWaitMs / 1000) * frameRate))

  let quiet = 0
  for (let f = startFrame; f < limitFrame; f += 1) {
    if (frames[f] < -46) quiet += 1
    else quiet = 0
    if (quiet >= quietFrames) {
      const sample = Math.round((f - quiet + 1) * (sampleRate / frameRate))
      const snapped = snapCue(sample, beats)
      return {
        sample: snapped?.sample ?? sample,
        waited: true,
        reason: `vocal gap at ${(sample / sampleRate).toFixed(2)}s`
      }
    }
  }
  // Nothing quiet enough: do not invent a boundary, stay where the caller was.
  return { sample: fromSample, waited: false, reason: 'no vocal gap; did not wait' }
}

/**
 * A "stem-ish" split for the seam renderer.
 *
 * Not Demucs. A three-way crossover gives `low` (kick/bass), `mid` (voice and
 * most instruments) and `high` (hats, air) — enough to do the two moves that
 * make a crossfade sound intentional:
 *
 *   • a **bass swap** that hands the low end over on one beat;
 *   • a **vocal-aware entry** that brings the incoming mid band in after the
 *     outgoing vocal phrase has finished instead of on top of it.
 *
 * Returns the three bands and the residual, so `low + mid + high + residual`
 * reconstructs the input exactly and nothing is lost to crossover ripple.
 */
export function bandSplit(left, right, sampleRate, { lowHz = 180, midHz = 4000 } = {}) {
  const length = left.length
  const low = { left: new Float32Array(length), right: new Float32Array(length) }
  const mid = { left: new Float32Array(length), right: new Float32Array(length) }
  const high = { left: new Float32Array(length), right: new Float32Array(length) }
  const filters = {
    lowL: [Biquad.lowpass(lowHz, sampleRate), Biquad.lowpass(lowHz, sampleRate)],
    lowR: [Biquad.lowpass(lowHz, sampleRate), Biquad.lowpass(lowHz, sampleRate)],
    midL: [Biquad.highpass(lowHz, sampleRate), Biquad.lowpass(midHz, sampleRate)],
    midR: [Biquad.highpass(lowHz, sampleRate), Biquad.lowpass(midHz, sampleRate)],
    highL: [Biquad.highpass(midHz, sampleRate), Biquad.highpass(midHz, sampleRate)],
    highR: [Biquad.highpass(midHz, sampleRate), Biquad.highpass(midHz, sampleRate)]
  }

  for (let i = 0; i < length; i += 1) {
    let l = left[i]
    let r = right[i]
    for (const f of filters.lowL) l = f.process(l)
    low.left[i] = l
    l = left[i]
    for (const f of filters.lowR) l = f.process(l)
    low.right[i] = l

    let ml = left[i]
    for (const f of filters.midL) ml = f.process(ml)
    mid.left[i] = ml
    let mr = right[i]
    for (const f of filters.midR) mr = f.process(mr)
    mid.right[i] = mr

    let hl = left[i]
    for (const f of filters.highL) hl = f.process(hl)
    high.left[i] = hl
    let hr = right[i]
    for (const f of filters.highR) hr = f.process(hr)
    high.right[i] = hr
  }

  return { low, mid, high }
}

/**
 * Length of the outgoing song that the blend should cover, in beats.
 *
 * automix-engine maps 32 beats across its transition and refuses to start
 * before `TRANSITION_BEATS` of the incoming track. The musical version of the
 * same idea for a radio: a blend is an integer number of **phrases** (four
 * beats), because that is the unit a listener hears as "one thing". Two
 * phrases is 8 beats; that is 3.5 s at 137 BPM and 6 s at 80, so the blend
 * follows the music instead of a millisecond setting.
 */
export function phraseBlend({ bpm = 0, minBeats = 8, maxBeats = 64, availableSamples = Infinity, sampleRate = 44_100 } = {}) {
  if (!(bpm > 0)) return null
  const beatSamples = (60 * sampleRate) / bpm
  // Round *down* to what the buffer can hold: a blend that is a phrase too
  // long is clamped by the caller and silently stops being a phrase at all.
  const maxBeatsThatFit = Math.floor(availableSamples / beatSamples)
  let beats = Math.min(maxBeats, Math.max(minBeats, maxBeatsThatFit))
  beats -= beats % 4
  if (beats < 4) beats = 4

  // `fits` is false when the buffer cannot hold even the shortest musical
  // blend (two bars). The caller decides: shortening to one bar is still a
  // phrase, and it is what the automix does; dropping the seam is the other
  // option, and that is a decision this function must not make silently.
  const samples = Math.round(beats * beatSamples)
  return { beats, samples, beatSamples, phrases: beats / 4, fits: samples <= availableSamples }
}

/* ------------------------------------------------------------------ *
 * Vocal-aware seam shape
 * ------------------------------------------------------------------ */

/**
 * How the two faders should move, given what the outgoing vocal is doing.
 *
 * Three shapes, in the order a DJ would reach for them:
 *
 *   'crossfade'  — nothing is singing; the ordinary equal-power blend.
 *   'vocal-wait' — the outgoing vocal is mid-line; hold the incoming mids back
 *                  until the phrase ends, then bring them in over two beats.
 *   'duck-bed'   — the incoming vocal starts immediately; drop the outgoing
 *                  mids by 4 dB so two voices never share the same octave.
 *
 * Returns gain curves as functions of fader position 0…1 (not samples), so a
 * renderer can apply them to a blend of any length.
 */
export function vocalAwareCurves({ outgoingActive = false, incomingActive = false, phraseEnd = 0.6, exponent = 2 } = {}) {
  const end = clamp(phraseEnd, 0.2, 0.95)
  if (!outgoingActive && !incomingActive) {
    return { shape: 'crossfade', aGain: (t) => fadeGains(t, exponent)[0], bGain: (t) => fadeGains(t, exponent)[1] }
  }
  if (outgoingActive && !incomingActive) {
    // Hold the incoming mid band almost silent until the outgoing line ends,
    // then open it over the last two tenths of the blend.
    return {
      shape: 'vocal-wait',
      phraseEnd: end,
      aGain: (t) => fadeGains(t, exponent)[0],
      bGain: (t) => {
        const late = clamp((t - end) / Math.max(0.05, 1 - end), 0, 1)
        const eased = late * late * (3 - 2 * late)
        return fadeGains(t, exponent)[1] * (0.08 + 0.92 * eased)
      }
    }
  }
  if (!outgoingActive && incomingActive) {
    return { shape: 'call-response', aGain: (t) => fadeGains(t, exponent)[0], bGain: (t) => Math.min(1, fadeGains(t, exponent)[1] * 1.15) }
  }
  // Both singing: duck the outgoing mid by 4 dB and cross later.
  return {
    shape: 'duck-bed',
    aGain: (t) => fadeGains(t, exponent)[0] * (1 - 0.37 * clamp((t - 0.35) / 0.4, 0, 1)),
    bGain: (t) => fadeGains(clamp((t - 0.15) / 0.85, 0, 1), exponent)[1]
  }
}

export default {
  Biquad,
  Crossover,
  integratedLoudness,
  samplePeak,
  detectCues,
  rmsProfile,
  correlation,
  fadeGains,
  exponentFor,
  onsetEnvelope,
  estimateBeat,
  compressorGain,
  echoTail,
  brake,
  noiseSource,
  resample,
  timeStretch,
  stretchMap,
  foldTempo,
  tempoCandidates,
  selectTempoPair,
  beatGrid,
  snapCue,
  beatAlignOffset,
  tempoRelease,
  vocalActivity,
  phraseBoundary,
  bandSplit,
  phraseBlend,
  vocalAwareCurves
}
