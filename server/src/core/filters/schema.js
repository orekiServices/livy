/**
 * The schema layer — defaults, neutral values, validation.
 *
 * The ranges live in each filter's static `schema` (next to the code that has
 * to honour them), and this module turns them into the three things the rest
 * of the server asks for: a filter's defaults, the neutral settings for a
 * station that has never touched anything, and a validated payload.
 *
 * Keeping validation here rather than in each filter is deliberate: an owner
 * typing `{ "reverb": { "mix": 9 } }` should get a clamp and a note, not a
 * reverb so wet it is 90 % tail. The filter's job is to run; this layer's job
 * is to keep the filter inside its range.
 */
import { FILTER_NAMES, schemaFor } from './registry.js'
import { clamp, EQ_BANDS, neutralValue } from './constants.js'

/** Every filter's schema, by name. Recomputed rarely; frozen so it cannot be. */
export const FILTER_SCHEMA = Object.freeze(
  Object.fromEntries(FILTER_NAMES.map((name) => [name, schemaFor(name)]))
)

/** A filter switched on with no parameters: the documented defaults. */
export function defaultsFor(name) {
  const spec = FILTER_SCHEMA[name]
  if (!spec) return {}
  const out = {}
  // `default` is "on with no parameters" — NodeLink's documented value, which
  // for karaoke and the compressor is not the neutral one.
  for (const [key, entry] of Object.entries(spec)) {
    out[key] = entry?.default !== undefined ? entry.default : neutralValue(entry)
  }
  return out
}

/**
 * Neutral settings: every filter present, with values that change nothing.
 *
 * The phonograph is the one exception. Its documented defaults are a record
 * player (wow, crackle, a little drive), which is right for "*on* with no
 * parameters" and wrong for "never configured" — a station that has never
 * touched the filter must not sound like a 78.
 */
export function neutralSettings() {
  const out = {}
  for (const [name, spec] of Object.entries(FILTER_SCHEMA)) {
    out[name] = {}
    for (const [key, entry] of Object.entries(spec)) out[name][key] = neutralValue(entry)
  }
  out.phonograph = { frequency: 0, depth: 0, crackle: 0, flutter: 0, room: 0, micAgc: 0, drive: 0 }
  return out
}

/**
 * Is this configuration actually doing something?
 *
 * A station's chain is rebuilt from JSON on every change and half of it is
 * neutral; running 20 no-op biquads over 44 100 samples a second is exactly
 * how a "free" feature starts costing CPU. Each filter answers for itself.
 */
export function isActive(name, config = {}) {
  if (!config) return false
  switch (name) {
    case 'timescale':
      return (
        Math.abs((config.speed ?? 1) - 1) > 1e-4 ||
        Math.abs((config.pitch ?? 1) - 1) > 1e-4 ||
        Math.abs((config.rate ?? 1) - 1) > 1e-4
      )
    case 'equalizer':
      return (config.bands ?? []).some((band) => Math.abs(band.gain ?? 0) > 1e-3)
    case 'equalizerStandalone':
      // `gain` is an offset from flat, as in NodeLink.
      return Math.abs(config.gain ?? 0) > 1e-3
    case 'karaoke':
      return (config.level ?? 0) > 0 || (config.monoLevel ?? 0) > 0
    case 'channelMix':
      return (
        Math.abs((config.leftToLeft ?? 1) - 1) > 1e-3 ||
        Math.abs(config.leftToRight ?? 0) > 1e-3 ||
        Math.abs(config.rightToLeft ?? 0) > 1e-3 ||
        Math.abs((config.rightToRight ?? 1) - 1) > 1e-3
      )
    case 'compressor':
      return (config.threshold ?? 1) < 0.999 && (config.ratio ?? 1) > 1
    case 'lowpass':
      return (config.cutoff ?? 20_000) < 19_900 || (config.smoothing ?? 1) > 1.001
    case 'highpass':
      return (config.cutoff ?? 10) > 11 || (config.smoothing ?? 0) > 0.001
    case 'rotation':
    case 'tesseract':
      return (config.rotationHz ?? 0) > 0.001
    case 'spatial':
      return (config.x ?? 0) !== 0 || (config.y ?? 0) !== 0 || (config.z ?? 0) !== 0 || (config.depth ?? 0) > 0
    case 'tremolo':
    case 'vibrato':
      return (config.frequency ?? 0) > 0.001 && (config.depth ?? 0) > 0.001
    case 'chorus':
    case 'phaser':
    case 'flanger':
      return (config.mix ?? 0) > 0.001
    case 'echo':
      return (config.mix ?? 0) > 0.001 && (config.delay ?? 0) > 0.001
    case 'reverb':
      return (config.mix ?? 0) > 0.001 || (config.wetLevel ?? 0) > 0.001
    case 'distortion':
      return ['offset', 'sinOffset', 'cosOffset', 'tanOffset'].some((key) => (config[key] ?? 0) !== 0) ||
        ['scale', 'sinScale', 'cosScale', 'tanScale'].some((key) => Math.abs((config[key] ?? 1) - 1) > 1e-3)
    case 'phonograph':
      return ['crackle', 'flutter', 'room', 'micAgc', 'drive', 'depth'].some((key) => (config[key] ?? 0) > 0.001)
    default:
      return false
  }
}

/**
 * Validate a payload and return settings that are safe to run.
 *
 * Unknown filters are reported rather than silently dropped — a typo in a
 * console request should be an error the owner can see, not a filter that
 * quietly never engages. Values are clamped to the schema, not rejected: a
 * volume knob at 11 is a 10, which is what the person turning it meant.
 *
 * `transition`, `alpha` and `_disabled` are accepted and *kept* — they are the
 * animation hints `AnimatableFilter` reads, and dropping them here is how a
 * console's smooth ramp silently becomes a click.
 *
 * @returns {{settings: object, unknown: string[], clamped: string[]}}
 */
export function validate(payload = {}) {
  const unknown = []
  const clamped = []
  const settings = {}
  const neutral = neutralSettings()

  for (const [name, config] of Object.entries(payload ?? {})) {
    if (!FILTER_SCHEMA[name]) {
      unknown.push(name)
      continue
    }
    if (config === false || config === null) {
      settings[name] = null // explicit "off"
      continue
    }
    if (config === true) {
      settings[name] = defaultsFor(name) // "on" with no parameters
      continue
    }
    if (typeof config !== 'object') {
      unknown.push(name)
      continue
    }

    const spec = FILTER_SCHEMA[name]
    const clean = {}
    for (const [key, value] of Object.entries(config)) {
      if (key === 'transition' || key === 'alpha' || key === '_disabled') {
        clean[key] = value
        continue
      }
      const entry = spec[key]
      if (!entry) {
        unknown.push(`${name}.${key}`)
        continue
      }
      if (entry.array) {
        // A plain list of numbers, NodeLink style: reverb's custom `delays`
        // and `gains`. Clipped to the entry's range and short enough that a
        // hostile payload cannot ask for a thousand combs.
        if (!Array.isArray(value)) {
          unknown.push(`${name}.${key}`)
          continue
        }
        const limit = entry.maxLength ?? 16
        const low = entry.range?.[0] ?? 0
        const high = entry.range?.[1] ?? Number.POSITIVE_INFINITY
        const numbers = value.slice(0, limit).map((item) => Number(item)).filter((item) => Number.isFinite(item))
        clean[key] = numbers.map((item) => clamp(item, low, high))
        if (clean[key].length !== value.length || clean[key].some((item, index) => item !== Number(value[index]))) {
          clamped.push(`${name}.${key}`)
        }
        continue
      }
      if (entry.list) {
        if (!Array.isArray(value)) {
          unknown.push(`${name}.${key}`)
          continue
        }
        clean[key] = value
          .filter((item) => item && typeof item === 'object')
          .map((item) => {
            const band = clamp(Math.round(Number(item.band) || 0), 0, EQ_BANDS.length - 1)
            const gain = clamp(Number(item.gain ?? 1) || 0, entry.list.gain.range[0], entry.list.gain.range[1])
            if (band !== Number(item.band) || gain !== Number(item.gain)) clamped.push(`${name}.${key}`)
            return { band, gain }
          })
        continue
      }
      if (entry.integer) {
        const rounded = Math.round(Number(value))
        if (!Number.isFinite(rounded)) {
          unknown.push(`${name}.${key}`)
          continue
        }
        clean[key] = clamp(rounded, entry.range[0], entry.range[1])
        if (clean[key] !== Number(value)) clamped.push(`${name}.${key}`)
        continue
      }
      const number = Number(value)
      if (!Number.isFinite(number)) {
        unknown.push(`${name}.${key}`)
        continue
      }
      clean[key] = clamp(number, entry.range[0], entry.range[1])
      if (clean[key] !== number) clamped.push(`${name}.${key}`)
    }
    settings[name] = { ...neutral[name], ...clean }
  }

  return { settings, unknown, clamped }
}

export default { FILTER_SCHEMA, defaultsFor, isActive, neutralSettings, neutralValue, validate }
