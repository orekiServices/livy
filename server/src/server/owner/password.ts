/**
 * Owner passwords.
 *
 * The original credential was a random key printed once in the boot log. That
 * is a good secret and a bad first-run experience: on a remote box, or a
 * container whose logs the owner cannot see, there is nothing to type into
 * the console. A password can be created in the browser instead, supplied by
 * the environment, or added later from the owner console.
 *
 * Only a scrypt hash is written, next to the database as `owner.auth.json`
 * with mode 0600. The plaintext exists for the length of the request that
 * sets it and is never returned, logged or put in config output.
 *
 * The auto-generated `owner.key` remains valid until a password exists. Once
 * the node has a password, a *generated* key is ignored, so the log line
 * cannot be used to bypass the password. An explicit `OWNER_KEY` (env or
 * config) is a deliberate recovery credential and keeps working alongside it.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 256
const FILE_NAME = 'owner.auth.json'

// scrypt with a modest cost: strong against an offline attacker, and ~15–30 ms
// for the one request that presents a password. Owner traffic is not a hot
// path, so this is the right side of the trade.
const PARAMS = { N: 16_384, r: 8, p: 1, keylen: 32 }
const MAX_MEM = 64 * 1024 * 1024

/** Where the hash lives: next to the DB, or an explicit override in tests. */
export function ownerAuthFile(config) {
  if (config.owner?.authFile) return config.owner.authFile
  const database = config.store?.file
  const dir = database ? path.dirname(database) : path.join(process.cwd(), 'data')
  return path.join(dir, FILE_NAME)
}

function derive(password, salt, params = PARAMS) {
  return crypto.scryptSync(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAX_MEM
  })
}

function makeRecord(password) {
  const salt = crypto.randomBytes(16)
  return {
    version: 1,
    algorithm: 'scrypt',
    salt: salt.toString('base64'),
    hash: derive(password, salt).toString('base64'),
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    keylen: PARAMS.keylen
  }
}

function validRecord(record) {
  return Boolean(
    record &&
      record.algorithm === 'scrypt' &&
      typeof record.salt === 'string' &&
      typeof record.hash === 'string' &&
      Number.isInteger(record.N) &&
      record.N > 0 &&
      record.N <= 32_768 &&
      Number.isInteger(record.r) &&
      record.r > 0 &&
      record.r <= 16 &&
      Number.isInteger(record.p) &&
      record.p > 0 &&
      record.p <= 4 &&
      Number.isInteger(record.keylen) &&
      record.keylen >= 16 &&
      record.keylen <= 64
  )
}

/** The reason a password is not acceptable, or null. */
export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length === 0) return 'A password is required'
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`
  return null
}

export function hasPassword(config) {
  return Boolean(config.owner?.passwordHash)
}

export function passwordInfo(config) {
  return {
    configured: hasPassword(config),
    fromEnv: Boolean(config.owner?.passwordFromEnv),
    minLength: MIN_PASSWORD_LENGTH
  }
}

export function verifyPassword(password, record) {
  if (typeof password !== 'string' || !validRecord(record)) return false
  let expected
  let actual
  try {
    expected = Buffer.from(record.hash, 'base64')
    actual = derive(password, Buffer.from(record.salt, 'base64'), record)
  } catch {
    return false
  }
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

function persist(config, record) {
  try {
    const file = ownerAuthFile(config)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    // `mode` only applies when the file is created; fix an older copy too.
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      /* Windows may not expose POSIX modes */
    }
    return true
  } catch {
    // A read-only or serverless install keeps the password for this process
    // only. The caller says so rather than pretending it was saved.
    return false
  }
}

/**
 * Load the hash at boot, with `OWNER_PASSWORD` (or `owner.password` in config)
 * taking precedence. Env is persisted too, so removing the variable later
 * does not silently reopen the node.
 */
export function prepareOwnerAuth(config) {
  config.owner ??= {}
  const fromEnvironment = typeof config.owner.password === 'string' ? config.owner.password : ''
  if (fromEnvironment) {
    const problem = passwordProblem(fromEnvironment)
    delete config.owner.password
    if (problem) {
      config.owner.passwordProblem = problem
      return { configured: false, fromEnv: false, persisted: false, problem }
    }
    const record = makeRecord(fromEnvironment)
    config.owner.passwordHash = record
    config.owner.passwordFromEnv = true
    return { configured: true, fromEnv: true, persisted: persist(config, record), problem: null }
  }

  try {
    const record = JSON.parse(fs.readFileSync(ownerAuthFile(config), 'utf8'))
    if (validRecord(record)) {
      config.owner.passwordHash = record
      config.owner.passwordFromEnv = false
      return { configured: true, fromEnv: false, persisted: true, problem: null }
    }
  } catch {
    /* no hash yet, or it is unreadable */
  }
  config.owner.passwordHash = null
  config.owner.passwordFromEnv = false
  return { configured: false, fromEnv: false, persisted: false, problem: null }
}

/** Set or replace the password. Returns `{ persisted }` or `{ problem }`. */
export function setPassword(config, password) {
  const problem = passwordProblem(password)
  if (problem) return { persisted: false, problem }
  const record = makeRecord(password)
  config.owner ??= {}
  config.owner.passwordHash = record
  config.owner.passwordFromEnv = false
  return { persisted: persist(config, record), problem: null }
}

/**
 * Can this request create the first password without already being the owner?
 *
 * Only on an unclaimed node: no password yet, no station yet, and no explicit
 * `OWNER_KEY`/legacy password. A generated key is provisional by design — it
 * is what the first browser visitor is allowed to replace. An explicit key is
 * a decision the operator made, so it has to be presented.
 */
export function canClaimPassword(config, { stations = 0, authenticated = false }: any = {}) {
  if (hasPassword(config)) return false
  if (authenticated) return true
  if (config.owner?.keySource === 'explicit' || config.owner?.keySource === 'legacy') return false
  return stations === 0
}
