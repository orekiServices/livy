/**
 * The training set: seams a station already played, and what listeners did.
 *
 * Two sources with one shape — a JSONL tail on disk (works with no database)
 * and the `dj_seams` table in MetroDB (works when the node has one). The
 * database wins when it has rows: it is the same data, indexed, and survives a
 * container that cannot write next to the model files.
 */
import fs from 'node:fs'
import path from 'node:path'
import createLogger from '../../../util/logger.js'
import { paths } from '../../../config.js'
import { featuresFor, targetFor } from '../features.js'

const log = createLogger('dj-dataset')

export const LOG_FILE = () => path.join(paths.data, 'dj-seams.jsonl')
export const MAX_LOG_LINES = 20_000

/**
 * Append one seam. Writes both places when a store is given, because the file
 * is cheap and the row is what a live trainer polls.
 */
export function recordSeam(record, { file = LOG_FILE(), store = null } = {}) {
  let saved = false
  try {
    if (store?.saveSeam) {
      store.saveSeam(record)
      saved = true
    }
  } catch (error) {
    log.debug(`seam row: ${error.message}`)
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`)
    saved = true
  } catch (error) {
    log.debug(`could not record a seam: ${error.message}`)
  }
  return saved
}

/** Read the log, newest last. Missing file → empty. */
export function readSeams({ file = LOG_FILE(), limit = MAX_LOG_LINES, store = null } = {}) {
  if (store?.recentSeams) {
    try {
      const rows = store.recentSeams(limit)
      if (rows.length) return rows
    } catch (error) {
      log.debug(`seam table: ${error.message}`)
    }
  }

  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const lines = text.split('\n').filter(Boolean).slice(-limit)
  const records = []
  for (const line of lines) {
    try {
      records.push(JSON.parse(line))
    } catch {
      // A torn last line from a crash.
    }
  }
  return records
}

/** Only seams with an observed outcome are labels. */
export function buildDataset(records) {
  const pairs = []
  for (const record of records) {
    const y = targetFor(record)
    if (!y) continue
    if (record.outcome !== 'completed' && record.outcome !== 'skipped') continue
    pairs.push({ x: featuresFor(record), y })
  }
  return pairs
}

/** Chronological split: the last fifth is held out, never shuffled across. */
export function split(pairs, fraction = 0.2) {
  if (pairs.length < 10) return { train: pairs, test: pairs.slice(-1), holdout: true }
  const cut = Math.max(1, Math.floor(pairs.length * (1 - fraction)))
  return { train: pairs.slice(0, cut), test: pairs.slice(cut), holdout: false }
}

/** Did the top-scoring action match the best label? */
export function accuracy(network, pairs) {
  if (pairs.length === 0) return 0
  let correct = 0
  for (const { x, y } of pairs) {
    const output = network.predict(x)
    if (output.indexOf(Math.max(...output)) === y.indexOf(Math.max(...y))) correct += 1
  }
  return correct / pairs.length
}

export function loss(network, pairs) {
  if (pairs.length === 0) return 0
  let total = 0
  for (const { x, y } of pairs) {
    const output = network.predict(x)
    for (let i = 0; i < output.length; i += 1) total += (output[i] - y[i]) ** 2
  }
  return total / pairs.length
}

/** Count lines without parsing them, for "is there enough data yet?". */
export function seamCount({ file = LOG_FILE(), store = null } = {}) {
  // The table wins only when it actually has rows, exactly like `readSeams`:
  // a node that logged seams to JSONL before it had a database (or whose row
  // write failed) still has training data, and it must not look empty.
  if (store?.countSeams) {
    try {
      const rows = store.countSeams()
      if (rows > 0) return rows
    } catch {
      // fall through to the log
    }
  }
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}
