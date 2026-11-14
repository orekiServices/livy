/**
 * Livy logger.
 *
 * Dependency-free, but it does the things a radio node actually needs:
 *
 *   • levels          trace · debug · info · warn · error · fatal
 *   • scopes          every subsystem logs under its own name, aligned
 *   • debug switches  per-category toggles (`logging.debug.sources = true`)
 *                     so you can turn on just the noise you care about
 *   • fields          log('message', { station, ms }) → `station=lofi ms=812`
 *   • timers          const done = log.timer('render'); done() → duration
 *   • ring buffer     the last N lines are kept in memory and served to the
 *                     owner console, so "what happened?" needs no ssh
 *   • file sink       optional JSON-lines file with size-based rotation
 *   • redaction       owner keys, tokens and client_ids never reach a sink
 *
 * Everything is opt-in through `config.logging`; the defaults are quiet and
 * colourful on a TTY, plain and parseable when piped.
 */
import fs from 'node:fs'
import path from 'node:path'

export const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: 99 }

const LABEL = { trace: 'TRACE', debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR', fatal: 'FATAL' }

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  grey: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m'
}

const LEVEL_COLOR = {
  trace: C.grey,
  debug: C.cyan,
  info: C.green,
  warn: C.yellow,
  error: C.red,
  fatal: C.bgRed + C.bold
}

/** Scope colours are stable per name, so your eye learns them. */
const SCOPE_COLORS = [C.cyan, C.magenta, C.blue, C.green, C.yellow, C.white]
const scopeColor = (scope) => {
  let hash = 0
  for (let i = 0; i < scope.length; i += 1) hash = (hash * 31 + scope.charCodeAt(i)) >>> 0
  return SCOPE_COLORS[hash % SCOPE_COLORS.length]
}

/* --------------------------------------------------------------------- *
 * State
 * --------------------------------------------------------------------- */

const state = {
  level: LEVELS.info,
  color: process.stdout.isTTY === true && !process.env.NO_COLOR,
  timestamps: true,
  categories: new Map(), // category → level override (debug switches)
  scopeWidth: 12,
  buffer: [],
  bufferSize: 400,
  file: null, // { path, stream, bytes, maxBytes, keep }
  listeners: new Set()
}

/** Secrets that must never reach a log sink, however they were passed in. */
const REDACT = [
  /(x-owner-key|owner[_-]?key|authorization|bearer)(["' :=]+)([^\s"',}]+)/gi,
  /(client_id|clientId|api[_-]?key|token|password)(["' :=]+)([^\s"',}&]+)/gi
]

const redact = (text) => REDACT.reduce((acc, re) => acc.replace(re, (_, k, sep) => `${k}${sep}***`), text)

/** Field *names* that are secrets whatever their value looks like. */
const SECRET_KEY = /^(key|ownerkey|owner_key|token|password|secret|client_?id|api_?key|authorization)$/i

const redactFields = (fields) => {
  const out = {}
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY.test(key)) out[key] = '***'
    else if (typeof value === 'string') out[key] = redact(value)
    else out[key] = value
  }
  return out
}

/* --------------------------------------------------------------------- *
 * Configuration
 * --------------------------------------------------------------------- */

export function setLogLevel(level) {
  state.level = typeof level === 'number' ? level : (LEVELS[String(level).toLowerCase()] ?? LEVELS.info)
}

export function setLogColor(enabled) {
  state.color = Boolean(enabled) && process.stdout.isTTY === true && !process.env.NO_COLOR
}

/**
 * Apply a `logging` config block.
 *
 * ```jsonc
 * "logging": {
 *   "level": "info",
 *   "color": true,
 *   "timestamps": true,
 *   "buffer": 400,
 *   "debug": { "sources": true, "automix": true, "http": false },
 *   "file": { "enabled": true, "path": "data/livy.log", "maxMb": 8, "keep": 3 }
 * }
 * ```
 *
 * A category is matched against the *start* of a scope, so `sources` covers
 * `src:soundcloud`… via its alias table below, and `station` covers
 * `station:lofi`.
 */
export function configureLogging(logging: any = {}) {
  if (logging.level !== undefined) setLogLevel(logging.level)
  if (logging.color !== undefined) setLogColor(logging.color)
  if (logging.timestamps !== undefined) state.timestamps = Boolean(logging.timestamps)
  if (logging.buffer !== undefined) state.bufferSize = Math.max(0, Number(logging.buffer) || 0)

  // The ring buffer survives reconfiguration on purpose: raising the level
  // must not erase the lines that explain why you raised it.
  state.categories.clear()
  for (const [name, value] of Object.entries(logging.debug ?? {})) {
    if (value === false || value === 'off') state.categories.set(name, LEVELS.info)
    else if (value === true || value === 'on' || value === 'debug') state.categories.set(name, LEVELS.debug)
    else if (value === 'trace') state.categories.set(name, LEVELS.trace)
    else if (typeof value === 'string' && LEVELS[value]) state.categories.set(name, LEVELS[value])
  }

  closeFile()
  const file = logging.file
  if (file?.enabled && file.path) openFile(file.path, { maxMb: file.maxMb ?? 8, keep: file.keep ?? 3 })

  return { level: state.level, color: state.color, categories: [...state.categories.keys()], file: state.file?.path ?? null }
}

/** Categories are coarse; scopes are fine. This maps one to the other. */
const CATEGORY_OF = (scope) => {
  if (scope.startsWith('src:')) return 'sources'
  if (scope.startsWith('station:')) return 'station'
  if (scope.startsWith('automix')) return 'automix'
  if (scope.startsWith('plugin:')) return 'plugins'
  return scope.split(':')[0]
}

const threshold = (scope) => {
  const category = CATEGORY_OF(scope)
  const override = state.categories.get(category) ?? state.categories.get(scope)
  if (override === undefined) return state.level
  return Math.min(override, state.level)
}

/* --------------------------------------------------------------------- *
 * Sinks
 * --------------------------------------------------------------------- */

/**
 * The file sink writes with a plain appended fd rather than a stream: a log
 * line that describes a crash has to be on disk *before* the crash, and
 * rotation has to be deterministic. Volume is low (one line per event), so
 * the synchronous write costs nothing measurable.
 */
function openFile(file, { maxMb, keep }) {
  try {
    const resolved = path.resolve(file)
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    state.file = {
      path: resolved,
      fd: fs.openSync(resolved, 'a'),
      bytes: fs.existsSync(resolved) ? fs.statSync(resolved).size : 0,
      maxBytes: Math.max(4096, (Number(maxMb) || 8) * 1024 * 1024),
      keep: Math.max(0, keep)
    }
  } catch {
    state.file = null // a log file is never worth crashing a broadcast over
  }
}

function closeFile() {
  if (state.file?.fd !== undefined) {
    try {
      fs.closeSync(state.file.fd)
    } catch {
      /* already gone */
    }
  }
  state.file = null
}

function rotate() {
  const sink = state.file
  if (!sink) return
  try {
    fs.closeSync(sink.fd)
    for (let i = sink.keep - 1; i >= 1; i -= 1) {
      const from = `${sink.path}.${i}`
      if (fs.existsSync(from)) fs.renameSync(from, `${sink.path}.${i + 1}`)
    }
    if (sink.keep > 0) fs.renameSync(sink.path, `${sink.path}.1`)
    else fs.rmSync(sink.path, { force: true })
  } catch {
    /* keep logging even if rotation fails */
  }
  sink.fd = fs.openSync(sink.path, 'a')
  sink.bytes = 0
}

/* --------------------------------------------------------------------- *
 * Formatting
 * --------------------------------------------------------------------- */

const pad2 = (n) => String(n).padStart(2, '0')
const pad3 = (n) => String(n).padStart(3, '0')

function stamp(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${pad3(date.getMilliseconds())}`
}

function formatValue(value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2)
  if (typeof value === 'string') return /[\s=]/.test(value) ? JSON.stringify(value) : value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatFields(fields) {
  const parts = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    parts.push(`${key}=${formatValue(value)}`)
  }
  return parts.join(' ')
}

function errorDetail(error) {
  const lines = [String(error.stack ?? `${error.name}: ${error.message}`)]
  let cause = error.cause
  let guard = 0
  while (cause && guard < 3) {
    lines.push(`caused by: ${cause.stack ?? cause.message ?? cause}`)
    cause = cause.cause
    guard += 1
  }
  return lines.join('\n')
}

/** Split the call arguments into a message, structured fields and an error. */
function normalise(args) {
  let message = ''
  let error = null
  const fields = {}

  for (const arg of args) {
    if (arg instanceof Error) {
      error = arg
      message = message || arg.message
    } else if (typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean') {
      message = message ? `${message} ${arg}` : String(arg)
    } else if (arg && typeof arg === 'object') {
      Object.assign(fields, arg)
    }
  }

  return { message, fields, error }
}

/* --------------------------------------------------------------------- *
 * Emit
 * --------------------------------------------------------------------- */

function emit(level, scope, args, bound) {
  if (LEVELS[level] < threshold(scope)) return

  const { message, fields, error } = normalise(args)
  const all = redactFields({ ...bound, ...fields })
  const record = {
    t: Date.now(),
    level,
    scope,
    msg: redact(message),
    ...(Object.keys(all).length ? { fields: all } : {}),
    ...(error ? { err: redact(errorDetail(error)) } : {})
  }

  // ring buffer (owner console / tests)
  if (state.bufferSize > 0) {
    state.buffer.push(record)
    if (state.buffer.length > state.bufferSize) state.buffer.splice(0, state.buffer.length - state.bufferSize)
  }
  for (const listener of state.listeners as Set<(record: any) => void>) {
    try {
      listener(record)
    } catch {
      /* a broken listener must not break logging */
    }
  }

  // console
  const time = state.timestamps ? stamp(new Date(record.t)) : ''
  const label = LABEL[level]
  const width = (state.scopeWidth = Math.max(state.scopeWidth, scope.length))
  const fieldText = Object.keys(all).length ? redact(formatFields(all)) : ''

  let line
  if (state.color) {
    line =
      `${C.grey}${time}${C.reset} ` +
      `${LEVEL_COLOR[level]}${label.padEnd(5)}${C.reset} ` +
      `${scopeColor(scope)}${scope.padEnd(width)}${C.reset} ` +
      `${C.grey}│${C.reset} ${record.msg}` +
      (fieldText ? ` ${C.grey}${fieldText}${C.reset}` : '')
  } else {
    line = `${time} ${label.padEnd(5)} ${scope.padEnd(width)} | ${record.msg}${fieldText ? ` ${fieldText}` : ''}`
  }
  if (record.err && LEVELS[level] >= LEVELS.warn) {
    line += `\n${state.color ? C.grey : ''}${record.err.split('\n').map((l) => `    ${l}`).join('\n')}${state.color ? C.reset : ''}`
  }

  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout
  stream.write(`${line}\n`)

  // file (JSON lines — grep-able, ingestible)
  const sink = state.file
  if (sink) {
    const json = `${JSON.stringify(record)}\n`
    try {
      fs.writeSync(sink.fd, json)
      sink.bytes += Buffer.byteLength(json)
      if (sink.bytes >= sink.maxBytes) rotate()
    } catch {
      closeFile() // disk full / file removed: drop the sink, keep broadcasting
    }
  }
}

/* --------------------------------------------------------------------- *
 * Public API
 * --------------------------------------------------------------------- */

export function createLogger(scope = 'livy', bound: any = {}) {
  const at = (level) => (...args) => emit(level, scope, args, bound)

  return {
    scope,
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),

    /** `log.child('soundcloud')` → scope `sources:soundcloud`. */
    child: (sub, fields: any = {}) => createLogger(`${scope}:${sub}`, { ...bound, ...fields }),

    /** `log.with({ station: 'lofi' })` → every line carries station=lofi. */
    with: (fields) => createLogger(scope, { ...bound, ...fields }),

    /** Is this category currently verbose? Lets callers skip expensive work. */
    enabled: (level = 'debug') => LEVELS[level] >= threshold(scope),

    /**
     * const done = log.timer('render seam')
     * … work …
     * done({ frames })      // → "render seam" ms=812 frames=430
     */
    timer(label, level = 'debug') {
      const started = process.hrtime.bigint()
      return (fields: any = {}) => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6
        emit(level, scope, [label, { ...fields, ms: Math.round(ms * 100) / 100 }], bound)
        return ms
      }
    }
  }
}

/** Last N records, newest last. Used by `/api/v1/owner/logs`. */
export function tail(limit = 100, { level, scope }: any = {}) {
  let rows = state.buffer
  if (level) rows = rows.filter((r) => LEVELS[r.level] >= (LEVELS[level] ?? 0))
  if (scope) rows = rows.filter((r) => r.scope.startsWith(scope))
  return rows.slice(-limit)
}

/** Subscribe to every record (the gateway streams these to the console). */
export function onLog(listener) {
  state.listeners.add(listener)
  return () => state.listeners.delete(listener)
}

export function loggingState() {
  return {
    level: Object.keys(LEVELS).find((k) => LEVELS[k] === state.level) ?? state.level,
    color: state.color,
    categories: Object.fromEntries([...state.categories].map(([k, v]) => [k, Object.keys(LEVELS).find((n) => LEVELS[n] === v)])),
    buffered: state.buffer.length,
    file: state.file?.path ?? null
  }
}

/** Test/shutdown helper: drop the file sink and forget buffered lines. */
export function resetLogging() {
  closeFile()
  state.buffer = []
  state.listeners.clear()
  state.categories.clear()
  state.level = LEVELS.info
}

/**
 * The line every node should print once: who I am, what I run on, where my
 * data lives. Deliberately compact — one block, no ASCII art beyond a rule.
 */
export function banner({ version, port, host, stations, store, plugins, engine, fx, device, node = process.version, pid = process.pid }: any = {}) {
  // The banner is an info-level courtesy: a node asked to be quiet stays quiet
  // (and a test runner's stdout stays clean).
  if (state.level > LEVELS.info) return
  const c = (code, text) => (state.color ? `${code}${text}${C.reset}` : text)
  const rule = '─'.repeat(58)
  const rows = [
    ['version', `livy ${version}`],
    ['runtime', `${typeof globalThis.Bun !== 'undefined' ? `bun ${globalThis.Bun.version}` : `node ${node}`} · pid ${pid} · ${process.platform}/${process.arch}`],
    ['listening', `http://${host}:${port}`],
    ['stations', String(stations)],
    ['store', store ?? 'disabled'],
    ['plugins', plugins ?? 'none'],
    // Which relay engine is loaded — native libmetro, or the JS fallback.
    ...(engine ? [['engine', engine]] : []),
    ...(fx ? [['filters', fx]] : []),
    // Only worth a row when it is not the default: a phone is a different
    // training budget and a different store backend.
    ...(device ? [['device', device]] : [])
  ]
  const out = [
    c(C.grey, rule),
    `${c(C.bold + C.magenta, '  Livy')} ${c(C.grey, '· Bun + ICEcast · multi-station MP3 radio')}`,
    c(C.grey, rule),
    ...rows.map(([k, v]) => `  ${c(C.grey, k.padEnd(10))} ${v}`),
    c(C.grey, rule)
  ]
  process.stdout.write(`${out.join('\n')}\n`)
}

export default createLogger
