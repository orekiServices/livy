/**
 * The database driver.
 *
 * One engine, SQLite, opened through **MetroDB** — our Rust addon with SQLite
 * compiled in, so there is no node-gyp, no Python and no compiler at install
 * time. `bun:sqlite` and `better-sqlite3` remain last-resort bindings for a
 * platform with no MetroDB binary; they read the same file with the same SQL,
 * so nothing above this file knows which one answered.
 *
 * There is deliberately no Postgres driver. The node ships as one process with
 * one file to copy, back up and inspect; a second server to operate would buy
 * nothing a model registry needs. Training data, models and their runs all
 * live in this file (see migrations v8).
 */
import fs from 'node:fs'
import path from 'node:path'
import createLogger from '../util/logger.js'

const log = createLogger('store')

export const disabled = (...names) => names.some((name) => process.env[name] === '1')

/** node:sqlite rejects `undefined`/booleans; every other binding normalises. */
const bindParam = (value) => (value === undefined ? null : typeof value === 'boolean' ? (value ? 1 : 0) : value)
const bindAll = (params) => params.map(bindParam)

const pragmas = (exec) => {
  exec('PRAGMA journal_mode = WAL;')
  exec('PRAGMA synchronous = NORMAL;')
  exec('PRAGMA foreign_keys = ON;')
  exec('PRAGMA busy_timeout = 4000;')
}

async function loadMetroDb() {
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  try {
    return require('../../../native/metrodb/index.js')
  } catch {
    return require('metrodb')
  }
}

export async function openDatabase(file) {
  if (!disabled('LIVY_DISABLE_METRODB', 'NODECAST_DISABLE_METRODB')) {
    try {
      const MetroDb = await loadMetroDb()
      if (MetroDb?.available) {
        const db = new MetroDb(file)
        pragmas((sql) => db.exec(sql))
        return {
          driver: `metrodb (rust, sqlite ${MetroDb.sqliteVersion()})`,
          raw: db,
          exec: (sql) => db.exec(sql),
          run: (sql, params = []) => db.prepare(sql).run(params),
          get: (sql, params = []) => db.prepare(sql).get(params),
          all: (sql, params = []) => db.prepare(sql).all(params),
          transaction: (fn) => db.transaction(fn)(),
          backup: (target) => db.backup(target),
          close: () => db.close()
        }
      }
    } catch (error) {
      log.debug(`metrodb unavailable (${error.message}); trying a fallback binding`)
    }
  }

  if (typeof globalThis.Bun !== 'undefined') {
    const { Database } = await import('bun:sqlite')
    const db = new Database(file, { create: true })
    pragmas((sql) => db.exec(sql))
    return {
      driver: 'bun:sqlite',
      raw: db,
      exec: (sql) => db.exec(sql),
      run: (sql, params = []) => db.prepare(sql).run(...params),
      get: (sql, params = []) => db.prepare(sql).get(...params),
      all: (sql, params = []) => db.prepare(sql).all(...params),
      transaction: (fn) => db.transaction(fn)(),
      close: () => db.close()
    }
  }

  // Node's built-in SQLite. This is what makes Termux work: no node-gyp, no
  // compiler, no native package — the Node binary already carries SQLite.
  // It is experimental, so any failure falls through to better-sqlite3.
  try {
    return await openNodeSqlite(file)
  } catch (error) {
    log.debug(`node:sqlite unavailable (${error.message}); trying better-sqlite3`)
  }

  let Database
  try {
    ;({ default: Database } = await import('better-sqlite3'))
  } catch (error) {
    throw new Error(
      `SQLite is required but no binding is available (${error.message}). ` +
        'Use Node 22.13+ (node:sqlite) or Bun, build MetroDB with ' +
        '`cd native/metrodb && cargo build --release && node scripts/link-local.js`, ' +
        'or start with `store.enabled: false` to run without persistence.'
    )
  }

  const db = new Database(file)
  pragmas((sql) => db.exec(sql))
  return {
    driver: 'better-sqlite3',
    raw: db,
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => db.prepare(sql).run(...params),
    get: (sql, params = []) => db.prepare(sql).get(...params),
    all: (sql, params = []) => db.prepare(sql).all(...params),
    transaction: (fn) => db.transaction(fn)(),
    close: () => db.close()
  }
}

/** `node:sqlite` behind the better-sqlite3-ish interface the store expects. */
async function openNodeSqlite(file) {
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(file)
  pragmas((sql) => raw.exec(sql))
  // node:sqlite is stricter than better-sqlite3 about types it cannot bind:
  // `undefined` and booleans must become NULL and 0/1. Every other driver
  // accepts them (MetroDB normalises too), so the conversion lives here.
  const bind = bindAll
  return {
    driver: 'node:sqlite',
    raw,
    exec: (sql) => raw.exec(sql),
    run: (sql, params = []) => raw.prepare(sql).run(...bind(params)),
    get: (sql, params = []) => raw.prepare(sql).get(...bind(params)) ?? undefined,
    all: (sql, params = []) => raw.prepare(sql).all(...bind(params)),
    transaction: (fn) => {
      raw.exec('BEGIN IMMEDIATE;')
      try {
        const result = fn()
        raw.exec('COMMIT;')
        return result
      } catch (error) {
        try {
          raw.exec('ROLLBACK;')
        } catch {
          /* the transaction was already gone */
        }
        throw error
      }
    },
    close: () => raw.close()
  }
}

/** The same engine without a file: serverless, tests, a dry run. */
export async function openMemoryDatabase() {
  const make = (raw, driver) => {
    raw.exec('PRAGMA foreign_keys = ON;')
    return {
      driver,
      raw,
      exec: (sql) => raw.exec(sql),
      run: (sql, params = []) => raw.prepare(sql).run(...bindAll(params)),
      get: (sql, params = []) => raw.prepare(sql).get(...bindAll(params)),
      all: (sql, params = []) => raw.prepare(sql).all(...bindAll(params)),
      transaction: (fn) => raw.transaction(fn)(),
      close: () => raw.close()
    }
  }

  if (!disabled('LIVY_DISABLE_METRODB', 'NODECAST_DISABLE_METRODB')) {
    try {
      const MetroDb = await loadMetroDb()
      if (MetroDb?.available) {
        const raw = new MetroDb(':memory:')
        return make(
          {
            exec: (sql) => raw.exec(sql),
            prepare: (sql) => raw.prepare(sql),
            transaction: (fn) => raw.transaction(fn),
            close: () => raw.close()
          },
          `memory (ephemeral, sqlite ${MetroDb.sqliteVersion()})`
        )
      }
    } catch {
      // fall through to a binding
    }
  }

  if (typeof globalThis.Bun !== 'undefined') {
    const { Database } = await import('bun:sqlite')
    const raw = new Database(':memory:', { create: true })
    const db = make(raw, 'memory (ephemeral, bun:sqlite)')
    return db
  }

  try {
    const { DatabaseSync } = await import('node:sqlite')
    return make(new DatabaseSync(':memory:'), 'memory (ephemeral, node:sqlite)')
  } catch {
    // fall through to the binding
  }

  try {
    const { default: Database } = await import('better-sqlite3')
    return make(new Database(':memory:'), 'memory (ephemeral, better-sqlite3)')
  } catch (error) {
    throw new Error(`an in-memory SQLite driver is required (${error.message})`)
  }
}

/** Adopt `nodecast.db` / `radio.db` when the Livy file does not exist yet. */
const LEGACY_DATABASES = ['nodecast.db', 'radio.db']

export function adoptLegacyFile(file) {
  if (fs.existsSync(file)) return false
  const dir = path.dirname(file)
  const legacy = LEGACY_DATABASES.map((name) => path.join(dir, name)).find(
    (candidate) => candidate !== file && fs.existsSync(candidate)
  )
  if (!legacy) return false
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(legacy + suffix)) fs.renameSync(legacy + suffix, file + suffix)
  }
  log.info(`adopted the existing database ${path.basename(legacy)} → ${path.basename(file)}`)
  return true
}
