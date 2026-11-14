/**
 * RL — one model for the whole question "what do I do at this seam?".
 *
 * The network in `network.js` looks at sixteen numbers about a pair of songs
 * and ranks ten transitions. It needs a few hundred labelled seams before it
 * is better than the rules, and it has no idea what the music is doing at the
 * moment it is cut. RL is the other half, and it is deliberately small:
 *
 *   1. It **sorts beats into kinds** (silence, sparse, groove, build, drop,
 *      break, vocal, fade) with centroids it fits to the beats this station
 *      has actually aired — see `seams/categories.ts`.
 *   2. For each *(kind left, kind entered, transition)* it keeps how often
 *      that was played and how often the listener stayed, and from those a
 *      value: a contextual bandit, learned from the same completed/skipped
 *      log the network trains on.
 *
 * Eight kinds by eight kinds by ten transitions is 640 cells, and a station
 * plays a few hundred seams a week, so most cells are empty most of the time.
 * A cell therefore *backs off*: its value is its own evidence blended with
 * what is known about that transition from the same exit kind, then about the
 * transition anywhere, then about seams in general. One observation moves a
 * cell a little; twenty make it mostly its own. That is also why RL is useful
 * from the first dozen seams, where a network is not.
 *
 * Choosing is upper-confidence-bound: the value plus a bonus that shrinks as
 * a cell is tried. The bonus is what makes it reinforcement learning rather
 * than counting — a transition that has never been tried in a context is
 * worth trying once — and it is capped so RL never overrules the renderer's
 * preconditions or a clear record.
 *
 * It is one JSON file. A corrupt or foreign one is ignored, never an outage.
 */
import fs from 'node:fs'
import path from 'node:path'
import { paths } from '../../config.ts'
import { ACTIONS, ATTRIBUTION_MS } from './features.ts'
import { CATEGORIES, PROTOTYPES, WIDTH, fitCentroids, nearest, type Category } from '../seams/categories.ts'

export const CODENAME = 'RL'
export const RL_VERSION = 1
export const RL_FILE = () => path.join(paths.data, 'rl-model.json')

const K = CATEGORIES.length
const A = ACTIONS.length
/** How many observations each level of prior is worth. */
const PRIOR = 4
/** A seam nobody has an opinion about. */
const NEUTRAL = 0.6

export interface SeamRecord {
  effect?: string
  outcome?: string
  skippedAfterMs?: number
  exitKind?: string | null
  entryKind?: string | null
  exitBeat?: number[] | null
  entryBeat?: number[] | null
}

export interface Ranked {
  effect: string
  /** Expected reward, 0…1. */
  value: number
  /** Value plus the exploration bonus — what the ranking is by. */
  score: number
  /** Times this exact context has played it. */
  plays: number
}

/** What a logged outcome is worth. `null`: nothing was observed. */
export function rewardFor(record: SeamRecord): number | null {
  if (record.outcome === 'completed') return 1
  if (record.outcome === 'skipped') {
    const since = Number(record.skippedAfterMs)
    // Close to the seam it is about the seam. Later it is mostly about the
    // song — but a little about the seam that introduced it.
    if (!Number.isFinite(since) || since < ATTRIBUTION_MS) return 0
    return 0.5
  }
  return null
}

export class RLModel {
  readonly codename = CODENAME
  version = RL_VERSION
  centroids: number[][] = PROTOTYPES.map((row) => [...row])
  /** Beats of each kind the centroids were fitted to. */
  beats: number[] = new Array(K).fill(0)
  plays = new Float64Array(K * K * A)
  reward = new Float64Array(K * K * A)
  seams = 0
  trainedAt: number | null = null

  #cell(exit: number, entry: number, action: number) {
    return (exit * K + entry) * A + action
  }

  /** The kind of a beat, from its descriptor. */
  kindOf(descriptor: ArrayLike<number> | null | undefined): Category | null {
    if (!descriptor || descriptor.length < WIDTH) return null
    return CATEGORIES[nearest(descriptor, this.centroids)]
  }

  /** Resolve a record's two kinds: by descriptor when there is one (so a
   *  refit re-sorts old seams), by the name it was logged with otherwise. */
  #kinds(record: SeamRecord): [number, number] | null {
    const exit = this.kindOf(record.exitBeat) ?? record.exitKind
    const entry = this.kindOf(record.entryBeat) ?? record.entryKind
    const e = CATEGORIES.indexOf(exit as Category)
    const n = CATEGORIES.indexOf(entry as Category)
    return e < 0 || n < 0 ? null : [e, n]
  }

  /** Learn from one finished seam. Returns whether it taught anything. */
  learn(record: SeamRecord): boolean {
    const action = ACTIONS.indexOf(record.effect as string)
    const reward = rewardFor(record)
    const kinds = this.#kinds(record)
    if (action < 0 || reward == null || !kinds) return false
    const cell = this.#cell(kinds[0], kinds[1], action)
    this.plays[cell] += 1
    this.reward[cell] += reward
    this.seams += 1
    return true
  }

  /** Sum plays and reward over a set of cells. */
  #sum(pick: (exit: number, entry: number, action: number) => boolean) {
    let plays = 0
    let reward = 0
    for (let e = 0; e < K; e += 1) {
      for (let n = 0; n < K; n += 1) {
        for (let a = 0; a < A; a += 1) {
          if (!pick(e, n, a)) continue
          const cell = this.#cell(e, n, a)
          plays += this.plays[cell]
          reward += this.reward[cell]
        }
      }
    }
    return { plays, reward }
  }

  /** Expected reward of a transition in a context, with back-off. */
  value(exit: Category, entry: Category, effect: string): { value: number; plays: number } {
    const e = CATEGORIES.indexOf(exit)
    const n = CATEGORIES.indexOf(entry)
    const a = ACTIONS.indexOf(effect)
    if (e < 0 || n < 0 || a < 0) return { value: NEUTRAL, plays: 0 }
    const blend = (level: { plays: number; reward: number }, prior: number) => (level.reward + PRIOR * prior) / (level.plays + PRIOR)
    const everything = blend(this.#sum(() => true), NEUTRAL)
    const anywhere = blend(this.#sum((_e, _n, action) => action === a), everything)
    const fromExit = blend(this.#sum((ex, _n, action) => ex === e && action === a), anywhere)
    const cell = this.#cell(e, n, a)
    return { value: blend({ plays: this.plays[cell], reward: this.reward[cell] }, fromExit), plays: this.plays[cell] }
  }

  /**
   * Rank the transitions in `pool` for a seam from `exit` into `entry`.
   * `explore` scales the bonus for untried cells; 0 is pure exploitation.
   */
  rank(exit: Category, entry: Category, pool: readonly string[] = ACTIONS, { explore = 0.35 }: any = {}): Ranked[] {
    const context = this.#sum((e, n) => e === CATEGORIES.indexOf(exit) && n === CATEGORIES.indexOf(entry)).plays
    const out: Ranked[] = []
    for (const effect of pool) {
      if (!ACTIONS.includes(effect)) continue
      const { value, plays } = this.value(exit, entry, effect)
      const bonus = explore * Math.sqrt(Math.log(context + 2) / (plays + 1)) * 0.25
      out.push({ effect, value: Number(value.toFixed(4)), score: Number((value + Math.min(0.2, bonus)).toFixed(4)), plays })
    }
    return out.sort((x, y) => y.score - x.score)
  }

  /** How much is known about a context: seams played from `exit` into `entry`. */
  evidence(exit: Category, entry: Category) {
    const e = CATEGORIES.indexOf(exit)
    const n = CATEGORIES.indexOf(entry)
    return this.#sum((ex, en) => ex === e && en === n).plays
  }

  /** How good a place to cut is, by the kinds on either side (0…1). */
  seamValue(exit: Category, entry: Category): number {
    const e = CATEGORIES.indexOf(exit)
    const n = CATEGORIES.indexOf(entry)
    if (e < 0 || n < 0) return NEUTRAL
    const all = this.#sum(() => true)
    const overall = (all.reward + PRIOR * NEUTRAL) / (all.plays + PRIOR)
    const here = this.#sum((ex, en) => ex === e && en === n)
    return (here.reward + PRIOR * overall) / (here.plays + PRIOR)
  }

  /**
   * Fit a fresh model to a log: centroids first (from every beat descriptor
   * in it), then every seam replayed through them.
   */
  static train(records: SeamRecord[], { anchor = 20 }: any = {}): RLModel {
    const model = new RLModel()
    const samples: number[][] = []
    for (const record of records) {
      for (const beat of [record.exitBeat, record.entryBeat]) if (Array.isArray(beat) && beat.length >= WIDTH) samples.push(beat)
    }
    const fitted = fitCentroids(samples, { anchor })
    model.centroids = fitted.centroids
    model.beats = fitted.counts
    for (const record of records) model.learn(record)
    model.trainedAt = Date.now()
    return model
  }

  /**
   * Is the model's advice worth anything? Train on the first four fifths of
   * a log and look at the last fifth: of the seams where the station happened
   * to play what RL would have picked, how did they do, against the rest?
   * (Off-policy evaluation by matching — crude, honest, and needing no
   * simulator.)
   */
  static evaluate(records: SeamRecord[], { fraction = 0.2 }: any = {}) {
    const usable = records.filter((record) => rewardFor(record) != null && ACTIONS.includes(record.effect as string))
    const cut = Math.floor(usable.length * (1 - fraction))
    const model = RLModel.train(usable.slice(0, cut))
    let matched = 0
    let matchedReward = 0
    let others = 0
    let othersReward = 0
    for (const record of usable.slice(cut)) {
      const kinds = model.#kinds(record)
      if (!kinds) continue
      const top = model.rank(CATEGORIES[kinds[0]], CATEGORIES[kinds[1]], ACTIONS, { explore: 0 })[0]
      const reward = rewardFor(record) as number
      if (top?.effect === record.effect) {
        matched += 1
        matchedReward += reward
      } else {
        others += 1
        othersReward += reward
      }
    }
    return {
      trainedOn: cut,
      heldOut: matched + others,
      agreed: matched,
      rewardWhenAgreed: matched ? Number((matchedReward / matched).toFixed(3)) : null,
      rewardOtherwise: others ? Number((othersReward / others).toFixed(3)) : null
    }
  }

  toJSON() {
    return {
      codename: CODENAME,
      version: this.version,
      categories: CATEGORIES,
      actions: ACTIONS,
      centroids: this.centroids.map((row) => row.map((value) => Number(value.toFixed(5)))),
      beats: this.beats,
      plays: Array.from(this.plays),
      reward: Array.from(this.reward, (value) => Number(value.toFixed(4))),
      seams: this.seams,
      trainedAt: this.trainedAt
    }
  }

  /** `null` for anything that is not a model this build can read. */
  static fromJSON(data: any): RLModel | null {
    if (!data || data.codename !== CODENAME || data.version !== RL_VERSION) return null
    // The columns are positional: a file written for different kinds or
    // transitions would be read into the wrong cells without complaint.
    const same = (a: unknown, b: readonly string[]) => Array.isArray(a) && a.length === b.length && a.every((value, index) => value === b[index])
    if (!same(data.categories, CATEGORIES) || !same(data.actions, ACTIONS)) return null
    if (!Array.isArray(data.plays) || data.plays.length !== K * K * A || !Array.isArray(data.reward) || data.reward.length !== K * K * A) return null
    if (!Array.isArray(data.centroids) || data.centroids.length !== K || data.centroids.some((row: unknown) => !Array.isArray(row) || row.length !== WIDTH || row.some((value) => !Number.isFinite(value)))) return null
    const model = new RLModel()
    model.centroids = data.centroids.map((row: number[]) => [...row])
    model.beats = Array.isArray(data.beats) && data.beats.length === K ? data.beats.map(Number) : model.beats
    model.plays = Float64Array.from(data.plays, (value) => Math.max(0, Number(value) || 0))
    model.reward = Float64Array.from(data.reward, (value) => Math.max(0, Number(value) || 0))
    model.seams = Number(data.seams) || 0
    model.trainedAt = Number(data.trainedAt) || null
    return model
  }

  /** A short public summary. */
  info() {
    const best: { exit: string; entry: string; effect: string; value: number; plays: number }[] = []
    for (let e = 0; e < K; e += 1) {
      for (let n = 0; n < K; n += 1) {
        if (this.evidence(CATEGORIES[e], CATEGORIES[n]) < 3) continue
        const top = this.rank(CATEGORIES[e], CATEGORIES[n], ACTIONS, { explore: 0 })[0]
        best.push({ exit: CATEGORIES[e], entry: CATEGORIES[n], effect: top.effect, value: top.value, plays: top.plays })
      }
    }
    return {
      codename: CODENAME,
      version: this.version,
      seams: this.seams,
      trainedAt: this.trainedAt,
      categories: CATEGORIES,
      beats: Object.fromEntries(CATEGORIES.map((name, index) => [name, this.beats[index]])),
      contexts: best.sort((x, y) => y.plays - x.plays).slice(0, 12)
    }
  }
}

/* --------------------------- the loaded model --------------------------- */

let active: RLModel | null = null
let loadedFrom: string | null = null

/** The model in use: the saved one, or an untrained one (the prototypes). */
export function rl(file = RL_FILE()): RLModel {
  if (active && loadedFrom === file) return active
  loadedFrom = file
  active = null
  try {
    active = RLModel.fromJSON(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    // No file yet, or not one of ours.
  }
  active ??= new RLModel()
  return active
}

export function saveRL(model: RLModel, file = RL_FILE()): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(model.toJSON()))
    fs.renameSync(temporary, file)
    if (loadedFrom === file) active = model
    return true
  } catch {
    return false
  }
}

/** Refit RL from a seam log, keep it if there was anything to learn. */
export function trainRL(records: SeamRecord[], { file = RL_FILE(), save = true }: any = {}) {
  const started = Date.now()
  const model = RLModel.train(records)
  const report = {
    codename: CODENAME,
    trained: model.seams > 0,
    seams: model.seams,
    logged: records.length,
    beats: model.beats.reduce((sum, value) => sum + value, 0),
    evaluation: model.seams >= 20 ? RLModel.evaluate(records) : null,
    saved: false,
    ms: 0
  }
  // A dry run (`save: false`) reports and changes nothing.
  if (model.seams > 0 && save) report.saved = saveRL(model, file)
  report.ms = Date.now() - started
  return report
}

/** Forget the loaded model (tests, and after the file is replaced). */
export function reloadRL() {
  active = null
  loadedFrom = null
}

export default rl
