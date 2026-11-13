/**
 * Tempo, beat grid and phrase-aware mixing decisions.
 */
import * as analysis from './analysis.js'
import * as transform from './transform.js'

const { Biquad, Crossover, DB, TO_DB, clamp, correlation, fadeGains, integratedLoudness, onsetEnvelope } = analysis
const { foldTempo, timeStretch } = transform

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
