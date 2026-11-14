/**
 * Joint tempo analysis: when the scalar estimate is unsure or octave-ambiguous,
 * score candidate pairs instead of trusting one number.
 */
import { beatGrid, selectTempoPair, tempoCandidates } from '../dsp.ts'

export async function analysePair(options, windowA, windowB, sampleRate, beatA, beatB) {

    if (options.analysePair === false) return null
    if (!beatA || !beatB) return null
    if (!(beatA.bpm > 0) || !(beatB.bpm > 0)) return null

    // Two reasons to look harder, and they are the two ways the scalar
    // estimator is known to fail:
    //
    //   • it was not sure; or
    //   • the two answers are within 8 % of a power-of-two ratio. That is the
    //     octave ambiguity — 128 and 64 describe the same groove, and *both*
    //     are highly confident, so confidence alone can never catch it. A
    //     half-time estimate here is not a curiosity: it makes the beatmatch
    //     stretch by 100 %, which is rejected by `maxStretchPercent` and the
    //     two songs go out unmixed.
    const ratio = beatA.bpm / beatB.bpm
    const nearest = 2 ** Math.round(Math.log2(ratio))
    const octaveAmbiguous = Math.abs(ratio - nearest) / nearest < 0.08
    const unsure = beatA.confidence <= 0.35 || beatB.confidence <= 0.35
    if (!unsure && !octaveAmbiguous) return null

    // Four seconds, not eight. The autocorrelation only has to find lags of
    // 0.34–0.86 s (70–175 BPM), so it needs a few periods, not a phrase; at
    // four seconds each window still holds 5–11 beats of every tempo in range
    // and the candidate lists are identical to the eight-second ones on the
    // fixtures. Halving it halves the only stage that runs two analyses at
    // once, which is most of what is left of the seam's cost.
    const limit = Math.round(4 * sampleRate)
    const a = windowA.length > limit ? windowA.subarray(0, limit) : windowA
    const b = windowB.length > limit ? windowB.subarray(0, limit) : windowB
    const [candidatesA, candidatesB] = await Promise.all([
      Promise.resolve().then(() => tempoCandidates(a, sampleRate)),
      Promise.resolve().then(() => tempoCandidates(b, sampleRate))
    ])
    const pair = selectTempoPair(candidatesA, candidatesB)
    if (!pair) return null

    // A beat grid over the analysed window, phase-locked to the pair's tempo.
    const gridFor = (window, bpm, estimate) => {
      const period = (60 * sampleRate) / bpm
      const beats = beatGrid(window.length, sampleRate, bpm, estimate?.phaseSamples ?? 0)
      return {
        bpm,
        periodSamples: period,
        phaseSamples: estimate?.phaseSamples ?? 0,
        beats,
        confidence: Math.max(estimate?.confidence ?? 0, pair.compatibility < 0.01 ? 0.55 : 0.4),
        candidates: candidatesA.length,
        source: 'pair'
      }
    }

    return {
      beatA: gridFor(a, pair.bpmA, beatA),
      beatB: gridFor(b, pair.bpmB, beatB),
      bpmA: pair.bpmA,
      bpmB: pair.bpmB,
      compatibility: Number(pair.compatibility.toFixed(4)),
      score: Number(pair.score.toFixed(3))
    }
  
}
