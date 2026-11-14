import { BaseFilter } from './BaseFilter.ts'
import { neutralValue as neutralValueOf } from './constants.ts'

/**
 * A filter whose settings can *ramp* instead of jumping.
 *
 * Toggling an echo on at full wet against a quiet vocal is a click; ramping it
 * over 400 ms is a musical entrance. NodeLink solves this with a
 * `transition: { durationMs, curve }` on each filter's settings, and this is
 * that mechanism, with the same three curves and the same default
 * (`sinusoidal`, because a linear ramp of a *gain* is audible as a corner
 * while a sine-squared ramp is not).
 *
 * The animation advances by the duration of the block being processed rather
 * than by wall-clock time, so a 250 ms block moves a 400 ms transition 250 ms
 * even when the encoder is running behind.
 */
export const ANIMATION_CURVES = ['linear', 'exponential', 'sinusoidal']

/** How far along a transition is, shaped by its curve. `t` is 0…1. */
export function curveValue(t, curve = 'sinusoidal') {
  switch (curve) {
    case 'linear':
      return t
    case 'exponential':
      return t * t
    case 'sinusoidal':
    default:
      return (1 - Math.cos(t * Math.PI)) / 2
  }
}

export class AnimatableFilter extends BaseFilter {
  declare name: any

  /** Live values: the start (or end) of the last transition. */
  config = {}

  /** Where the current transition is heading. */
  #target = {}

  /** The transition in flight, if any. */
  #animation = null

  #start = {}

  /**
   * Re-read a payload using this class's own schema.
   *
   * Subclasses that need to coerce a value override this and call
   * `applyAnimatedUpdate` themselves; `super.update()` from one of those is a
   * no-op on `BaseFilter`, which is a silent way to lose every setting.
   */
  update(settings: any = {}) {
    const schema = (this.constructor as any).schema
    if (!schema) return this
    this.applyAnimatedUpdate(settings, schema)
    return this
  }

  /**
   * Read this filter's settings and begin a transition, or snap instantly.
   *
   * @param {object} settings     the whole filter payload
   * @param {object} defaults     every key this filter understands, with its neutral value
   *                              (a schema entry or a plain value: both work)
   * @param {object} [options]
   * @param {string} [options.key] settings key, when it differs from `name`
   * @param {(key: string, value: number) => number} [options.coerce]
   */
  applyAnimatedUpdate(settings, defaults, { key = this.name, coerce }: any = {}) {
    // Filters are given their own slice of the payload by the chain, but a
    // direct `filter.update(wholePayload)` — from a plugin, a test, or the
    // console's live preview — passes the whole thing. Accept both rather than
    // silently reading defaults because the shape was one level off.
    const wrapped = settings?.[key]
    const raw = wrapped && typeof wrapped === 'object' ? wrapped : (settings ?? {})
    const next = {}
    let changed = false

    for (const [setting, spec] of Object.entries(defaults)) {
      // `defaults` may be a schema (`{ depth: { range, default } }`) or plain
      // values (`{ depth: 0.5 }`); both are accepted because a filter that
      // overrides `update()` by hand should not have to build one shape.
      const fallback = spec && typeof spec === 'object' && 'range' in spec ? neutralValueOf(spec) : spec
      const candidate = raw[setting]
      const isArray = Array.isArray(fallback)
      let value
      if (isArray) {
        // Plain number arrays (reverb's custom delays/gains) are carried
        // through as a copy; they step, they do not ramp.
        value = Array.isArray(candidate)
          ? candidate.map((item) => Number(item)).filter((item) => Number.isFinite(item))
          : (this.config[setting] ?? fallback)
      } else if (typeof candidate === 'number' && Number.isFinite(candidate)) value = candidate
      else if (this.config[setting] !== undefined) value = this.config[setting]
      else value = fallback

      if (coerce) value = coerce(setting, value)
      next[setting] = isArray ? [...value] : value
      // A filter that has never run starts from its *neutral* value, so a
      // transition on a freshly-built filter fades in from silence rather than
      // snapping to the target and then animating nothing.
      if (this.config[setting] === undefined) this.config[setting] = isArray ? [...fallback] : fallback
      if (isArray ? JSON.stringify(value) !== JSON.stringify(this.config[setting]) : value !== this.config[setting]) {
        changed = true
      }
    }

    const transition = raw.transition ?? settings?.transition
    const duration = Number(transition?.durationMs)
    const wanted =
      typeof transition === 'object' && transition !== null && Number.isFinite(duration) && duration > 0
    const curve = ANIMATION_CURVES.includes(transition?.curve) ? transition.curve : 'sinusoidal'

    // A disabled filter fades to its neutral state rather than to whatever it
    // was asked for, so switching one off during a mix is also a ramp.
    if (raw._disabled === true) {
      for (const [setting, spec] of Object.entries(defaults)) {
        next[setting] = spec && typeof spec === 'object' && 'range' in spec ? neutralValueOf(spec) : spec
      }
    }

    if (!wanted || !changed) {
      this.config = next
      this.#target = { ...next }
      this.#animation = null
      this.onConfigChanged(this.config)
      return this
    }

    this.#start = { ...this.config }
    this.#target = next
    this.#animation = { elapsedMs: 0, durationMs: duration, curve }
    return this
  }

  /**
   * Advance the transition by one block and refresh `config`.
   * Called by the subclass at the top of `process()`.
   *
   * `length` is per-channel sample frames (matching `process(left, right, length)`),
   * so `channels` defaults to 1; pass `channels: 2` only for interleaved counts.
   */
  processAnimation(length, { sampleRate = 44_100, channels = 1 }: any = {}) {
    if (!this.#animation) return this.config

    const frames = length / channels
    const blockMs = (frames / sampleRate) * 1000
    this.#animation.elapsedMs += blockMs

    if (this.#animation.elapsedMs >= this.#animation.durationMs) {
      this.config = { ...this.#target }
      this.#animation = null
      this.onConfigChanged(this.config)
      return this.config
    }

    const t = curveValue(this.#animation.elapsedMs / this.#animation.durationMs, this.#animation.curve)
    for (const [setting, target] of Object.entries(this.#target)) {
      // Arrays (reverb's custom delays/gains) and the animation hints step
      // rather than ramp; arithmetic on them would produce NaN.
      if (typeof target !== 'number') {
        this.config[setting] = target
        continue
      }
      const start = this.#start[setting] ?? 0
      this.config[setting] = start + (target - start) * t
    }
    this.onConfigChanged(this.config)
    return this.config
  }

  /** Is a transition still running? */
  get animating() {
    return this.#animation !== null
  }

  /** Milliseconds left in the current transition, 0 when idle. */
  get remainingMs() {
    if (!this.#animation) return 0
    return Math.max(0, this.#animation.durationMs - this.#animation.elapsedMs)
  }

  /**
   * A filter that is mid-transition is still active even when its target is
   * neutral: killing it halfway through a fade-out would leave a step.
   */
  isActive() {
    return this.animating || this.active()
  }

  /** Subclasses answer this: does `config` describe an audible effect? */
  active() {
    return true
  }

  onConfigChanged(_config?: any) {}
}

export default AnimatableFilter
