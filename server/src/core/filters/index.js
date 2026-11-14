/**
 * Station filters — the NodeLink surface, in a folder.
 *
 * One module per filter, one registry, one chain. The old single-file
 * `filters.js` is gone; this index is the public face of the folder and keeps
 * every name it exported, so an import site never had to change.
 *
 *   filters/
 *     BaseFilter.js        the four-method contract
 *     AnimatableFilter.js  smooth transitions (NodeLink's `transition`)
 *     registry.js          name → class, priority, schema
 *     schema.js            defaults, neutral values, validation
 *     chain.js             compile + FilterChain + render
 *     stretch.js           WSOLA tempo stretch, pitch shift
 *     dsp/                 biquad, delay, LFO, allpass, clamp, waves
 *     <name>.js            one filter, one file
 */
import { EQ_BANDS, SAMPLE_RATE, neutralValue } from './constants.js'
import { FILTER_NAMES, FILTER_ORDER } from './registry.js'
import { FILTER_SCHEMA, isActive, neutralSettings, defaultsFor, validate } from './schema.js'
import { FilterChain, compile, crossfade, makeFilter, processWithMorph, render } from './chain.js'
import { applyPitchShift, applyTempoStretch, resample, tempoStretch, wsola } from './stretch.js'
import { BaseFilter } from './BaseFilter.js'
import { AnimatableFilter, curveValue } from './AnimatableFilter.js'

/**
 * Render a whole segment through the chain, applying the stream-level stage
 * when there is one.
 *
 * `stretch` is injected rather than imported so this module stays pure DSP:
 * the caller decides whether the native Rust stretcher or the JS WSOLA in
 * `stretch.js` does the work, and Vercel — where a native addon has to be
 * rebuilt for the platform — gets the JS one without a code path of its own.
 *
 * @param {{left: Float32Array, right: Float32Array}} audio
 * @param {object} payload
 * @param {object} [options]
 * @param {Function} [options.stretch] `(channels, sampleRate, {stretch}) => {channels}`
 */
export async function renderWithStretch(audio, payload = {}, { sampleRate = SAMPLE_RATE, stretch } = {}) {
  const chain = new FilterChain(payload, { sampleRate })
  let { left, right } = audio
  let length = Math.min(left.length, right.length)
  left = Float32Array.from(left.subarray(0, length))
  right = Float32Array.from(right.subarray(0, length))

  const request = chain.streamRequest
  if (request) {
    const tempo = (request.speed ?? 1) * (request.rate ?? 1)
    const key = (request.speed ?? 1) * (request.pitch ?? 1)

    if (typeof stretch === 'function') {
      // The caller's stretcher is the tempo stage; its contract is output/input,
      // so a 10 % tempo increase is 10 % *shorter*.
      if (Math.abs(tempo - 1) > 1e-4) {
        const out = await stretch([left, right], sampleRate, { stretch: 1 / tempo })
        left = Float32Array.from(out.channels[0])
        right = Float32Array.from(out.channels[1] ?? out.channels[0])
        length = Math.min(left.length, right.length)
      }
      const shift = key / tempo
      if (Math.abs(shift - 1) > 1e-4) {
        left = resample(left, shift)
        right = resample(right, shift)
        length = Math.min(left.length, right.length)
      }
    } else {
      // No stretcher supplied: the JS path does both halves, and reports what
      // it actually did rather than what was asked for.
      const stretched = applyTempoStretch([left, right], request, { sampleRate })
      left = Float32Array.from(stretched.channels[0])
      right = Float32Array.from(stretched.channels[1] ?? stretched.channels[0])
      length = Math.min(left.length, right.length)
    }
  }

  chain.process(left, right, length)
  return { left, right, length, chain: chain.active, stream: request }
}

/**
 * Everything above, as a description the console and the REST surface can
 * render without knowing any of it: the bands, the ranges, the defaults, and
 * which filters are currently engaged.
 */
export function describe(payload = {}) {
  const compiled = compile(payload)
  return {
    bands: EQ_BANDS,
    filters: Object.entries(FILTER_SCHEMA).map(([name, spec]) => ({
      name,
      priority: FILTER_ORDER.indexOf(name),
      params: Object.entries(spec).map(([key, entry]) => ({
        key,
        ...('range' in entry ? { min: entry.range[0], max: entry.range[1] } : {}),
        ...(entry.integer ? { integer: true } : {}),
        ...('default' in entry ? { default: entry.default } : {}),
        ...(entry.list ? { list: true } : {}),
        ...(entry.array ? { array: true } : {})
      }))
    })),
    active: compiled.active,
    unknown: compiled.unknown,
    clamped: compiled.clamped,
    animations: true
  }
}

/* Loudness helpers historically re-exported here. They live in core/dsp.js,
 * which imports nothing from this folder, so the cycles stay one-directional. */
export { integratedLoudness, samplePeak } from '../dsp.js'

export {
  EQ_BANDS,
  SAMPLE_RATE,
  FILTER_NAMES,
  FILTER_ORDER,
  FILTER_SCHEMA,
  FilterChain,
  BaseFilter,
  AnimatableFilter,
  curveValue,
  applyPitchShift,
  applyTempoStretch,
  compile,
  crossfade,
  processWithMorph,
  defaultsFor,
  isActive,
  makeFilter,
  neutralSettings,
  neutralValue,
  render,
  resample,
  tempoStretch,
  validate,
  wsola
}

export default {
  FILTER_NAMES,
  FILTER_ORDER,
  FILTER_SCHEMA,
  EQ_BANDS,
  FilterChain,
  compile,
  validate,
  render,
  renderWithStretch,
  describe,
  makeFilter,
  isActive,
  neutralSettings,
  applyTempoStretch,
  applyPitchShift
}
