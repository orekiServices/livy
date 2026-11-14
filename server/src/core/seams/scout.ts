/**
 * The scout — analysis that keeps up with the stream.
 *
 * Frames go past on their way to air; the scout decodes them a second or so
 * at a time (off the hot path: `push()` only queues), feeds the feature
 * stream, and every few seconds re-tracks the beats and lets the seam
 * detectors look again. Whatever asks later — the automix at a track change,
 * the jukebox at the end of a song, the owner API — gets an answer from
 * analysis that is already done.
 *
 * Decoding is on the frame grid (`decodeFrames`) with a short run-up of
 * frames already seen, so a sample index here is a sample index in the song:
 * a beat's time converts to a frame number exactly, which is what lets a
 * seam be cut on it.
 */
import { decodeFrames, samplesIn } from '../../util/codec.ts'
import { parseFrameHeader } from '../../util/mp3.ts'
import { FeatureStream } from './features.ts'
import { trackBeats, type BeatTrack } from './beats.ts'
import { jukeboxKernel } from '../../util/metro.ts'
import { buildGraph, useNativeKernel, type JukeboxGraph, type JukeboxOptions } from './jukebox.ts'
import { DETECTORS, detectAll, fuse, type DetectorName, type SeamCandidate } from './detectors.ts'
import { CATEGORIES, PROTOTYPES, WIDTH, sortBeats, type Category } from './categories.ts'

// libmetro's kernel when this binary has it; the TypeScript one otherwise.
useNativeKernel(jukeboxKernel())

const CHUNK_FRAMES = 48
const RUN_UP = 3

export interface ScoutOptions {
  /** Keep the frames, so the song can be replayed from memory (jukebox). */
  retain?: boolean
  /** Stop analysing (and retaining) past this much audio. */
  maxMs?: number
  /** Called for each new candidate as the song streams. */
  onSeam?: (candidate: SeamCandidate) => void
  /** Seconds of new audio between detector runs. */
  everySeconds?: number
  detectors?: DetectorName[]
  jukebox?: JukeboxOptions
  /** Centroids for the beat sorter; the prototypes when absent. */
  centroids?: () => number[][] | null
}

export interface Analysis {
  ms: number
  track: BeatTrack
  candidates: SeamCandidate[]
  categories: Uint8Array
  descriptors: Float32Array
  histogram: Record<Category, number>
}

export class SeamScout {
  readonly options: Required<Pick<ScoutOptions, 'retain' | 'maxMs' | 'everySeconds'>> & ScoutOptions
  /** Every frame seen, when `retain` is on. */
  frames: Buffer[] = []
  sampleRate = 0
  samplesPerFrame = 1152
  /** Frames and samples handed to `push()` so far. */
  seenFrames = 0
  seenSamples = 0
  failed: string | null = null

  #features: FeatureStream | null = null
  #pending: Buffer[] = []
  #runUp: Buffer[] = []
  #queue: Promise<void> = Promise.resolve()
  #analysed = 0 // samples fed to the feature stream
  #cache: { frames: number; analysis: Analysis } | null = null
  #graph: { beats: number; graph: JukeboxGraph } | null = null
  #lastRun = 0
  #emitted = -1
  #closed = false
  #frameMs = 0

  constructor(options: ScoutOptions = {}) {
    this.options = { retain: false, maxMs: 20 * 60_000, everySeconds: 8, ...options }
  }

  /** Milliseconds of audio seen. */
  get ms() {
    return this.sampleRate ? (this.seenSamples / this.sampleRate) * 1000 : 0
  }

  /** Has the song outgrown what the scout is willing to hold? */
  get full() {
    return this.seenFrames * this.#frameMs > this.options.maxMs
  }

  /** Queue frames. Never blocks and never throws. */
  push(frames: Buffer[]) {
    if (this.#closed || this.failed || frames.length === 0) return
    if (!this.#frameMs) this.#frameMs = parseFrameHeader(frames[0], 0)?.durationMs ?? 26.122
    for (const frame of frames) {
      this.seenFrames += 1
      if (this.full) continue
      if (this.options.retain) this.frames.push(frame)
      this.#pending.push(frame)
    }
    if (this.#pending.length >= CHUNK_FRAMES) this.#schedule()
  }

  /** Wait until everything pushed so far has been analysed. */
  async settle() {
    if (this.#pending.length) this.#schedule()
    await this.#queue
  }

  close() {
    this.#closed = true
    this.#pending = []
  }

  #schedule() {
    const chunk = this.#pending
    this.#pending = []
    this.#queue = this.#queue.then(() => this.#analyse(chunk)).catch((error) => {
      this.failed = error?.message ?? String(error)
    })
  }

  async #analyse(chunk: Buffer[]) {
    if (this.#closed || this.failed) return
    const pcm = await decodeFrames([...this.#runUp, ...chunk])
    this.#runUp = chunk.slice(-RUN_UP)
    const expected = samplesIn(chunk)
    this.seenSamples += expected
    if (!pcm) {
      // Keep the clock: a chunk that would not decode is a second of silence.
      this.#features?.push(new Float32Array(expected))
      return
    }
    if (!this.#features) {
      this.sampleRate = pcm.sampleRate
      this.samplesPerFrame = samplesIn([chunk[0]])
      this.#features = new FeatureStream(pcm.sampleRate)
    } else if (pcm.sampleRate !== this.sampleRate) {
      this.failed = 'the sample rate changed mid-song'
      return
    }
    const skip = pcm.length - expected
    const mono = new Float32Array(expected)
    for (let i = 0; i < expected; i += 1) mono[i] = (pcm.left[skip + i] + pcm.right[skip + i]) / 2
    this.#features.push(mono)
    this.#analysed += expected

    // Let the detectors look again every few seconds of new audio.
    const seconds = this.#analysed / this.sampleRate
    if (this.options.onSeam && seconds - this.#lastRun >= this.options.everySeconds) {
      this.#lastRun = seconds
      this.#announce()
    }
  }

  /** Tell the listener about candidates that are new and no longer moving. */
  #announce() {
    const analysis = this.analysis()
    if (!analysis) return
    // The newest beats are still provisional: the tracker's backtrace and the
    // novelty kernel both need a few bars of what follows.
    const settled = analysis.track.beats.length - 12
    for (const candidate of analysis.candidates) {
      if (candidate.beat <= this.#emitted || candidate.beat > settled) continue
      this.#emitted = candidate.beat
      try {
        this.options.onSeam?.(candidate)
      } catch {
        // A listener's problem is not the scout's.
      }
    }
  }

  /** Beats, candidates and beat kinds for everything analysed so far. */
  analysis(): Analysis | null {
    const features = this.#features
    if (!features || features.frames < features.fps * 4) return null
    if (this.#cache?.frames === features.frames) return this.#cache.analysis
    const track = trackBeats(features)
    const graph = this.#graph?.beats === track.beats.length ? this.#graph.graph : null
    const wanted = (this.options.detectors ?? DETECTORS).filter((name) => name !== 'loop' || graph)
    const candidates = fuse(track, detectAll({ track, graph }, wanted))
    const sorted = sortBeats(track, this.options.centroids?.() ?? PROTOTYPES)
    const analysis = { ms: (this.#analysed / this.sampleRate) * 1000, track, candidates, ...sorted }
    this.#cache = { frames: features.frames, analysis }
    return analysis
  }

  /**
   * The jukebox graph. Quadratic in the number of beats, so it is built when
   * something asks for it (the end of a song in Forever mode, the owner API)
   * rather than on every detector run.
   */
  graph(): JukeboxGraph | null {
    const analysis = this.analysis()
    if (!analysis || analysis.track.beats.length < 16) return null
    if (this.#graph?.beats === analysis.track.beats.length) return this.#graph.graph
    const graph = buildGraph(analysis.track, this.options.jukebox)
    this.#graph = { beats: analysis.track.beats.length, graph }
    this.#cache = null // the loop detector has something to say now
    return graph
  }

  /** Candidates between two song times, best first. */
  candidatesBetween(fromMs: number, toMs: number): SeamCandidate[] {
    const analysis = this.analysis()
    if (!analysis) return []
    return analysis.candidates.filter((candidate) => candidate.atMs >= fromMs && candidate.atMs <= toMs).sort((a, b) => b.score - a.score)
  }

  /** The kind of beat playing at `ms`, and its descriptor. */
  beatAt(ms: number): { index: number; category: Category; descriptor: number[] } | null {
    const analysis = this.analysis()
    if (!analysis || analysis.track.beats.length === 0) return null
    const beats = analysis.track.beats
    let low = 0
    let high = beats.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (beats[middle].start * 1000 <= ms) low = middle
      else high = middle - 1
    }
    return {
      index: low,
      category: CATEGORIES[analysis.categories[low]],
      descriptor: Array.from(analysis.descriptors.subarray(low * WIDTH, (low + 1) * WIDTH), (value) => Number(value.toFixed(3)))
    }
  }

  /** A short public summary. */
  info() {
    const analysis = this.analysis()
    return {
      ms: Math.round(this.ms),
      frames: this.seenFrames,
      retained: this.frames.length,
      failed: this.failed,
      bpm: analysis ? Number(analysis.track.bpm.toFixed(1)) : null,
      confidence: analysis ? Number(analysis.track.confidence.toFixed(2)) : null,
      beats: analysis?.track.beats.length ?? 0,
      candidates: analysis?.candidates.length ?? 0,
      kinds: analysis?.histogram ?? null
    }
  }
}

export default SeamScout
