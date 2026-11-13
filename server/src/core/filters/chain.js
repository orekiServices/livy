/**
 * The chain — compile a payload, then run blocks through it.
 *
 * This is the only place that decides what runs and in what order, so the
 * station, the REST surface and the preview renderer all get the same answer.
 */
import { FILTERS, FILTER_ORDER, FILTER_NAMES } from './registry.js'
import { isActive, validate } from './schema.js'
import { SAMPLE_RATE } from './constants.js'

/**
 * Build one filter instance for a registry entry.
 *
 * `equalizerStandalone` shares the equaliser's class but not its key or its
 * single-band shape, which is why the registry entry carries both flags rather
 * than this function special-casing a name.
 */
export function makeFilter(name, config = {}, { sampleRate = SAMPLE_RATE } = {}) {
  const entry = FILTERS[name]
  if (!entry) return null
  const { Filter, single, settings } = entry
  const filter = new Filter(config, { sampleRate, single, key: settings ?? name })
  filter.payloadKey = settings ?? name
  // The chain reports what is running, and a single band reports itself as the
  // equaliser it is — the console shows one EQ, not two.
  if (name === 'equalizerStandalone') filter.name = 'equalizer'
  return filter
}

/**
 * Compile a payload into a runnable chain.
 *
 * @param {object} payload NodeLink-shaped filter settings
 * @param {object} [options]
 * @param {number} [options.sampleRate]
 * @returns {{active: string[], chain: object[], skipped: string[], unknown: string[], clamped: string[], sampleRate: number}}
 */
export function compile(payload = {}, { sampleRate = SAMPLE_RATE } = {}) {
  const { settings, unknown, clamped } = validate(payload)
  const usable = {}

  // `equalizerStandalone` is one band of the same equaliser; if both are set,
  // the single band is applied on top, which is what a console with a master
  // strip next to a band rack should do.
  for (const [name, config] of Object.entries(settings)) {
    if (config && isActive(name, config)) usable[name] = config
  }

  const chain = FILTER_ORDER.filter((name) => usable[name])
    .map((name) => makeFilter(name, usable[name], { sampleRate }))
    .filter(Boolean)

  return {
    active: chain.map((filter) => filter.name),
    chain,
    skipped: Object.keys(settings).filter((name) => !usable[name]),
    unknown,
    clamped,
    sampleRate
  }
}

/**
 * A compiled, reusable filter chain.
 *
 * Construct once when the owner changes the settings, then call
 * `process(left, right, length)` per block. State (biquad memory, delay lines,
 * LFO phase) lives in the chain and persists across blocks, which is what
 * makes a sweep continuous instead of restarting every 26 ms.
 *
 * `update()` re-reads a payload *in place*: the filters that are still active
 * keep their state, so moving one EQ fader does not reset the reverb tail. A
 * filter that newly engages is built and appended in priority order; one that
 * goes neutral is reset and dropped.
 */
export class FilterChain {
  #filters = []
  #stream = null
  #sampleRate
  #payload = {}

  constructor(payload = {}, { sampleRate = SAMPLE_RATE } = {}) {
    this.#sampleRate = sampleRate
    this.#payload = payload ?? {}
    const compiled = compile(this.#payload, { sampleRate })
    this.compiled = compiled
    this.#filters = compiled.chain
    this.#stream = compiled.chain.find((filter) => filter.stream) ?? null
  }

  get sampleRate() {
    return this.#sampleRate
  }

  get active() {
    return this.compiled.active
  }

  get empty() {
    return this.#filters.length === 0
  }

  /** What the caller must do before encoding, when anything is stream-level. */
  get streamRequest() {
    if (!this.#stream) return null
    return { speed: this.#stream.speed, pitch: this.#stream.pitch, rate: this.#stream.rate }
  }

  /**
   * Re-read a payload without losing the state of filters that stay engaged.
   *
   * A chain rebuilt from scratch on every fader move would flush the delay
   * lines, and a reverb tail cut off mid-move is far more noticeable than the
   * move itself.
   */
  update(payload = {}) {
    this.#payload = payload ?? {}
    const compiled = compile(this.#payload, { sampleRate: this.#sampleRate })
    const wanted = new Map(compiled.chain.map((filter) => [filter.name, filter]))
    const next = []

    for (const name of compiled.active) {
      const existing = this.#filters.find((filter) => filter.name === name)
      if (!existing) {
        next.push(wanted.get(name))
        continue
      }
      // A live filter re-reads its own slice of the payload so its own
      // `update` can decide what changed; a stand-in instance built by
      // `compile` would be thrown away, and with it the delay lines.
      existing.update?.(this.#payload[existing.payloadKey] ?? {})
      next.push(existing)
    }
    for (const filter of this.#filters) {
      if (!next.includes(filter)) filter.reset?.()
    }

    this.#filters = next
    this.compiled = { ...compiled, chain: next }
    this.#stream = next.find((filter) => filter.stream) ?? null
    return this
  }

  /**
   * Process one block in place.
   *
   * `left` and `right` may be the same array (mono material); filters that need
   * two channels still see two, because a pan on identical channels is silence.
   */
  process(left, right = left, length = left.length) {
    for (const filter of this.#filters) {
      if (filter.stream) continue
      filter.process(left, right, length)
    }
    return { left, right }
  }

  /**
   * Any tail the chain is still holding, as one block.
   *
   * Called at a segment boundary when the filters are about to be replaced:
   * the reverb's tail and the echo's last repeat belong to the audio that
   * produced them, and dropping them is an audible cut.
   */
  flush() {
    const tails = []
    for (const filter of this.#filters) {
      const tail = filter.flush?.()
      if (tail && tail.length > 0) tails.push(tail)
    }
    return tails
  }

  reset() {
    for (const filter of this.#filters) filter.reset?.()
  }

  destroy() {
    for (const filter of this.#filters) filter.destroy?.()
    this.#filters = []
    this.compiled = { active: [], chain: [], skipped: [], unknown: [], clamped: [], sampleRate: this.#sampleRate }
  }
}

/**
 * Render a whole segment through the chain.
 *
 * Timescale is the reason this exists as a segment-level function: it needs
 * more audio than one block to do anything musical, and it changes the length
 * of its output, which a per-block chain cannot express. Everything else runs
 * block-agnostically, so a segment is simply a chain of blocks. The stretch is
 * *not* applied here — the caller owns that (see `renderWithStretch`), so this
 * module stays pure DSP.
 *
 * @param {{left: Float32Array, right: Float32Array}} audio
 * @param {object} payload
 * @returns {{left: Float32Array, right: Float32Array, length: number, chain: string[]}}
 */
export function render(audio, payload = {}, { sampleRate = SAMPLE_RATE } = {}) {
  const chain = new FilterChain(payload, { sampleRate })
  let { left, right } = audio
  const length = Math.min(left.length, right.length)
  left = Float32Array.from(left.subarray(0, length))
  right = Float32Array.from(right.subarray(0, length))

  chain.process(left, right, length)
  return { left, right, length, chain: chain.active, stream: chain.streamRequest }
}

/** @deprecated Kept so an old import keeps working; use `FILTER_ORDER`. */
export const ORDER = FILTER_ORDER
export { FILTER_NAMES }
