/**
 * DSP primitives for the automix — pure Float32Array in, Float32Array out.
 *
 * Split by job: `dsp/analysis.js` (biquads, loudness, cues, FFT, beats),
 * `dsp/transform.js` (dynamics and time-domain transforms) and
 * `dsp/tempo.js` (tempo candidates, beat grid and phrase decisions).
 */
export * from './dsp/analysis.ts'
export * from './dsp/transform.ts'
export * from './dsp/tempo.ts'
