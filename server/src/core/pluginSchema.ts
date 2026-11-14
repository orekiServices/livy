/**
 * Plugin settings, described well enough to be edited by a stranger.
 *
 * A plugin's settings used to be "whatever object the manifest happened to
 * contain": no types, no ranges, no help text, and a console could do
 * nothing better than show raw JSON. That is fine for the person who wrote
 * the plugin and hostile to everybody else — and it meant a typo in a
 * PATCH (`"everyMinutes": "thirty"`) survived all the way to the code that
 * eventually divided by it.
 *
 * So a plugin can now declare a **schema**: a list of fields with a type, a
 * default, a label, help text and whatever constraints apply. From that one
 * declaration the node gets
 *
 *   • validation and coercion of everything the owner sends,
 *   • defaults that do not have to be repeated in the plugin's code,
 *   • per-station overrides that are checked the same way,
 *   • and a machine-readable description the console renders as a form.
 *
 * The schema is deliberately small: nine field types, no `$ref`, no nested
 * objects, no code. Anything more complicated is a sign the plugin wants a
 * route, not a settings box.
 *
 * ```js
 * export const manifest = {
 *   settingsSchema: [
 *     { key: 'everyMinutes', type: 'integer', default: 30, min: 5, max: 240,
 *       label: 'How often', help: 'Minutes between bulletins', unit: 'min' },
 *     { key: 'feeds', type: 'list', of: 'url', default: [], label: 'RSS feeds' },
 *     { key: 'language', type: 'language', default: 'vi' }
 *   ]
 * }
 * ```
 */

/** Everything a field can be. Anything else is rejected at load time. */
export const FIELD_TYPES = ['string', 'text', 'number', 'integer', 'boolean', 'select', 'list', 'time', 'url', 'language', 'timezone']

const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * Read a schema as a plugin author wrote it.
 *
 * Both shapes are accepted, because both are natural to write:
 *   `[{ key: 'x', type: 'integer' }, …]`   — an ordered list (preferred: the
 *                                            order is the form's order)
 *   `{ x: { type: 'integer' }, … }`        — a map
 */
export function normaliseSchema(schema) {
  if (!schema) return []

  const entries = Array.isArray(schema)
    ? schema.map((field) => [field.key, field])
    : Object.entries(schema as Record<string, any>).map(([key, field]) => [key, { ...(field as Record<string, any>), key }])

  const fields = []
  for (const [key, field] of entries) {
    if (!key || !isPlainObject(field)) continue
    const type = FIELD_TYPES.includes(field.type) ? field.type : 'string'

    fields.push({
      key: String(key),
      type,
      label: field.label ?? sentence(key),
      help: field.help ?? null,
      // `advanced` fields are real settings a console may fold away.
      advanced: field.advanced === true,
      // Can a single station override this, or is it node-wide?
      perStation: field.perStation !== false,
      secret: field.secret === true,
      default: field.default,
      ...(type === 'select' ? { options: readOptions(field.options) } : {}),
      ...(type === 'list' ? { of: FIELD_TYPES.includes(field.of) ? field.of : 'string', max: numberOr(field.max, 100) } : {}),
      ...(type === 'number' || type === 'integer'
        ? { min: numberOr(field.min, null), max: numberOr(field.max, null), step: numberOr(field.step, null), unit: field.unit ?? null }
        : {}),
      ...(type === 'string' || type === 'text' ? { maxLength: numberOr(field.maxLength, 2000), placeholder: field.placeholder ?? null } : {})
    })
  }
  return fields
}

const sentence = (key) =>
  String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/^./, (character) => character.toUpperCase())

const numberOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)

const readOptions = (options) =>
  (Array.isArray(options) ? options : []).map((option) =>
    isPlainObject(option) ? { value: option.value, label: option.label ?? sentence(option.value) } : { value: option, label: sentence(option) }
  )

/** The settings a plugin starts life with. */
export function defaultsOf(fields): Record<string, any> {
  const out: Record<string, any> = {}
  for (const field of fields) {
    if (field.default !== undefined) out[field.key] = structuredClone(field.default)
    else if (field.type === 'boolean') out[field.key] = false
    else if (field.type === 'list') out[field.key] = []
  }
  return out
}

/* ------------------------------ coercion ------------------------------ */

function coerceOne(field, raw) {
  switch (field.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw }
      if (raw === 'true' || raw === 1 || raw === '1') return { value: true }
      if (raw === 'false' || raw === 0 || raw === '0') return { value: false }
      return { error: 'must be true or false' }
    }

    case 'number':
    case 'integer': {
      const number = Number(raw)
      if (!Number.isFinite(number)) return { error: 'must be a number' }
      const rounded = field.type === 'integer' ? Math.round(number) : number
      if (field.min != null && rounded < field.min) return { error: `must be at least ${field.min}` }
      if (field.max != null && rounded > field.max) return { error: `must be at most ${field.max}` }
      return { value: rounded }
    }

    case 'select': {
      const value = typeof raw === 'string' ? raw : String(raw ?? '')
      const allowed = field.options.map((option) => String(option.value))
      if (!allowed.includes(value)) return { error: `must be one of: ${allowed.join(', ')}` }
      return { value }
    }

    case 'list': {
      // A textarea gives one per line; an API gives an array. Both are fine.
      const items = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\n,]/)
      const inner = { ...field, type: field.of, key: field.key }
      const value = []
      for (const item of items) {
        const text = typeof item === 'string' ? item.trim() : item
        if (text === '' || text == null) continue
        const result = coerceOne(inner, text)
        if (result.error) return { error: `“${String(text).slice(0, 40)}” ${result.error}` }
        value.push(result.value)
      }
      if (value.length > field.max) return { error: `no more than ${field.max} entries` }
      return { value }
    }

    case 'time': {
      const value = String(raw ?? '').trim()
      if (!TIME.test(value)) return { error: 'must be a time like 17:00' }
      // Normalise 9:05 → 09:05 so comparisons and display agree.
      const [hour, minute] = value.split(':')
      return { value: `${hour.padStart(2, '0')}:${minute}` }
    }

    case 'url': {
      const value = String(raw ?? '').trim()
      try {
        const url = new URL(value)
        if (!['http:', 'https:'].includes(url.protocol)) return { error: 'must be an http(s) address' }
        return { value }
      } catch {
        return { error: 'must be a valid URL' }
      }
    }

    case 'language': {
      const value = String(raw ?? '').trim()
      if (!LANGUAGE.test(value)) return { error: 'must be a language tag like vi or pt-BR' }
      return { value }
    }

    case 'timezone': {
      const value = String(raw ?? '').trim()
      try {
        // The runtime's own tz database is the only authority worth asking.
        new Intl.DateTimeFormat('en', { timeZone: value })
        return { value }
      } catch {
        return { error: 'must be an IANA time zone like Asia/Ho_Chi_Minh' }
      }
    }

    case 'text':
    case 'string':
    default: {
      if (raw == null) return { error: 'must be text' }
      if (typeof raw === 'object') return { error: 'must be text' }
      const value = String(raw)
      if (value.length > field.maxLength) return { error: `must be ${field.maxLength} characters or fewer` }
      return { value }
    }
  }
}

/**
 * Check a patch against a schema.
 *
 * Nothing throws: an owner fixing one field should not be told the whole
 * request is invalid, so good fields are applied and bad ones are reported.
 * Unknown keys are kept — a plugin may read settings the schema does not
 * describe yet — but they are listed, so a console can say so.
 *
 * @returns {{ value: object, errors: Array<{field: string, message: string}>, unknown: string[] }}
 */
export function validate(fields, patch: any = {}, { partial = true }: any = {}) {
  const value: Record<string, any> = {}
  const errors = []
  const unknown = []
  const known = new Map<string, any>(fields.map((field: any) => [field.key, field]))

  for (const [key, raw] of Object.entries(patch ?? {})) {
    const field = known.get(key)
    if (!field) {
      unknown.push(key)
      value[key] = raw
      continue
    }
    // `null` means "back to the default", which is how a form clears a box.
    if (raw === null || raw === undefined) {
      if (field.default !== undefined) value[key] = structuredClone(field.default)
      continue
    }
    const result = coerceOne(field, raw)
    if (result.error) errors.push({ field: key, message: `${field.label}: ${result.error}` })
    else value[key] = result.value
  }

  if (!partial) {
    for (const field of fields) {
      if (!(field.key in value) && field.default !== undefined) value[field.key] = structuredClone(field.default)
    }
  }

  return { value, errors, unknown }
}

/**
 * Everything a settings form needs, with secrets blanked.
 *
 * A console can render this without knowing anything about the plugin: the
 * field order is the form order, `advanced` fields can fold away, and
 * `perStation: false` fields are greyed out when editing one station.
 */
export function describe(fields, settings: any = {}) {
  return fields.map((field) => ({
    ...field,
    value: field.secret ? (settings[field.key] ? '••••••' : '') : (settings[field.key] ?? field.default ?? null)
  }))
}

export default { normaliseSchema, defaultsOf, validate, describe, FIELD_TYPES }
