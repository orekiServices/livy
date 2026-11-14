/**
 * The Infinite Jukebox, for a radio station.
 *
 * Paul Lamere's Infinite Jukebox (2012) plays a song for ever: every beat is
 * compared with every other, and wherever two beats sound alike the player
 * may step from one to the other instead of carrying on. The Forever Jukebox
 * (Creighton Linza) rebuilt it after Spotify retired the Echo Nest analysis
 * it depended on. This is the same graph and the same walk, built on the
 * analysis the node already does while a song streams (see `features.ts`,
 * `beats.ts`), and it has two jobs here:
 *
 *   • **Forever mode** — a station can hold one song on air indefinitely, and
 *     the song never reaches its ending;
 *   • **seams for the automix** — a beat with a good branch is, by
 *     construction, a place where the song can be left or re-entered without
 *     anyone noticing, which is exactly what a transition is looking for.
 *
 * The graph follows the original:
 *
 *   distance(a, b) = timbre·1 + pitch·10 + loudness-start·1 + loudness-max·1
 *                    + duration·100 + confidence·1, averaged over the parts of
 *                    the beat, plus 100 when the two beats are not at the same
 *                    position in the bar
 *
 * with up to four neighbours per beat under a threshold of 80, the threshold
 * itself chosen by sweeping up from 10 until a sixth of the beats can branch,
 * a best long backward branch added when none qualified, and a *last branch
 * point* the walk is never allowed past — that is what makes it infinite.
 *
 * One departure, and the reason for it: The Echo Nest's timbre and loudness
 * were on a fixed scale and the thresholds above are in its units. Features
 * computed here are not, so distances are rescaled per song so that the
 * median pair of beats in the same bar position is 100 apart. "Under 80"
 * then means what it meant: closer than a typical pair.
 */
import { CHROMA, TIMBRE } from './features.ts'
import { VECTOR, type BeatTrack } from './beats.ts'

export interface Edge {
  from: number
  to: number
  distance: number
}

export interface JukeboxGraph {
  beats: number
  /** Edges that survive the threshold, by source beat. */
  neighbours: Edge[][]
  threshold: number
  /** The beat the walk must branch at; -1 when the song cannot loop. */
  lastBranch: number
  /** How many beats can branch. */
  branching: number
  /** Longest backward branch, as a percentage of the song. */
  longestBackward: number
  /** The factor distances were multiplied by (see the note above). */
  scale: number
  engine: 'native' | 'typescript'
  /** Where the graph came from: a real analysis, or the node's own features. */
  source?: 'forever-jukebox' | 'local'
  /** Each beat's position in its bar, when the analysis knows it. */
  positions?: number[]
}

export interface JukeboxOptions {
  maxBranches?: number
  maxThreshold?: number
  /** Pin the threshold instead of sweeping for it. */
  threshold?: number
  /** Never branch to a beat closer than this many beats away. */
  minJump?: number
  addLastEdge?: boolean
  /** Most beats allowed to branch, as a fraction of the song. */
  maxBranching?: number
}

const WEIGHTS = { timbre: 1, pitch: 10, loudStart: 1, loudMax: 1, duration: 100, confidence: 1 }
const BAR_PENALTY = 100

/** The Infinite Jukebox segment distance between two beat vectors. */
export function beatDistance(vectors: Float32Array, a: number, b: number): number {
  const x = a * VECTOR
  const y = b * VECTOR
  let total = 0
  for (let half = 0; half < 2; half += 1) {
    let timbre = 0
    for (let k = 0; k < TIMBRE; k += 1) {
      const d = vectors[x + half * TIMBRE + k] - vectors[y + half * TIMBRE + k]
      timbre += d * d
    }
    let pitch = 0
    const c = 2 * TIMBRE + half * CHROMA
    for (let k = 0; k < CHROMA; k += 1) {
      const d = vectors[x + c + k] - vectors[y + c + k]
      pitch += d * d
    }
    const l = 2 * TIMBRE + 2 * CHROMA + half * 2
    total +=
      Math.sqrt(timbre) * WEIGHTS.timbre +
      Math.sqrt(pitch) * WEIGHTS.pitch +
      Math.abs(vectors[x + l] - vectors[y + l]) * WEIGHTS.loudStart +
      Math.abs(vectors[x + l + 1] - vectors[y + l + 1]) * WEIGHTS.loudMax
  }
  return (
    total / 2 +
    Math.abs(vectors[x + VECTOR - 2] - vectors[y + VECTOR - 2]) * WEIGHTS.duration +
    Math.abs(vectors[x + VECTOR - 1] - vectors[y + VECTOR - 1]) * WEIGHTS.confidence
  )
}

/**
 * The all-pairs kernel: for every beat, its nearest `limit` beats in the
 * same bar position, as `[from, to, distance]` triples, unscaled.
 *
 * This is the only part that is quadratic in the length of the song, and it
 * is the part `libmetro` implements natively (`jukeboxNeighbours` in
 * `native/libmetro/src/jukebox.rs`). Both produce the same triples; the
 * TypeScript one is the reference and the fallback.
 */
export function nearestNeighbours(vectors: Float32Array, bars: Uint8Array, limit: number): { triples: Float32Array; median: number } {
  const n = bars.length
  const out: number[] = []
  const sample: number[] = []
  const row = new Float32Array(n)
  for (let a = 0; a < n; a += 1) {
    const candidates: number[] = []
    for (let b = 0; b < n; b += 1) {
      if (b === a || bars[b] !== bars[a]) continue
      const distance = beatDistance(vectors, a, b)
      row[b] = distance
      candidates.push(b)
      // A thinned sample of all same-position pairs, for the scale.
      if (((a * 31 + b * 17) & 7) === 0) sample.push(distance)
    }
    candidates.sort((p, q) => row[p] - row[q])
    for (let k = 0; k < limit && k < candidates.length; k += 1) out.push(a, candidates[k], row[candidates[k]])
  }
  sample.sort((p, q) => p - q)
  return { triples: Float32Array.from(out), median: sample.length ? sample[sample.length >> 1] : 0 }
}

type NativeKernel = (vectors: Float32Array, width: number, bars: Uint8Array, limit: number) => { triples: Float32Array; median: number }
let nativeKernel: NativeKernel | null = null

/** Let the host hand over libmetro's kernel when the binary has one. */
export function useNativeKernel(kernel: NativeKernel | null) {
  nativeKernel = kernel
}

/** Build the branch graph for a tracked song. */
export function buildGraph(track: BeatTrack, options: JukeboxOptions = {}): JukeboxGraph {
  const n = track.beats.length
  const maxBranches = options.maxBranches ?? 4
  const maxThreshold = options.maxThreshold ?? 80
  const minJump = Math.max(2, options.minJump ?? 2)
  const empty: JukeboxGraph = { beats: n, neighbours: [], threshold: 0, lastBranch: -1, branching: 0, longestBackward: 0, scale: 1, engine: 'typescript' }
  if (n < 16) return empty

  const bars = Uint8Array.from(track.beats, (beat) => beat.bar)
  // Ask for a few more than will be kept: the ones too close to the source
  // (a beat is always most like its neighbours in the same bar) are dropped.
  const wanted = maxBranches + 6
  let kernel: { triples: Float32Array; median: number } | null = null
  let engine: JukeboxGraph['engine'] = 'typescript'
  if (nativeKernel) {
    try {
      kernel = nativeKernel(track.vectors, VECTOR, bars, wanted)
      engine = 'native'
    } catch {
      kernel = null
    }
  }
  kernel ??= nearestNeighbours(track.vectors, bars, wanted)
  const scale = kernel.median > 0 ? 100 / kernel.median : 1

  const all: Edge[][] = Array.from({ length: n }, () => [])
  for (let i = 0; i < kernel.triples.length; i += 3) {
    const from = kernel.triples[i]
    const to = kernel.triples[i + 1]
    const distance = kernel.triples[i + 2] * scale
    if (Math.abs(to - from) < minJump) continue
    if (distance >= maxThreshold) continue
    if (all[from].length < maxBranches) all[from].push({ from, to, distance })
  }

  const collect = (threshold: number) => {
    const neighbours = all.map((edges) => edges.filter((edge) => edge.distance <= threshold))
    return { neighbours, count: neighbours.reduce((sum, edges) => sum + (edges.length ? 1 : 0), 0) }
  }

  // Sweep: the lowest threshold at which a sixth of the song can branch.
  let threshold = options.threshold ?? 0
  let chosen = collect(threshold || maxThreshold)
  if (!options.threshold) {
    for (threshold = 10; threshold < maxThreshold; threshold += 5) {
      chosen = collect(threshold)
      if (chosen.count >= n / 6) break
    }
  }
  const neighbours = chosen.neighbours

  const longest = () => {
    let best = 0
    for (let i = 0; i < n; i += 1) for (const edge of neighbours[i]) best = Math.max(best, i - edge.to)
    return (best * 100) / n
  }

  // A song whose only branches are short hops never gets back to its start.
  // Add the longest backward branch on offer, even above the threshold.
  if (options.addLastEdge !== false) {
    const ceiling = longest() < 50 ? 65 : 55
    let best: Edge | null = null
    for (let i = 0; i < n; i += 1) {
      for (const edge of all[i]) {
        if (edge.to >= i || edge.distance >= ceiling) continue
        if (!best || i - edge.to > best.from - best.to) best = edge
      }
    }
    if (best && best.distance > threshold && !neighbours[best.from].includes(best)) neighbours[best.from].push(best)
  }

  // A song built from one loop matches itself everywhere, even at the lowest
  // threshold, and then every beat is a branch: it stops sounding like the
  // song. Keep the closest-sounding quarter.
  const cap = Math.max(4, Math.floor(n * (options.maxBranching ?? 0.25)))
  const branchingNow = neighbours.reduce((sum, edges) => sum + (edges.length ? 1 : 0), 0)
  if (branchingNow > cap) {
    const far = (i: number) => Math.max(...neighbours[i].map((edge) => Math.abs(i - edge.to)))
    const near = (i: number) => Math.min(...neighbours[i].map((edge) => edge.distance))
    // A long way to go counts for as much as sounding alike: without the
    // long branches the song never gets back to its beginning.
    const order = [...neighbours.keys()].filter((i) => neighbours[i].length).sort((x, y) => near(x) - (far(x) / n) * 20 - (near(y) - (far(y) / n) * 20))
    for (const i of order.slice(cap)) neighbours[i] = []
  }

  // Reachability: how much of the song can still be reached from each beat.
  const reach = new Int32Array(n)
  for (let i = 0; i < n; i += 1) reach[i] = n - i
  for (let pass = 0; pass < 1000; pass += 1) {
    let changed = false
    for (let i = n - 1; i >= 0; i -= 1) {
      let best = reach[i]
      for (const edge of neighbours[i]) best = Math.max(best, reach[edge.to])
      if (i + 1 < n) best = Math.max(best, reach[i + 1])
      if (best > reach[i]) {
        reach[i] = best
        changed = true
      }
    }
    if (!changed) break
  }

  // The last branch point: the latest beat that can still get far back.
  let lastBranch = -1
  let longestReach = 0
  for (let i = n - 1; i >= 0; i -= 1) {
    if (!neighbours[i].some((edge) => edge.to < i)) continue
    const value = ((reach[i] - (n - i)) * 100) / n
    if (value > longestReach) {
      longestReach = value
      lastBranch = i
      if (value >= 50) break
    }
  }

  // Branches that jump *past* the last branch point lead to the ending.
  if (lastBranch >= 0) {
    for (let i = 0; i < n; i += 1) {
      if (i === lastBranch) neighbours[i] = neighbours[i].filter((edge) => edge.to < i)
      else neighbours[i] = neighbours[i].filter((edge) => edge.to < lastBranch)
    }
  }

  return {
    beats: n,
    neighbours,
    threshold,
    lastBranch,
    branching: neighbours.reduce((sum, edges) => sum + (edges.length ? 1 : 0), 0),
    longestBackward: Number(longest().toFixed(1)),
    scale,
    engine
  }
}

/** The beat most like `beat` that lies at least `minBack` beats before it. */
export function bestBackward(track: BeatTrack, beat: number, minBack = 8): Edge | null {
  let best: Edge | null = null
  for (let other = 0; other <= beat - minBack; other += 1) {
    if (track.beats[other].bar !== track.beats[beat].bar) continue
    const distance = beatDistance(track.vectors, beat, other)
    if (!best || distance < best.distance) best = { from: beat, to: other, distance }
  }
  return best
}

export interface Step {
  /** The beat that plays next. */
  beat: number
  /** Set when this step is a branch rather than the next beat in the song. */
  jumped: Edge | null
}

/**
 * The walk. After each beat the next one in the song is the *seed*; if the
 * seed has neighbours, the walk may play one of them instead. The chance
 * starts at 18 %, grows by 2 points a beat and resets when a branch is taken
 * — so branches are neither bunched nor rare — and at the last branch point
 * it is certain.
 */
export class JukeboxWalker {
  #chance: number
  #random: () => number
  #turn = new Map<number, number>()
  branches = 0
  steps = 0

  constructor(
    readonly graph: JukeboxGraph,
    { random = Math.random, minChance = 0.18, maxChance = 0.5, chanceDelta = 0.02, minGap = 8 }: { random?: () => number; minChance?: number; maxChance?: number; chanceDelta?: number; minGap?: number } = {}
  ) {
    this.minGap = minGap
    this.#random = random
    this.minChance = minChance
    this.maxChance = maxChance
    this.chanceDelta = chanceDelta
    this.#chance = minChance
  }

  /** Beats that must play between two branches (the last branch excepted). */
  minGap: number
  #since = Infinity
  minChance: number
  maxChance: number
  chanceDelta: number

  /** What plays after `beat`. `null` when the song simply ends. */
  next(beat: number): Step | null {
    const seed = beat + 1
    this.steps += 1
    const { graph } = this
    if (seed >= graph.beats) return null
    const edges = graph.neighbours[seed] ?? []
    this.#since += 1
    if (edges.length === 0) return { beat: seed, jumped: null }

    let branch = seed === graph.lastBranch
    if (!branch && this.#since > this.minGap) {
      this.#chance = Math.min(this.maxChance, this.#chance + this.chanceDelta)
      branch = this.#random() < this.#chance
    }
    if (!branch) return { beat: seed, jumped: null }

    this.#chance = this.minChance
    this.#since = 0
    // Round-robin over the seed's branches, as the original does: the same
    // beat does not always lead to the same place.
    const turn = this.#turn.get(seed) ?? 0
    this.#turn.set(seed, turn + 1)
    const edge = edges[turn % edges.length]
    this.branches += 1
    return { beat: edge.to, jumped: edge }
  }
}

export default buildGraph
