/**
 * Tempo stretch and pitch shift for the chain's stream-level stage.
 *
 * `timescale` does not run per block, so the segment is stretched on the way
 * out. NodeLink resamples and accepts the pitch change; a radio station cannot
 * — a 4 % tempo change that also lifts the key by 70 cents is heard as a
 * detuned record, which is exactly the thing this filter exists to avoid.
 *
 * Two halves, in the order that makes the arithmetic simple:
 *
 *   1. **WSOLA** moves the tempo. It takes overlapping windows of the input at
 *      the analysis rate and places them at the synthesis rate, searching a
 *      small neighbourhood for the offset whose waveform best continues the
 *      previous one (cross-correlation on a decimated grid, which is where the
 *      "waveform similarity" in WSOLA comes from). Pitch is untouched.
 *   2. **A resampler** applies the remaining pitch factor. Pitch shift at
 *      constant tempo is a stretch followed by a resample — the two always
 *      come as a pair, which is why they live in one module.
 *
 * This is the pure-JS path. `native/` has a Rust stretcher with the same
 * signature; `util/metro.js` picks whichever is available, and this one is the
 * fallback that makes `applyTempoStretch` work on a bare Node install and on
 * Vercel, where a native addon would have to be rebuilt for the platform.
 */
import { SAMPLE_RATE } from './constants.js'

/** Linear-interpolation resampler: `ratio` is input samples per output sample. */
export function resample(input, ratio) {
  if (ratio === 1) return input
  const out = new Float32Array(Math.max(0, Math.round(input.length / ratio)))
  for (let i = 0; i < out.length; i += 1) {
    const source = i * ratio
    const whole = Math.floor(source)
    const fraction = source - whole
    const a = input[Math.min(input.length - 1, whole)] ?? 0
    const b = input[Math.min(input.length - 1, whole + 1)] ?? a
    out[i] = a + (b - a) * fraction
  }
  return out
}

/**
 * Normalised cross-correlation between `target` and `candidate` over `length`.
 *
 * Normalised, not raw: raw correlation always prefers the loudest window, so a
 * snare would beat the continuing tone every time and every blend would be
 * smeared towards the beat.
 */
function similarity(target, candidate, length) {
  let dot = 0
  let energyA = 0
  let energyB = 0
  for (let i = 0; i < length; i += 1) {
    const a = target[i]
    const b = candidate[i]
    dot += a * b
    energyA += a * a
    energyB += b * b
  }
  const denominator = Math.sqrt(energyA * energyB)
  return denominator > 1e-9 ? dot / denominator : 0
}

/**
 * WSOLA time stretch of one channel.
 *
 * @param {Float32Array} input
 * @param {number} ratio output/input: 0.5 plays the same material in half the time
 * @param {object} [options]
 * @param {number} [options.frameMs] analysis window (default 40 ms)
 * @param {number} [options.toleranceMs] how far the search may move a frame
 * @returns {Float32Array}
 */
export function wsola(input, ratio, { frameMs = 40, toleranceMs = 8, sampleRate = SAMPLE_RATE } = {}) {
  if (Math.abs(ratio - 1) < 1e-4 || input.length === 0) return input
  const frame = Math.max(64, Math.round((frameMs / 1000) * sampleRate))
  const hop = Math.round(frame / 2)
  const tolerance = Math.max(1, Math.round((toleranceMs / 1000) * sampleRate))
  const outputLength = Math.max(1, Math.round(input.length * ratio))
  const out = new Float32Array(outputLength + frame)

  // Hann window, accumulated into a second array so the overlap-add is
  // normalised: without the normalisation every frame boundary is a 6 dB dip,
  // which at 40 ms frames is a 25 Hz buzz — audible on a held note.
  const window = new Float32Array(frame)
  for (let i = 0; i < frame; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame)
  const weight = new Float32Array(out.length)

  // Frames are laid down at a fixed output hop; the *read* position advances by
  // `hop / ratio`, which is what makes the output shorter or longer than the
  // input. At ratio 0.75 the reader moves 1.33 hops per written hop; at 1.5 it
  // moves 0.67, so material is repeated — that is the stretch, not a bug.
  const step = hop / ratio
  let write = 0
  let read = 0
  let previous = null

  while (write < outputLength) {
    const ideal = Math.round(read)
    let best = Math.max(0, Math.min(input.length - frame - 1, ideal))

    if (previous) {
      // Waveform-similarity search: move the frame up to `tolerance` samples
      // so its head continues the tail of the frame just written. The first
      // 512 samples are enough — that is the pitch period range at 44.1 kHz.
      let bestScore = -Infinity
      for (let offset = -tolerance; offset <= tolerance; offset += 4) {
        const at = ideal + offset
        if (at < 0 || at + frame >= input.length) continue
        const score = similarity(previous, input.subarray(at, at + frame), Math.min(frame, 512))
        if (score > bestScore) {
          bestScore = score
          best = at
        }
      }
    }

    for (let i = 0; i < frame; i += 1) {
      const source = best + i
      const destination = write + i
      if (source >= input.length || destination >= out.length) break
      out[destination] += input[source] * window[i]
      weight[destination] += window[i]
    }

    // The next frame is compared against what this one actually wrote, which
    // is what keeps the seam continuous rather than merely close.
    previous = out.slice(write, write + frame)
    write += hop
    read += step
  }

  for (let i = 0; i < outputLength; i += 1) {
    if (weight[i] > 1e-6) out[i] /= weight[i]
  }
  return out.subarray(0, outputLength)
}

/**
 * Stretch both channels to the same length, in one pass.
 *
 * The two channels are stretched independently but with identical frame
 * positions — a stereo pair whose channels stretch to different lengths is a
 * phase error, and a phase error on a stereo mix is a hole in the middle.
 */
export function tempoStretch(channels, { ratio = 1, sampleRate = SAMPLE_RATE } = {}) {
  if (Math.abs(ratio - 1) < 1e-4) return { channels, ratio: 1 }
  // `ratio` is output/input, the same convention as `wsola` and as the native
  // stretcher's `{ stretch }`: 1.25 makes the material 25 % *longer*.
  const stretched = channels.map((channel) => wsola(channel, ratio, { sampleRate }))
  const length = Math.min(...stretched.map((channel) => channel.length))
  return { channels: stretched.map((channel) => channel.subarray(0, length)), ratio }
}

/**
 * Apply a timescale request to decoded PCM.
 *
 * `speed`, `pitch` and `rate` compose as a turntable's do: tempo is
 * `speed × rate`, key is `speed × pitch`. The stretch handles the tempo and
 * the resampler handles what is left of the key.
 *
 * @param {Float32Array[]} channels
 * @param {{speed?: number, pitch?: number, rate?: number}} request
 */
export function applyTempoStretch(channels, request = {}, { sampleRate = SAMPLE_RATE } = {}) {
  const speed = request.speed ?? 1
  const pitch = request.pitch ?? 1
  const rate = request.rate ?? 1
  const tempo = speed * rate
  const key = speed * pitch

  if (Math.abs(tempo - 1) < 1e-4 && Math.abs(key - 1) < 1e-4) {
    return { channels, tempo: 1, pitch: 1 }
  }

  // Two stages, and the algebra is worth spelling out because the two knobs
  // move the same two quantities:
  //
  //   wsola(ratio a)      length ×a,      pitch ×1   (that is what WSOLA is)
  //   resample(ratio b)   length ÷b,      pitch ×b
  //
  // Final pitch must be `key`, so b = key. Final length must be n/tempo, so
  // a·n/key = n/tempo, hence a = key/tempo. For `speed` alone that is a = 1 and
  // b = speed — a pure resample, exactly like a turntable, which is the point.
  let output = channels
  const a = key / tempo
  if (Math.abs(a - 1) > 1e-4) {
    output = tempoStretch(channels, { ratio: a, sampleRate }).channels
  }
  if (Math.abs(key - 1) > 1e-4) {
    output = output.map((channel) => resample(channel, key))
  }

  const length = Math.min(...output.map((channel) => channel.length))
  return { channels: output.map((channel) => channel.subarray(0, length)), tempo, pitch: key }
}

/**
 * Pitch shift alone, at constant tempo — the pair a console's "key" control
 * needs, and the reason `applyPitchShift` existed as an empty stub.
 */
export function applyPitchShift(channels, semitones = 0, { sampleRate = SAMPLE_RATE } = {}) {
  if (!semitones) return { channels, pitch: 1 }
  const factor = Math.pow(2, semitones / 12)
  // Up a fifth: stretch by 1.498 (longer, same pitch), then read it back 1.498×
  // faster. The two cancel in length and add up in pitch — a resample alone
  // would raise the pitch and shorten the track, which is the wrong half.
  const stretched = tempoStretch(channels, { ratio: factor, sampleRate }).channels
  const shifted = stretched.map((channel) => resample(channel, factor))
  const length = Math.min(...shifted.map((channel) => channel.length))
  return { channels: shifted.map((channel) => channel.subarray(0, length)), pitch: factor }
}

export default applyTempoStretch
