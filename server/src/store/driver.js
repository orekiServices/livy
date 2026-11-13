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

  let Database
  try {
    ;({ default: Database } = await import('better-sqlite3'))
  } catch (error) {
    throw new Error(
      `No SQLite binding is available (${error.message}). ` +
        'Build MetroDB with `cd native/metrodb && cargo build --release && node scripts/link-local.js`, ' +
        'or run Livy on Bun, or start with `store.enabled: false` to run without persistence.'
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

/** The same engine without a file: serverless, tests, a dry run. */
export async function openMemoryDatabase() {
  const make = (raw, driver) => {
    raw.exec('PRAGMA foreign_keys = ON;')
    return {
      driver,
      raw,
      exec: (sql) => raw.exec(sql),
      run: (sql, params = []) => raw.prepare(sql).run(...params),
      get: (sql, params = []) => raw.prepare(sql).get(...params),
      all: (sql, params = []) => raw.prepare(sql).all(...params),
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
