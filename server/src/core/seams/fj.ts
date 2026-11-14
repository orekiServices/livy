/**
 * Forever Jukebox: the analysis, the graph, and the client that fetches them.
 *
 * The Infinite Jukebox (Paul Lamere, 2012) needed Echo Nest analysis of every
 * song: beats, tatums, bars, and for each segment a timbre vector, a
 * twelve-bin pitch vector and a loudness curve. Spotify retired that in
 * November 2024. The Forever Jukebox (Creighton Linza) replaced it by
 * generating the same shape of analysis locally, and serves it over a small
 * REST API at foreverjukebox.com:
 *
 *   GET /api/jobs/by-track?title=&artist=   the job for a track, if known
 *   GET /api/analysis/{job_id}              its analysis, or its progress
 *
 * This module speaks that API, normalises what comes back into the quanta the
 * Infinite Jukebox's own graph is built from, and builds that graph. It is
 * deliberately separate from `jukebox.ts`, which keeps the walk and the frame
 * seams: the graph here is the real one, on the real segments, and the graph
 * there is the same algorithm run on the node's own features when no analysis
 * can be had.
 *
 * The distances are the original's, in the original's units:
 *
 *   timbre·1 + pitch·10 + loudness-start·1 + loudness-max·1
 *   + duration·100 + confidence·1
 *
 * averaged over the segments a beat overlaps, plus 100 when the two beats do
 * not sit at the same position in the bar. Segments that are not the same
 * segment count as 100, which is why a beat only ever matches a beat that
 * actually sounds like it.
 */
import fs from 'node:fs'
import path from 'node:path'

import { paths } from '../../config.ts'
import createLogger from '../../util/logger.ts'
import type { Beat, BeatTrack } from './beats.ts'
import type { Edge, JukeboxGraph, JukeboxOptions } from './jukebox.ts'

const log = createLogger('forever-jukebox')

/* ------------------------------- analysis ------------------------------- */

export interface FjSegment {
  start: number
  duration: number
  confidence: number
  loudness_start: number
  loudness_max: number
  loudness_max_time: number
  pitches: number[]
  timbre: number[]
}

export interface FjQuantum {
  start: number
  duration: number
  confidence: number
  /** Position within the bar (beats) or within the section (bars). */
  indexInParent?: number
  /** The segments this quantum sounds like, for a beat. */
  overlappingSegments: FjSegment[]
}

export interface FjAnalysis {
  track: {
    title?: string
    artist?: string
    /** Seconds. */
    duration?: number
    tempo?: number
    time_signature?: number
  }
  beats: FjQuantum[]
  bars: FjQuantum[]
  tatums: FjQuantum[]
  sections: FjQuantum[]
  segments: FjSegment[]
  /** `forever-jukebox`, `echo-nest`, or whatever the payload said. */
  origin?: string
  engineVersion?: number
}

const num = (value: unknown, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback)
const numbers = (value: unknown, length: number): number[] => {
  const list = Array.isArray(value) ? value : []
  const out = new Array<number>(length).fill(0)
  for (let i = 0; i < Math.min(length, list.length); i += 1) out[i] = num(list[i])
  return out
}

function parseQuanta(value: unknown): FjQuantum[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const q = (item ?? {}) as Record<string, unknown>
    return {
      start: num(q.start),
      duration: num(q.duration, 0.25),
      confidence: num(q.confidence),
      overlappingSegments: []
    }
  })
}

function parseSegments(value: unknown): FjSegment[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const s = (item ?? {}) as Record<string, unknown>
    return {
      start: num(s.start),
      duration: num(s.duration),
      confidence: num(s.confidence),
      loudness_start: num(s.loudness_start, -60),
      loudness_max: num(s.loudness_max, -60),
      loudness_max_time: num(s.loudness_max_time),
      pitches: numbers(s.pitches, 12),
      timbre: numbers(s.timbre, 12)
    }
  })
}

/** Index every child by where it sits inside its parent (bar position, etc). */
function connect(parents: FjQuantum[], children: FjQuantum[]) {
  let last = 0
  for (const parent of parents) {
    let index = 0
    for (let j = last; j < children.length; j += 1) {
      const child = children[j]
      if (child.start >= parent.start && child.start < parent.start + parent.duration) {
        child.indexInParent = index
        index += 1
        last = j
      } else if (child.start > parent.start) {
        break
      }
    }
  }
}

/** The segments each beat overlaps. This is what a beat sounds like. */
function connectSegments(quanta: FjQuantum[], segments: FjSegment[]) {
  let last = 0
  for (const q of quanta) {
    q.overlappingSegments = []
    const end = q.start + q.duration
    for (let j = last; j < segments.length; j += 1) {
      const seg = segments[j]
      if (seg.start + seg.duration < q.start) continue
      if (seg.start > end) break
      last = j
      q.overlappingSegments.push(seg)
    }
  }
}

/**
 * Read whatever the API returned into one shape.
 *
 * The payload is the Spotify analysis shape, sometimes nested under
 * `analysis`. Anything missing is empty rather than fatal: a track with beats
 * and no segments still has a graph, it just cannot branch.
 */
export function normaliseFjAnalysis(raw: unknown): FjAnalysis | null {
  if (!raw || typeof raw !== 'object') return null
  const root = raw as Record<string, unknown>
  const inner = (root.analysis && typeof root.analysis === 'object' ? root.analysis : root) as Record<string, unknown>

  const beats = parseQuanta(inner.beats)
  const bars = parseQuanta(inner.bars)
  const tatums = parseQuanta(inner.tatums)
  const sections = parseQuanta(inner.sections)
  const segments = parseSegments(inner.segments)
  if (beats.length < 8) return null

  connect(sections, bars)
  connect(bars, beats)
  connect(beats, tatums)
  connectSegments(beats, segments)

  const meta = (inner.track ?? root.track ?? {}) as Record<string, unknown>
  return {
    track: {
      title: meta.title ? String(meta.title) : undefined,
      artist: meta.artist ? String(meta.artist) : undefined,
      duration: Number.isFinite(Number(meta.duration)) ? Number(meta.duration) : undefined,
      tempo: Number.isFinite(Number(meta.tempo)) ? Number(meta.tempo) : undefined,
      time_signature: Number.isFinite(Number(meta.time_signature)) ? Number(meta.time_signature) : undefined
    },
    beats,
    bars,
    tatums,
    sections,
    segments,
    origin: inner.engine_origin ? String(inner.engine_origin) : root.source ? 'forever-jukebox' : undefined,
    engineVersion: Number.isFinite(Number(inner.engine_version)) ? Number(inner.engine_version) : undefined
  }
}

/* --------------------------------- graph --------------------------------- */

/** The Infinite Jukebox's weights, unchanged from 2012. */
const WEIGHTS = { timbre: 1, pitch: 10, loudStart: 1, loudMax: 1, duration: 100, confidence: 1 }
const BAR_PENALTY = 100
const SEGMENT_MISMATCH = 100
/** Edges are precalculated only this far out; a threshold never exceeds it. */
export const MAX_THRESHOLD = 80
/** The sweep starts here (FJ's `computeDefaultThreshold`). */
const SWEEP_FROM = 10
const SWEEP_STEP = 5
/** One beat in six should be able to branch, or the song is not self-similar. */
const TARGET_BRANCH_FRACTION = 6

function euclidean(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) {
    const delta = (b[i] ?? 0) - (a[i] ?? 0)
    sum += delta * delta
  }
  return Math.sqrt(sum)
}

/** How different two overlapping segments are, in Echo Nest units. */
export function segmentDistance(a: FjSegment, b: FjSegment): number {
  return (
    euclidean(a.timbre, b.timbre) * WEIGHTS.timbre +
    euclidean(a.pitches, b.pitches) * WEIGHTS.pitch +
    Math.abs(a.loudness_start - b.loudness_start) * WEIGHTS.loudStart +
    Math.abs(a.loudness_max - b.loudness_max) * WEIGHTS.loudMax +
    Math.abs(a.duration - b.duration) * WEIGHTS.duration +
    Math.abs(a.confidence - b.confidence) * WEIGHTS.confidence
  )
}

/** The branch distance between two beats: what they sound like, and where they sit. */
export function beatPairDistance(a: FjQuantum, b: FjQuantum): number {
  if (!a.overlappingSegments.length) return Number.POSITIVE_INFINITY
  let sum = 0
  for (let j = 0; j < a.overlappingSegments.length; j += 1) {
    const first = a.overlappingSegments[j]
    let distance = SEGMENT_MISMATCH
    const second = b.overlappingSegments[j]
    if (second && first !== second) distance = segmentDistance(first, second)
    sum += distance
  }
  const positional = a.indexInParent !== undefined && a.indexInParent === b.indexInParent ? 0 : BAR_PENALTY
  return sum / a.overlappingSegments.length + positional
}

/** 100 at distance 0, 0 at the ceiling. This is what the console shows. */
export function matchPercent(distance: number, threshold = MAX_THRESHOLD): number {
  if (!Number.isFinite(distance)) return 0
  return Math.round(Math.max(0, 1 - distance / threshold) * 100)
}

export type MatchQuality = 'good' | 'fair' | 'poor'

export function matchQuality(percent: number, sameBarPosition: boolean): MatchQuality {
  if (sameBarPosition && percent >= 50) return 'good'
  if (sameBarPosition && percent >= 25) return 'fair'
  return 'poor'
}

/**
 * The nearest neighbours of every beat, precalculated out to the ceiling.
 *
 * Four per beat, as the original: enough for the walk to have a choice,
 * few enough that the graph stays a graph rather than a mesh.
 */
function nearestNeighbours(beats: FjQuantum[], maxBranches: number): Edge[][] {
  const all: Edge[][] = beats.map(() => [])
  for (let i = 0; i < beats.length; i += 1) {
    const found: Edge[] = []
    for (let j = 0; j < beats.length; j += 1) {
      if (i === j) continue
      const distance = beatPairDistance(beats[i], beats[j])
      if (distance < MAX_THRESHOLD) found.push({ from: i, to: j, distance })
    }
    found.sort((a, b) => a.distance - b.distance)
    all[i] = found.slice(0, maxBranches)
  }
  return all
}

/** Sweep the threshold up until a sixth of the beats can branch. */
export function defaultThreshold(edges: Edge[][], beats: number): number {
  const target = beats / TARGET_BRANCH_FRACTION
  for (let t = SWEEP_FROM; t < MAX_THRESHOLD; t += SWEEP_STEP) {
    let branching = 0
    for (const row of edges) if (row.some((edge) => edge.distance <= t)) branching += 1
    if (branching >= target) return t
  }
  return MAX_THRESHOLD
}

/**
 * The last beat the walk may reach before it must branch.
 *
 * The original computes it by asking "from here, can I get back to myself?",
 * which is a reachability question, not a distance one. The earliest beat each
 * beat can reach is propagated backwards until it stops changing; the last
 * beat that can still arrive somewhere earlier than itself is the last branch
 * point. Past it, the song can only end.
 */
export function lastBranchPoint(neighbours: Edge[][]): number {
  const n = neighbours.length
  if (!n) return -1
  const earliest = neighbours.map((_, i) => i)
  for (let pass = 0; pass < n; pass += 1) {
    let changed = false
    for (let i = n - 1; i >= 0; i -= 1) {
      let best = earliest[i]
      if (i + 1 < n && earliest[i + 1] < best) best = earliest[i + 1]
      for (const edge of neighbours[i]) {
        if (earliest[edge.to] < best) best = earliest[edge.to]
      }
      if (best < earliest[i]) {
        earliest[i] = best
        changed = true
      }
    }
    if (!changed) break
  }
  for (let i = n - 1; i >= 0; i -= 1) {
    for (const edge of neighbours[i]) {
      if (edge.to < i && earliest[edge.to] < i) return i
    }
  }
  return -1
}

/**
 * Build the graph from a real analysis.
 *
 * `minJump` drops edges to beats that are right next door, which is the
 * difference between a loop and a stutter.
 */
export function graphFromFjAnalysis(analysis: FjAnalysis, options: JukeboxOptions = {}): JukeboxGraph {
  const beats = analysis.beats
  const maxBranches = Math.max(1, Math.min(8, options.maxBranches ?? 4))
  const all = nearestNeighbours(beats, maxBranches)
  const threshold = options.threshold ?? defaultThreshold(all, beats.length)
  const minJump = Math.max(0, options.minJump ?? 0)

  const neighbours: Edge[][] = all.map((row) => row.filter((edge) => edge.distance <= threshold && Math.abs(edge.to - edge.from) >= minJump))

  let branching = 0
  let longest = 0
  for (let i = 0; i < neighbours.length; i += 1) {
    if (neighbours[i].length) branching += 1
    for (const edge of neighbours[i]) longest = Math.max(longest, i - edge.to)
  }

  return {
    beats: beats.length,
    neighbours,
    threshold,
    lastBranch: lastBranchPoint(neighbours),
    branching,
    longestBackward: (longest * 100) / Math.max(1, beats.length),
    scale: 1,
    engine: 'typescript',
    source: 'forever-jukebox',
    positions: beats.map((beat) => beat.indexInParent ?? 0)
  }
}

/**
 * A Forever Jukebox analysis, in the shape the rest of the seam machinery
 * speaks.
 *
 * `bar` is the real position in the bar, which is the one thing the node's own
 * beat tracker only guesses at: FJ knows where the bar starts. `vectors` is
 * empty on purpose — a beat from this analysis already carries its segments,
 * so the graph has the real distance and the vector fallback has nothing to
 * say. `ForeverJukebox` checks before using it.
 */
export function beatTrackFromFj(analysis: FjAnalysis): BeatTrack {
  const beats: Beat[] = analysis.beats.map((beat, index) => {
    const segment = beat.overlappingSegments[0]
    const loudMax = segment ? segment.loudness_max : -60
    return {
      index,
      from: 0,
      to: 0,
      start: beat.start,
      duration: beat.duration,
      bar: beat.indexInParent ?? index % 4,
      confidence: beat.confidence,
      loudStart: segment ? segment.loudness_start : -60,
      loudMax,
      level: loudMax,
      low: 0,
      high: 0,
      vocal: 0,
      onset: 0
    }
  })
  return {
    bpm: analysis.track.tempo ?? 0,
    period: 0,
    confidence: 0,
    beats,
    vectors: new Float32Array(0),
    engine: 'forever-jukebox'
  } as unknown as BeatTrack
}

/** Where a beat is in the song's own time, in milliseconds. */
export function beatMs(analysis: FjAnalysis, index: number): number {
  const beat = analysis.beats[index]
  return beat ? Math.round(beat.start * 1000) : 0
}

/* -------------------------------- client -------------------------------- */

export const DEFAULT_FJ_API = 'https://foreverjukebox.com'

export interface FjClientOptions {
  /** Base URL of an instance. Defaults to `LIVY_FJ_API`, then the public one. */
  baseUrl?: string
  /** Where analyses are cached. A node on a read-only disk simply does not cache. */
  cacheDir?: string
  timeoutMs?: number
  /** Ignore a cached analysis older than this. */
  maxAgeMs?: number
  /** Reject an analysis whose track is not this close to ours, in ms. */
  durationToleranceMs?: number
}

export interface FjClientInfo {
  baseUrl: string
  enabled: boolean
  cached: number
  hits: number
  misses: number
  failures: number
  lastError: string | null
  lastMs: number | null
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)

/**
 * A client for one Forever Jukebox instance.
 *
 * Failures are ordinary: an instance may not be configured, may not know the
 * track, may be mid-analysis (202) or down. Every one of them returns null and
 * the caller falls back to the node's own analysis, so Forever mode never
 * depends on a third party being reachable.
 */
export class FjClient {
  readonly baseUrl: string
  readonly cacheDir: string | null
  readonly timeoutMs: number
  readonly maxAgeMs: number
  readonly durationToleranceMs: number
  #hits = 0
  #misses = 0
  #failures = 0
  #lastError: string | null = null
  #lastMs: number | null = null

  constructor(options: FjClientOptions = {}) {
    const configured = options.baseUrl ?? process.env.LIVY_FJ_API ?? DEFAULT_FJ_API
    this.baseUrl = String(configured).replace(/\/$/, '')
    this.cacheDir = options.cacheDir ?? (paths?.data ? path.join(paths.data, 'fj') : null)
    this.timeoutMs = options.timeoutMs ?? 4000
    this.maxAgeMs = options.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000
    this.durationToleranceMs = options.durationToleranceMs ?? 8000
  }

  get enabled() {
    return Boolean(this.baseUrl && this.baseUrl !== 'off' && !/^(off|none|disabled)$/i.test(this.baseUrl))
  }

  info(): FjClientInfo {
    return {
      baseUrl: this.baseUrl,
      enabled: this.enabled,
      cached: this.cachedCount(),
      hits: this.#hits,
      misses: this.#misses,
      failures: this.#failures,
      lastError: this.#lastError,
      lastMs: this.#lastMs
    }
  }

  cachedCount(): number {
    if (!this.cacheDir) return 0
    try {
      return fs.readdirSync(this.cacheDir).filter((name) => name.endsWith('.json')).length
    } catch {
      return 0
    }
  }

  #file(track: { title?: string; artist?: string }) {
    if (!this.cacheDir) return null
    const name = `${slug(String(track.artist ?? ''))}--${slug(String(track.title ?? ''))}.json`
    return name === '--.json' ? null : path.join(this.cacheDir, name)
  }

  #readCached(track: { title?: string; artist?: string }): FjAnalysis | null {
    const file = this.#file(track)
    if (!file) return null
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (Date.now() - Number(parsed?.at ?? 0) > this.maxAgeMs) return null
      return normaliseFjAnalysis(parsed?.analysis)
    } catch {
      return null
    }
  }

  #writeCached(track: { title?: string; artist?: string }, analysis: FjAnalysis) {
    const file = this.#file(track)
    if (!file) return
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ at: Date.now(), track, analysis }))
    } catch (error: any) {
      log.debug(`could not cache an analysis: ${error.message}`)
    }
  }

  async #get(pathname: string): Promise<any> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${pathname}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' }
      })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * The analysis for a track, from the instance or from cache.
   *
   * `durationMs` is the node's own idea of how long the audio is. An analysis
   * of the same song from a different recording (a radio edit, a live take, a
   * video rip) has its beats in the wrong places, and using it would cut the
   * seams somewhere the listener can hear. Beyond a few seconds of difference
   * the analysis is not ours and is refused.
   */
  async analysisFor(track: { title?: string; artist?: string; durationMs?: number; duration?: number }): Promise<FjAnalysis | null> {
    if (!this.enabled) return null
    const title = String(track?.title ?? '').trim()
    const artist = String(track?.artist ?? '').trim()
    if (!title || !artist) return null

    const cached = this.#readCached({ title, artist })
    if (cached && this.#durationOk(cached, track)) {
      this.#hits += 1
      return cached
    }

    const started = Date.now()
    try {
      const job = await this.#get(`/api/jobs/by-track?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`)
      const id = job?.id ?? job?.job_id ?? job?.result?.id ?? null
      if (!id) {
        this.#misses += 1
        this.#lastMs = Date.now() - started
        return null
      }
      const body = await this.#get(`/api/analysis/${encodeURIComponent(id)}`)
      const analysis = normaliseFjAnalysis(body?.result ?? body?.analysis ?? body)
      if (!analysis) {
        this.#misses += 1
        this.#lastMs = Date.now() - started
        return null
      }
      if (!this.#durationOk(analysis, track)) {
        this.#lastError = `analysis is for a different recording of "${title}"`
        this.#misses += 1
        this.#lastMs = Date.now() - started
        return null
      }
      this.#writeCached({ title, artist }, analysis)
      this.#hits += 1
      this.#lastError = null
      this.#lastMs = Date.now() - started
      log.info(`forever-jukebox: "${artist} – ${title}" analysed (${analysis.beats.length} beats)`)
      return analysis
    } catch (error: any) {
      this.#failures += 1
      this.#lastError = error?.name === 'AbortError' ? `no answer in ${this.timeoutMs} ms` : String(error?.message ?? error)
      this.#lastMs = Date.now() - started
      log.debug(`forever-jukebox miss for "${title}": ${this.#lastError}`)
      return null
    }
  }

  #durationOk(analysis: FjAnalysis, track: { durationMs?: number; duration?: number }) {
    // Livy tracks store `duration` in milliseconds; accept seconds too when a
    // caller passes a small bare number.
    const raw = track?.duration
    const fromDuration = raw ? (raw > 3600 ? raw : raw * 1000) : 0
    const mine = track?.durationMs ?? fromDuration
    const theirs = analysis?.track?.duration ? analysis.track.duration * 1000 : 0
    if (!mine || !theirs) return true
    return Math.abs(mine - theirs) <= this.durationToleranceMs
  }
}

let shared: FjClient | null = null

/** The node's one client; `LIVY_FJ_API=off` turns it off entirely. */
export function fjClient(options?: FjClientOptions): FjClient {
  if (options) return new FjClient(options)
  shared ??= new FjClient()
  return shared
}
