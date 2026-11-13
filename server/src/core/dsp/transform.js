/**
 * Level, dynamics and time-domain transforms.
 */
import { DB, TO_DB, Biquad, correlation, clamp } from './analysis.js'

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
