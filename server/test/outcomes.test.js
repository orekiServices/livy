/**
 * The two things that make the automix smarter over time, tested on their own:
 * recency-weighted training (what the station liked *recently*) and the seam
 * scoreboard (what each transition actually does here).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Network } from '../src/core/models/network.js'
import { trainModels, shuffledIndexes } from '../src/core/models/trainer/index.js'
import { FEATURES, ACTIONS, featuresFor } from '../src/core/models/features.js'
import { RECENCY_FLOOR, RECENCY_HALF_LIFE_DAYS, buildDataset, recencySummary, sampleWeight, support } from '../src/core/models/trainer/dataset.js'
import { MAX_NUDGE, MIN_SHOWS, effectNudge, effectOutcomes, outcomeReport } from '../src/core/automix/outcomes.js'
import { rankEffects } from '../src/core/automix/effects.js'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 4, 1, 12)

/** A seam that carries every transition, so the ranking is the whole field. */
const seam = { beat: true, matched: true, tempoDelta: 1, correlation: 0.1, fadeMs: 8000, energy: 0.8 }

test('recency: a seam halves in weight every half-life, and never disappears', () => {
  assert.equal(sampleWeight({}, { now: NOW }), 1, 'a row with no timestamp counts once')
  assert.equal(sampleWeight({ at: NOW }, { now: NOW }), 1, 'a brand-new seam has full weight')
  const half = sampleWeight({ at: NOW - RECENCY_HALF_LIFE_DAYS * DAY }, { now: NOW })
  assert.ok(Math.abs(half - 0.5) < 1e-9, `one half-life is 0.5 (got ${half})`)
  const two = sampleWeight({ at: NOW - 2 * RECENCY_HALF_LIFE_DAYS * DAY }, { now: NOW })
  assert.ok(Math.abs(two - 0.25) < 1e-9, 'two half-lives is a quarter')
  // A year of log does not go silent: the floor keeps old evidence audible.
  assert.equal(sampleWeight({ at: NOW - 365 * DAY }, { now: NOW }), RECENCY_FLOOR)
  // A clock that runs backwards is not a reason to drop a row.
  assert.equal(sampleWeight({ at: NOW + 5 * DAY }, { now: NOW }), 1)
})

test('recency: the dataset carries the weight, and reports what it used', () => {
  const record = (at) => ({ at, bpmOut: 120, bpmIn: 120, matched: true, effect: 'crossfade', outcome: 'completed' })
  const pairs = buildDataset([record(NOW), record(NOW - 14 * DAY), record(NOW - 60 * DAY)], { now: NOW })
  assert.equal(pairs.length, 3)
  assert.ok(pairs[0].w > pairs[1].w && pairs[1].w > pairs[2].w, 'newest first, and each older one lighter')
  assert.equal(pairs[0].w, 1)
  const summary = recencySummary(pairs)
  assert.equal(summary.halfLifeDays, RECENCY_HALF_LIFE_DAYS)
  assert.equal(summary.newest, NOW)
  assert.equal(summary.oldest, NOW - 60 * DAY)
  assert.ok(summary.faded >= 1, 'the 60-day-old row is counted as faded')
})

test('recency: a weighted row outvotes an unweighted one, and the network learns the recent rule', () => {
  const net = new Network([FEATURES.length, 4, ACTIONS.length], { seed: 11 })
  const features = new Array(FEATURES.length).fill(0.1)
  const wanted = new Array(ACTIONS.length).fill(0)
  wanted[ACTIONS.indexOf('slam')] = 1
  const unwanted = new Array(ACTIONS.length).fill(0)
  unwanted[ACTIONS.indexOf('crossfade')] = 1

  for (let step = 0; step < 200; step += 1) {
    net.train(
      [
        { x: features, y: wanted, w: 1 },
        { x: features, y: unwanted, w: 0.05 }
      ],
      { learningRate: 0.02 }
    )
  }
  const output = net.predict(features)
  assert.equal(output.indexOf(Math.max(...output)), ACTIONS.indexOf('slam'), 'the heavy row decides')
})

test('recency: an unweighted batch trains exactly as it always did', () => {
  const a = new Network([FEATURES.length, 4, ACTIONS.length], { seed: 3 })
  const b = new Network([FEATURES.length, 4, ACTIONS.length], { seed: 3 })
  const row = { x: new Array(FEATURES.length).fill(0.2), y: ARRAY() }
  for (let step = 0; step < 20; step += 1) {
    a.train([row], { learningRate: 0.01 })
    b.train([{ ...row, w: 1 }], { learningRate: 0.01 })
  }
  assert.deepEqual(a.parameters(), b.parameters(), 'w: 1 means the same arithmetic')
})

function ARRAY() {
  const y = new Array(ACTIONS.length).fill(0)
  y[0] = 1
  return y
}

test('recency: with the same number of seams either side, the recent side decides', () => {
  // Four hundred seams from six weeks ago, four hundred from last week. Equal
  // volume, so nothing but the clock can break the tie: flat training splits
  // the difference, weighted training follows the run of shows that is still
  // going on. The row order is the trainer's own (`shuffledIndexes`), because
  // feeding a chronological log in order is what the old loop did and what
  // made weights meaningless.
  const DAY = 86_400_000
  const now = Date.now()
  const row = (at, effect) => ({ at, bpmOut: 120, bpmIn: 121, matched: true, correlation: 0.2, energy: 0.5, fadeMs: 6000, effect, outcome: 'completed' })
  const records = []
  for (let i = 0; i < 400; i += 1) records.push(row(now - (42 - 12 * (i / 400)) * DAY, 'crossfade'))
  for (let i = 0; i < 400; i += 1) records.push(row(now - (7 - 7 * (i / 400)) * DAY, 'slam'))
  records.sort((a, b) => a.at - b.at)

  const pairs = buildDataset(records, { now })
  assert.equal(pairs.length, 800)

  const fit = (weighted) => {
    const net = new Network([FEATURES.length, 8, ACTIONS.length], { seed: 41 })
    for (let epoch = 0; epoch < 60; epoch += 1) {
      const order = shuffledIndexes(pairs.length, 41 + epoch * 7919)
      const batch = []
      for (let i = 0; i < order.length; i += 1) {
        const pair = pairs[order[i]]
        batch.push(weighted ? pair : { ...pair, w: 1 })
        if (batch.length === 32) {
          net.train(batch, { learningRate: 0.02 })
          batch.length = 0
        }
      }
      if (batch.length) net.train(batch, { learningRate: 0.02 })
    }
    const output = Array.from(net.predict(featuresFor(records[records.length - 1])))
    return output.indexOf(Math.max(...output))
  }

  assert.equal(fit(true), ACTIONS.indexOf('slam'), 'weighted: last week wins')
  // Unweighted, with identical inputs, the two eras are a coin toss — the
  // network is fitting the mean of the two labels, so it cannot prefer either.
  const flat = fit(false)
  assert.ok([ACTIONS.indexOf('slam'), ACTIONS.indexOf('crossfade')].includes(flat))
})

test('recency: the report says what the run weighted, and how sure it is', async () => {
  const DAY = 86_400_000
  const now = Date.now()
  const records = []
  for (let i = 0; i < 240; i += 1) {
    records.push({ at: now - (60 - i / 4) * DAY, bpmOut: 120, bpmIn: 121, matched: true, correlation: 0.2, energy: 0.5, fadeMs: 6000, effect: i % 2 ? 'slam' : 'crossfade', outcome: 'completed' })
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recency-'))
  const file = path.join(dir, 'seams.jsonl')
  for (const record of records) fs.appendFileSync(file, `${JSON.stringify(record)}\n`)

  const report = await trainModels({ file, epochs: 40, count: 1, activate: false, saveDir: path.join(dir, 'models'), backend: 'js' })
  assert.equal(report.trained, true, report.reason)
  assert.equal(report.recency.halfLifeDays, RECENCY_HALF_LIFE_DAYS)
  assert.ok(report.recency.faded > 0, 'the old end of the log is counted as faded')
  assert.ok(report.recency.mean > RECENCY_FLOOR && report.recency.mean <= 1)
  assert.ok(Number.isFinite(report.eval.brier) && Number.isFinite(report.eval.skill), 'the distribution is scored')
  assert.equal(
    Object.values(report.eval.support).reduce((sum, value) => sum + value, 0),
    report.train,
    'support explains exactly the rows the network trained on'
  )
}, { timeout: 60_000 })

test('scoreboard: a transition needs real evidence before it earns a nudge', () => {
  const log = []
  for (let i = 0; i < 12; i += 1) log.push({ at: NOW - i * 60_000, effect: 'slam', outcome: i < 10 ? 'completed' : 'skipped' })
  for (let i = 0; i < 2; i += 1) log.push({ at: NOW - i * 60_000, effect: 'wash', outcome: 'completed' })

  const board = effectOutcomes(log, { now: NOW })
  assert.deepEqual(board.trusted, ['slam'], 'two plays are not a reputation')
  assert.ok(board.effects.slam.rate > 0.7, `ten of twelve is a good rate (${board.effects.slam.rate})`)
  assert.equal(effectNudge('wash', board), 0, 'an untrusted transition is left alone')
  assert.equal(effectNudge('never-played', board), 0, 'and so is one with no history')
  assert.equal(effectNudge('slam', null), 0, 'no log is not a verdict')

  const nudge = effectNudge('slam', board)
  assert.ok(nudge > 0 && nudge <= MAX_NUDGE, `a good record nudges up, within the cap (${nudge})`)
})

test('scoreboard: the nudge is capped, symmetric, and recent evidence wins', () => {
  const make = (effect, outcomes, at = NOW) => outcomes.map((outcome) => ({ at, effect, outcome }))
  const good = effectOutcomes(make('drop', new Array(40).fill('completed')), { now: NOW })
  const bad = effectOutcomes(make('drop', new Array(40).fill('skipped')), { now: NOW })
  assert.ok(Math.abs(effectNudge('drop', bad) + effectNudge('drop', good)) < 0.02, 'roughly symmetric')
  assert.ok(effectNudge('drop', good) <= MAX_NUDGE + 1e-9, 'never more than the cap')
  assert.ok(effectNudge('drop', bad) >= -MAX_NUDGE - 1e-9, '…in either direction')

  // Twenty good shows a year ago should not outweigh twenty bad shows today.
  const old = effectOutcomes(
    [...make('drop', new Array(20).fill('completed'), NOW - 365 * DAY), ...make('drop', new Array(20).fill('skipped'), NOW)],
    { now: NOW }
  )
  assert.ok(old.effects.drop.rate < 0.5, `recent skips dominate the old wins (${old.effects.drop.rate})`)
})

test('scoreboard: the automix ranking actually moves, without overriding the seam', () => {
  const baseline = rankEffects(seam, [])
  assert.ok(baseline.length >= 4)
  const top = baseline[0].name

  // Give every transition a good record except the heuristic's favourite, and
  // make that one consistently bad.
  const log = []
  for (const name of ['crossfade', 'bass-swap', 'filter', 'echo', 'sweep', 'spindown', 'slam', 'wash', 'roll', 'drop']) {
    for (let i = 0; i < 40; i += 1) log.push({ at: NOW - i * 60_000, effect: name, outcome: name === top ? 'skipped' : 'completed' })
  }
  const board = effectOutcomes(log, { now: NOW })
  const nudged = rankEffects({ ...seam, outcomes: board }, [])
  assert.notEqual(nudged[0].name, top, 'a transition that keeps losing loses the top spot')
  // …but nothing the seam cannot carry is introduced by the nudge.
  assert.deepEqual(nudged.map((entry) => entry.name).sort(), baseline.map((entry) => entry.name).sort())
  // And the movement is small: the score span is still the heuristic's.
  const span = Math.abs(nudged[0].score - baseline[0].score)
  assert.ok(span < 0.5, `the scoreboard is a nudge, not a rewrite (${span.toFixed(3)})`)
})

test('scoreboard: the owner report names the transitions worth showing', () => {
  const log = []
  for (let i = 0; i < MIN_SHOWS + 4; i += 1) log.push({ at: NOW, effect: 'roll', outcome: 'completed' })
  for (let i = 0; i < 2; i += 1) log.push({ at: NOW, effect: 'echo', outcome: 'skipped' })
  const report = outcomeReport(effectOutcomes(log, { now: NOW }))
  assert.equal(report.seams, MIN_SHOWS + 6)
  assert.equal(report.rows.length, 2)
  assert.equal(report.rows[0].effect, 'roll', 'best rate first')
  assert.deepEqual(report.trusted, ['roll'])
  assert.equal(report.halfLifeDays > 0, true)
})

test('scoreboard: support counts what the policy was actually trained on', () => {
  const records = ['crossfade', 'crossfade', 'slam'].map((effect, index) => ({
    at: NOW - index * 1000,
    bpmOut: 120,
    bpmIn: 118,
    matched: true,
    effect,
    outcome: 'completed'
  }))
  const counts = support(buildDataset(records, { now: NOW }))
  assert.equal(counts.crossfade, 2)
  assert.equal(counts.slam, 1)
  assert.equal(counts.drop, 0)
})
