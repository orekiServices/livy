/**
 * MetroDB loader — SQLite for Node, in Rust.
 *
 * Picks the binary for the host triple and puts a better-sqlite3-shaped API
 * on top of it. Nothing here throws on a miss: the caller
 * (`server/src/store/index.js`) treats "no binary" as "use another driver",
 * so an unsupported platform falls back to better-sqlite3 or bun:sqlite
 * rather than failing to boot.
 *
 * What the Rust side gives us is the whole database. What this file adds is
 * the two pieces of better-sqlite3's API that are *shapes* rather than
 * behaviour:
 *
 *   • `db.transaction(fn)` — better-sqlite3 returns a wrapped function; a
 *     napi callback cannot safely re-enter the native object, so the verbs
 *     are native and the wrapper is here. Nested calls become savepoints.
 *   • statement `.run(...args)` — better-sqlite3 takes variadic parameters,
 *     the native side takes an array.
 */

const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { platform, arch, report } = require('node:process')

/** glibc or musl? `process.report` knows without shelling out to ldd. */
function linuxAbi() {
  try {
    const header = typeof report?.getReport === 'function' ? report.getReport().header : null
    if (header?.glibcVersionRuntime) return 'gnu'
    if (header) return 'musl'
  } catch {
    /* fall through */
  }
  return 'gnu'
}

function candidates() {
  const names = []
  if (platform === 'linux') {
    const abi = linuxAbi()
    const cpu = arch === 'arm' ? 'arm' : arch
    names.push(`metrodb.linux-${cpu}-${abi}`)
    if (cpu === 'arm') names.push('metrodb.linux-arm-gnueabihf')
    names.push(`metrodb.linux-${cpu}-${abi === 'gnu' ? 'musl' : 'gnu'}`)
  } else if (platform === 'darwin') {
    names.push(`metrodb.darwin-${arch}`, 'metrodb.darwin-universal')
  } else if (platform === 'win32') {
    names.push(`metrodb.win32-${arch}-msvc`)
  } else {
    names.push(`metrodb.${platform}-${arch}`)
  }
  return names
}

const failures = []

function load() {
  for (const name of candidates()) {
    const local = join(__dirname, `${name}.node`)
    if (existsSync(local)) {
      try {
        return require(local)
      } catch (error) {
        // Present but unloadable — wrong libc, truncated copy — must not
        // take the node down; try the next candidate.
        failures.push(`${name}: ${error.message.split('\n')[0]}`)
      }
    }
    try {
      return require(`@nodecast/${name.replace('metrodb.', 'metrodb-')}`)
    } catch {
      /* not installed */
    }
  }
  return null
}

const native = load()

/** A statement with better-sqlite3's variadic calling convention. */
class Statement {
  constructor(inner) {
    this.inner = inner
  }

  run(...params) {
    return this.inner.run(flatten(params))
  }

  get(...params) {
    return this.inner.get(flatten(params)) ?? undefined
  }

  all(...params) {
    return this.inner.all(flatten(params))
  }

  /** `for (const row of statement.iterate())` — materialised, but the same shape. */
  *iterate(...params) {
    yield* this.inner.all(flatten(params))
  }

  get source() {
    return this.inner.source
  }
}

/**
 * `db.prepare(…).run(1, 2)` and `db.prepare(…).run([1, 2])` both work in
 * better-sqlite3; accept either.
 *
 * `undefined` becomes NULL rather than an error. SQLite has one kind of
 * nothing, JavaScript has two, and a caller that leaves a field off an
 * object should get a NULL column, not a stack trace.
 */
const flatten = (params) => {
  const list = params.length === 1 && Array.isArray(params[0]) ? params[0] : params
  return list.map((value) => (value === undefined ? null : value))
}

class Database {
  constructor(file, options = {}) {
    if (!native) throw new Error('metrodb has no binary for this platform')
    this.inner = new native.Database(String(file), {
      readonly: options.readonly ?? false,
      create: options.fileMustExist ? false : (options.create ?? true),
      timeoutMs: options.timeout ?? 5000
    })
    this.depth = 0
  }

  prepare(sql) {
    return new Statement(this.inner.prepare(sql))
  }

  exec(sql) {
    this.inner.exec(sql)
    return this
  }

  pragma(source, options = {}) {
    const rows = this.inner.pragma(source)
    if (options.simple) {
      const first = rows[0]
      return first ? Object.values(first)[0] : undefined
    }
    return rows
  }

  /**
   * better-sqlite3's shape: hand it a function, get a function back that
   * runs inside a transaction. Nested calls use savepoints, so a
   * transaction that calls another one commits once, at the end.
   */
  transaction(fn) {
    const run = (...args) => {
      const nested = this.depth > 0
      const name = `sp_metrodb_${this.depth}`

      if (nested) this.inner.savepoint(name)
      else this.inner.begin()
      this.depth += 1

      try {
        const result = fn(...args)
        this.depth -= 1
        if (nested) this.inner.release(name)
        else this.inner.commit()
        return result
      } catch (error) {
        this.depth -= 1
        try {
          if (nested) {
            this.inner.rollbackTo(name)
            this.inner.release(name)
          } else {
            this.inner.rollback()
          }
        } catch {
          /* the transaction is already gone */
        }
        throw error
      }
    }
    return run
  }

  backup(destination) {
    this.inner.backup(String(destination))
    return Promise.resolve({ totalPages: 0, remainingPages: 0 })
  }

  close() {
    this.inner.close()
    return this
  }

  get inTransaction() {
    return this.inner.inTransaction
  }

  get open() {
    return this.inner.open
  }

  get name() {
    return this.inner.name
  }

  get readonly() {
    return this.inner.readonly
  }
}

module.exports = Database
module.exports.default = Database
module.exports.Database = Database
/** True when a native binary for this platform was found and loaded. */
module.exports.available = Boolean(native)
module.exports.triedNames = candidates()
module.exports.loadErrors = failures
module.exports.version = () => native?.version() ?? null
module.exports.sqliteVersion = () => native?.sqliteVersion() ?? null
module.exports.describe = () => native?.describe() ?? 'MetroDB · no binary for this platform'
