/**
 * The database driver.
 *
 * One engine, SQLite, opened through **MetroDB** — our Rust addon with SQLite
 * compiled in, so there is no node-gyp, no Python and no compiler at install
 * time. `bun:sqlite`, which Bun carries, is the binding for a platform with no
 * MetroDB binary; it reads the same file with the same SQL, so nothing above
 * this file knows which one answered.
 *
 * There is deliberately no Postgres driver. The node ships as one process with
 * one file to copy, back up and inspect; a second server to operate would buy
 * nothing a model registry needs. Training data, models and their runs all
 * live in this file (see migrations v8).
 */
import fs from 'node:fs'
import path from 'node:path'
import createLogger from '../util/logger.ts'

const log = createLogger('store')

export const disabled = (...names) => names.some((name) => process.env[name] === '1')

/** `undefined` binds as NULL and booleans as 0/1, whichever binding answers. */
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

/** Wrap Node's built-in `node:sqlite` DatabaseSync into Livy's driver contract. */
function wrapNodeSqlite(db, driver) {
  let depth = 0
  return {
    driver,
    raw: db,
    exec: (sql) => db.exec(sql),
    run: (sql, params: any = []) => db.prepare(sql).run(...bindAll(params)),
    get: (sql, params: any = []) => db.prepare(sql).get(...bindAll(params)),
    all: (sql, params: any = []) => db.prepare(sql).all(...bindAll(params)),
    transaction: (fn) => {
      const savepoint = depth > 0 ? `sp_${depth}` : null
      db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN')
      depth += 1
      try {
        const result = fn()
        depth -= 1
        db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT')
        return result
      } catch (error) {
        depth -= 1
        try {
          db.exec(savepoint ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK')
        } catch {
          /* ignore rollback failure */
        }
        throw error
      }
    },
    close: () => db.close()
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
          run: (sql, params: any = []) => db.prepare(sql).run(params),
          get: (sql, params: any = []) => db.prepare(sql).get(params),
          all: (sql, params: any = []) => db.prepare(sql).all(params),
          transaction: (fn) => db.transaction(fn)(),
          backup: (target) => db.backup(target),
          close: () => db.close()
        }
      }
    } catch (error) {
      log.debug(`metrodb unavailable (${error.message}); trying a fallback binding`)
    }
  }

  // Bun's built-in SQLite: no native package, nothing to compile.
  try {
    const { Database } = await import('bun:sqlite')
    const db = new Database(file, { create: true })
    pragmas((sql) => db.exec(sql))
    return {
      driver: 'bun:sqlite',
      raw: db,
      exec: (sql) => db.exec(sql),
      run: (sql, params: any = []) => db.prepare(sql).run(...bindAll(params)),
      get: (sql, params: any = []) => db.prepare(sql).get(...bindAll(params)),
      all: (sql, params: any = []) => db.prepare(sql).all(...bindAll(params)),
      transaction: (fn) => db.transaction(fn)(),
      close: () => db.close()
    }
  } catch {
    // Fall through to Node's built-in sqlite when running on Node 22+.
  }

  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file)
    pragmas((sql) => db.exec(sql))
    return wrapNodeSqlite(db, 'node:sqlite')
  } catch (error) {
    throw new Error(
      `SQLite is required but no binding is available (${error.message}). ` +
        'Livy runs on Bun (bun:sqlite is built in) or Node 22+ (node:sqlite); build MetroDB with ' +
        '`cd native/metrodb && cargo build --release && bun scripts/link-local.js`, ' +
        'or start with `store.enabled: false` to run without persistence.'
    )
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
      run: (sql, params: any = []) => raw.prepare(sql).run(...bindAll(params)),
      get: (sql, params: any = []) => raw.prepare(sql).get(...bindAll(params)),
      all: (sql, params: any = []) => raw.prepare(sql).all(...bindAll(params)),
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

  try {
    const { Database } = await import('bun:sqlite')
    return make(new Database(':memory:', { create: true }), 'memory (ephemeral, bun:sqlite)')
  } catch {
    // fall through to node:sqlite
  }

  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON;')
    return wrapNodeSqlite(db, 'memory (ephemeral, node:sqlite)')
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
