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
import { ACTIONS, featuresFor, targetFor } from '../features.js'

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

/**
 * How quickly an old seam stops mattering.
 *
 * A station's taste moves: the crowd at 2 a.m. in March is not the crowd at
 * 2 a.m. in June, a host changes, a playlist is re-cut. Training on a flat
 * mean over two years of log means the policy is always a little behind the
 * station it is programming, and the seams it gets wrong are the recent ones —
 * the ones a listener is actually hearing.
 *
 * So every labelled seam carries a weight, halving every `halfLifeDays`.
 * Fourteen days is deliberate: about 1,500 seams on a busy node (more than
 * enough to learn a 500-parameter policy from) while still letting a month-old
 * habit fade to a quarter. The floor is deliberately low — old evidence keeps
 * a voice, but one that loses to a real change of habit: at 0.2 a year of
 * history outvoted six weeks of new behaviour, which is the opposite of the
 * point.
 *
 * A record with no timestamp is not penalised: it counts once, as before.
 */
export const RECENCY_HALF_LIFE_DAYS = Number(process.env.LIVY_RECENCY_HALF_LIFE) || 14
export const RECENCY_FLOOR = 0.05

/** The weight of one record, 0…1, from its age. */
export function sampleWeight(record, { now = Date.now(), halfLifeDays = RECENCY_HALF_LIFE_DAYS, floor = RECENCY_FLOOR } = {}) {
  const at = Number(record?.at)
  if (!Number.isFinite(at) || at <= 0 || !(halfLifeDays > 0)) return 1
  const ageDays = Math.max(0, (now - at) / 86_400_000)
  const weight = 0.5 ** (ageDays / halfLifeDays)
  return Math.max(floor, Math.min(1, weight))
}

/** Only seams with an observed outcome are labels. */
export function buildDataset(records, { now = Date.now(), halfLifeDays = RECENCY_HALF_LIFE_DAYS, floor = RECENCY_FLOOR } = {}) {
  const pairs = []
  for (const record of records) {
    const y = targetFor(record)
    if (!y) continue
    if (record.outcome !== 'completed' && record.outcome !== 'skipped') continue
    pairs.push({
      x: featuresFor(record),
      y,
      // The trainer's optimiser reads this; nothing else needs it.
      w: sampleWeight(record, { now, halfLifeDays, floor }),
      at: Number(record.at) || null,
      outcome: record.outcome
    })
  }
  return pairs
}

/** The shape of the weights a run actually used, for the report. */
export function recencySummary(pairs, { halfLifeDays = RECENCY_HALF_LIFE_DAYS } = {}) {
  const weights = pairs.map((pair) => (Number.isFinite(pair.w) ? pair.w : 1))
  const times = pairs.map((pair) => pair.at).filter((at) => Number.isFinite(at))
  const mean = weights.length ? weights.reduce((sum, value) => sum + value, 0) / weights.length : 1
  return {
    halfLifeDays,
    mean: Number(mean.toFixed(3)),
    newest: times.length ? Math.max(...times) : null,
    oldest: times.length ? Math.min(...times) : null,
    // How many rows are old enough to be mostly ignored: the number that
    // explains why a run on a year of log behaves like a run on a month.
    faded: weights.filter((weight) => weight <= 0.25).length
  }
}

/** How much of the training set each action accounts for. */
export function support(pairs) {
  const counts = Object.fromEntries(ACTIONS.map((name) => [name, 0]))
  for (const { y } of pairs) {
    const index = y.indexOf(Math.max(...y))
    if (index >= 0 && ACTIONS[index]) counts[ACTIONS[index]] += 1
  }
  return counts
}

/**
 * Brier score over the softmax.
 *
 * Accuracy says the top action was right; it does not say the model *knew*.
 * A policy that ranks the right transition first at 0.14 confidence and one
 * that does it at 0.9 score identically on accuracy and behave very
 * differently at a seam where the margin matters. The Brier score (mean
 * squared error between the predicted distribution and the preference target)
 * is the number that separates them, and it is what the console shows next to
 * accuracy: lower is better, and 0.1 is a policy worth trusting.
 */
export function brier(network, pairs) {
  if (pairs.length === 0) return 0
  let total = 0
  for (const { x, y } of pairs) {
    const p = network.probabilities(x)
    for (let i = 0; i < p.length; i += 1) total += (p[i] - (y[i] ?? 0)) ** 2
  }
  return total / pairs.length
}

/**
 * Brier skill: how much better than a uniform guess the distribution is.
 *
 * The raw Brier score means little on its own — ten outputs and a one-hot
 * target put the uniform guess near 0.9 — so it is scored against exactly that
 * baseline. 0 is "no better than guessing", 0.5 is half the error of a coin,
 * and a negative number is a real finding: the model's first choice is right
 * but its *confidence* is badly placed, which is the thing that makes a policy
 * pick a transition on a thin margin.
 */
export function brierSkill(network, pairs) {
  if (pairs.length === 0) return 0
  const uniform = 1 / ACTIONS.length
  let model = 0
  let reference = 0
  for (const { x, y } of pairs) {
    const p = network.probabilities(x)
    for (let i = 0; i < p.length; i += 1) {
      model += (p[i] - (y[i] ?? 0)) ** 2
      reference += (uniform - (y[i] ?? 0)) ** 2
    }
  }
  return reference > 0 ? 1 - model / reference : 0
}

/** Mean probability the policy puts on its own first choice. */
export function confidence(network, pairs) {
  if (pairs.length === 0) return 0
  let total = 0
  for (const { x } of pairs) total += Math.max(...network.probabilities(x))
  return total / pairs.length
}

/** Chronological split: the last fifth is held out, never shuffled across. */
export function split(pairs, fraction = 0.2) {
  // Too few to hold a fifth out and still learn: hold out the newest quarter
  // (at least one), and never score on a row that was trained on.
  if (pairs.length < 10) {
    if (pairs.length < 2) return { train: pairs, test: [], holdout: true }
    const keep = Math.max(1, Math.floor(pairs.length / 4))
    return { train: pairs.slice(0, -keep), test: pairs.slice(-keep), holdout: true }
  }
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
