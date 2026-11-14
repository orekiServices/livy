/**
 * Forever — the Infinite Jukebox, on a radio transmitter.
 *
 * The original (Paul Lamere, 2012) plays a song beat by beat in a browser
 * and, at beats that sound like other beats, sometimes jumps. A browser can
 * schedule any sample it likes. A station sends MP3 frames it did not encode,
 * so here a jump is a *seam*: the frames up to the jump go out as they are,
 * a handful are re-encoded to carry the cut, and the song's own frames take
 * over again at the destination. Listeners stay connected; the stream never
 * restarts.
 *
 * A beat does not start on a frame boundary, and two beats do not start at
 * the same place within their frames. The destination is honoured exactly —
 * the downbeat the listener lands on is the real one — and the exit moves by
 * the difference, at most half a frame (13 ms at 44.1 kHz), so the audio
 * after the jump falls back onto the file's own frame grid.
 */
import { codec, codecKey, decodeFrames } from '../../util/codec.js'
import { parseFrameHeader } from '../../util/mp3.js'
import { LEAD_FRAMES, bridge, reservoirBefore } from '../../util/splice.ts'
import type { BeatTrack } from './beats.ts'
import { JukeboxWalker, bestBackward, type JukeboxGraph, type Edge } from './jukebox.ts'

/** The loosest match a forced way back may be (the graph's own ceiling). */
const LAST_RESORT = 80

/** Frames decoded ahead of the ones wanted, to settle the decoder. */
const RUN_UP = 3
/** Half the length of the cross-fade at a jump, in samples at 44.1 kHz. */
const HALF_FADE = 384

export interface Jump {
  fromBeat: number
  toBeat: number
  fromMs: number
  toMs: number
  distance: number
  /** How far the exit moved to land on the frame grid, in samples. */
  nudge: number
  /** How alike the two beats are, 0–100, on the graph's own scale. */
  percent?: number
  /** `good` when they share a bar position and sound close, down to `poor`. */
  quality?: 'good' | 'fair' | 'poor'
  /** Where each beat sat in its bar, when the analysis knows. */
  fromBar?: number
  toBar?: number
}

export interface Segment {
  frames: Buffer[]
  jump: Jump | null
  /** The song ran out: nothing more will come. */
  ended: boolean
}

export interface ForeverOptions {
  frames: Buffer[]
  track: BeatTrack
  graph: JukeboxGraph
  /** Frame to start from. */
  cursor?: number
  random?: () => number
  minChance?: number
  maxChance?: number
  chanceDelta?: number
  /** Most frames handed back per `next()` when nothing is happening. */
  chunk?: number
}

export class ForeverJukebox {
  readonly frames: Buffer[]
  readonly track: BeatTrack
  readonly graph: JukeboxGraph
  readonly sampleRate: number
  readonly spf: number
  readonly bitrate: number
  /** The next frame of the song that has not been handed out. */
  cursor: number
  jumps = 0
  failures = 0
  /** Stop branching and let the song finish. */
  home = false

  #walker: JukeboxWalker
  #starts: number[]
  #chunk: number
  /** The beat the walker has decided about up to (exclusive). */
  #decided = -1
  #plan: { at: number; edge: Edge } | null = null
  #forced = false

  constructor(options: ForeverOptions) {
    this.frames = options.frames
    this.track = options.track
    this.graph = options.graph
    const header = parseFrameHeader(this.frames[0], 0)
    this.sampleRate = header?.sampleRate ?? 44_100
    this.spf = header?.samples ?? 1152
    this.bitrate = Math.max(96, Math.min(320, header?.bitrate ?? 128))
    this.cursor = Math.max(0, options.cursor ?? 0)
    this.#chunk = options.chunk ?? 40
    this.#walker = new JukeboxWalker(this.graph, options)
    this.#starts = this.track.beats.map((beat) => Math.round(beat.start * this.sampleRate))
  }

  get walker() {
    return this.#walker
  }

  /** Can this song loop at all from where it is? */
  get possible() {
    return this.graph.lastBranch >= 0 && this.#wayBack() !== null
  }

  /**
   * The best way back from somewhere ahead of the cursor: a branch of the
   * graph if one is left, and otherwise the closest-sounding earlier beat —
   * a station takes over near the end of a song, often past the last branch.
   */
  #wayBack(): { at: number; edge: Edge } | null {
    const n = this.#starts.length
    const first = this.#firstBeatAfter(this.cursor)
    // Going a long way back counts for as much as sounding alike.
    const cost = (at: number, edge: Edge) => edge.distance - ((at - edge.to) / n) * 20
    let best: { at: number; edge: Edge } | null = null
    for (let beat = first; beat < n; beat += 1) {
      for (const edge of this.graph.neighbours[beat] ?? []) {
        if (edge.to >= beat) continue
        if (!best || cost(beat, edge) < cost(best.at, best.edge)) best = { at: beat, edge }
      }
    }
    if (best) return best
    // Beats from a Forever Jukebox analysis carry their own segments, so there
    // is no vector to fall back on: with no branch there is no way back.
    if (!this.track.vectors?.length) return null
    for (let beat = first; beat < n; beat += 1) {
      const raw = bestBackward(this.track, beat)
      if (!raw) continue
      const edge = { ...raw, distance: raw.distance * this.graph.scale }
      if (edge.distance > LAST_RESORT) continue
      if (!best || edge.distance < best.edge.distance) best = { at: beat, edge }
    }
    return best
  }

  /** Milliseconds of song at the cursor. */
  get positionMs() {
    return ((this.cursor * this.spf) / this.sampleRate) * 1000
  }

  /** The first beat a jump could leave from, given what has already aired. */
  #firstBeatAfter(frame: number) {
    const earliest = (frame + LEAD_FRAMES + 1) * this.spf + HALF_FADE * 2
    let low = 0
    let high = this.#starts.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (this.#starts[middle] < earliest) low = middle + 1
      else high = middle
    }
    return low
  }

  /** Decide where the next jump is, walking beat by beat from the cursor. */
  #makePlan() {
    if (this.#plan || this.home) return
    let beat = Math.max(this.#firstBeatAfter(this.cursor), this.#decided)
    const horizon = this.#starts.length
    while (beat < horizon) {
      const step = this.#walker.next(beat - 1)
      this.#decided = beat + 1
      if (!step) return
      if (step.jumped) {
        this.#plan = { at: beat, edge: step.jumped }
        return
      }
      beat += 1
    }
  }

  /** The walk ran off the end without branching: take the best way back. */
  #forcePlan() {
    if (this.#plan || this.home || this.#forced) return
    this.#forced = true
    this.#plan = this.#wayBack()
  }

  /** The next stretch of audio: untouched frames, or untouched frames and a jump. */
  async next(): Promise<Segment> {
    const total = this.frames.length
    if (this.cursor >= total) return { frames: [], jump: null, ended: true }
    this.#makePlan()
    if (!this.#plan && this.#decided >= this.#starts.length) this.#forcePlan()

    const plan = this.#plan
    if (!plan) return this.#straight(total)

    const { spf } = this
    const half = Math.round((HALF_FADE * this.sampleRate) / 44_100)
    const exit = this.#starts[plan.at]
    const entry = this.#starts[plan.edge.to]
    // Lead frames, then one more whole frame of untouched audio, then the cut.
    const lead = Math.floor((exit - half - spf / 2) / spf) - (LEAD_FRAMES + 1)
    if (lead > this.cursor + this.#chunk) return this.#straight(lead - this.#chunk / 2)

    this.#plan = null
    const resume = Math.floor(entry / spf) + 3
    if (lead < this.cursor || entry - half < RUN_UP * spf || resume + 3 >= total) {
      // Too close to what has aired, or to either end of the file.
      this.failures += 1
      return this.#straight(Math.min(total, this.cursor + this.#chunk))
    }

    // Move the exit so that what follows the jump is on the frame grid.
    let nudge = (((entry - exit) % spf) + spf) % spf
    if (nudge > spf / 2) nudge -= spf
    const cut = exit + nudge
    const origin = lead * spf
    const before = cut - origin
    const length = before + resume * spf - entry
    const encoded = await this.#render({ lead, cut, entry, resume, before, length, half }).catch(() => [] as Buffer[])
    if (encoded.length !== length / spf - LEAD_FRAMES) {
      this.failures += 1
      return this.#straight(Math.min(total, this.cursor + this.#chunk))
    }

    const frames = [...this.frames.slice(this.cursor, lead + LEAD_FRAMES), ...encoded]
    this.cursor = resume
    this.jumps += 1
    this.#decided = -1
    this.#forced = false
    return {
      frames,
      ended: false,
      jump: {
        fromBeat: plan.at,
        toBeat: plan.edge.to,
        fromMs: Math.round((cut / this.sampleRate) * 1000),
        toMs: Math.round((entry / this.sampleRate) * 1000),
        distance: Number(plan.edge.distance.toFixed(2)),
        nudge,
        ...this.#describe(plan.at, plan.edge.to, plan.edge.distance)
      }
    }
  }

  /**
   * What a jump was, in the terms the trainer wants.
   *
   * A cut between two beats is a seam like any other: two sides, a distance
   * between them, a reason to think they belong together. The difference is
   * that the jukebox's sides are the *same* song, which makes every jump a
   * clean example of what "these two moments are interchangeable" sounds like.
   */
  #describe(from: number, to: number, distance: number) {
    const positions = this.graph.positions
    const fromBar = positions?.[from]
    const toBar = positions?.[to]
    const percent = Number.isFinite(distance) ? Math.round(Math.max(0, 1 - distance / Math.max(1, this.graph.threshold)) * 100) : 0
    const sameBar = fromBar !== undefined && fromBar === toBar
    const quality: 'good' | 'fair' | 'poor' = sameBar && percent >= 50 ? 'good' : sameBar && percent >= 25 ? 'fair' : 'poor'
    return { percent, quality, fromBar, toBar }
  }

  #straight(until: number): Segment {
    const end = Math.max(this.cursor + 1, Math.min(this.frames.length, Math.floor(until), this.cursor + this.#chunk))
    const frames = this.frames.slice(this.cursor, end)
    this.cursor = end
    return { frames, jump: null, ended: this.cursor >= this.frames.length }
  }

  /** PCM for frames [from, to), decoded with a run-up so its start is clean. */
  async #pcm(from: number, to: number) {
    const start = Math.max(0, from - RUN_UP)
    const pcm = await decodeFrames(this.frames.slice(start, to))
    if (!pcm) throw new Error('could not decode')
    const skip = (from - start) * this.spf
    return { left: pcm.left.subarray(skip), right: pcm.right.subarray(skip), at: from * this.spf }
  }

  async #render({ lead, cut, entry, resume, before, length, half }: { lead: number; cut: number; entry: number; resume: number; before: number; length: number; half: number }) {
    const { spf } = this
    const out = await this.#pcm(lead, Math.ceil((cut + half) / spf) + 1)
    const into = await this.#pcm(Math.floor((entry - half) / spf), resume + 3)
    const left = new Float32Array(length)
    const right = new Float32Array(length)
    const origin = lead * spf
    // The song as it was, up to the fade…
    left.set(out.left.subarray(0, before - half))
    right.set(out.right.subarray(0, before - half))
    // …the destination from the fade on…
    const from = entry + half - into.at
    const rest = length - before - half
    left.set(into.left.subarray(from, from + rest), before + half)
    right.set(into.right.subarray(from, from + rest), before + half)
    // …and across it, one into the other. Raised cosine, constant gain: the
    // two sides are the same song at beats chosen for sounding alike.
    for (let i = -half; i < half; i += 1) {
      const t = (i + half + 0.5) / (2 * half)
      const up = 0.5 - 0.5 * Math.cos(Math.PI * t)
      const a = cut + i - origin
      const b = entry + i - into.at
      left[before + i] = out.left[a] * (1 - up) + into.left[b] * up
      right[before + i] = out.right[a] * (1 - up) + into.right[b] * up
    }
    const next = resume * spf - into.at
    return bridge(
      codec,
      {
        left,
        right,
        sampleRate: this.sampleRate,
        bitrate: this.bitrate,
        after: { left: into.left.subarray(next, next + 3 * spf), right: into.right.subarray(next, next + 3 * spf) },
        tail: reservoirBefore(this.frames, resume)
      },
      codecKey()
    )
  }
}

export default ForeverJukebox
