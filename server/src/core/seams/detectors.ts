/**
 * Seam detectors — several opinions about where a song can be left.
 *
 * A transition used to have one place it could happen: the end of the file.
 * That is where the song *stops*, which is not the same as where it is good
 * to leave. Each detector here looks for one kind of good place, on the beat
 * grid, as the song streams:
 *
 *   ending    the level starts falling and does not come back — the fade-out
 *             or the last chord. Blend from here and nothing is cut short.
 *   energy    the low end drops out (a breakdown, an outro with the drums
 *             gone). The classic DJ exit: there is no bassline to clash with.
 *   novelty   the song changes character — Foote's checkerboard kernel over
 *             the beat-synchronous timbre/chroma self-similarity. A section
 *             boundary is where a listener expects something to happen.
 *   phrase    the first beat of a bar on an 8-bar boundary. Music is built in
 *             phrases; a move that starts on one sounds intended.
 *   vocal     the vocal band goes quiet after being busy: the line ended.
 *   loop      the beat has a close twin elsewhere in the song (a jukebox
 *             branch): what follows is material the listener has heard.
 *
 * None of them is right alone, which is the point of having several. The
 * fusion keeps, for each beat, the opinions that landed on it (or one beat
 * either side), and scores it with a noisy-OR: agreement raises the score,
 * and one confident detector is still heard.
 *
 * References: Foote, "Automatic Audio Segmentation Using a Measure of Audio
 * Novelty" (ICME 2000); Ellis 2007 for the grid the candidates sit on.
 */
import { CHROMA, TIMBRE } from './features.ts'
import { VECTOR, type Beat, type BeatTrack } from './beats.ts'
import type { JukeboxGraph } from './jukebox.ts'

export type DetectorName = 'ending' | 'energy' | 'novelty' | 'phrase' | 'vocal' | 'loop'

export interface Opinion {
  beat: number
  detector: DetectorName
  /** 0…1 */
  score: number
  why: string
}

export interface SeamCandidate {
  beat: number
  /** Milliseconds from the start of the song. */
  atMs: number
  /** Fused 0…1. */
  score: number
  /** Each detector's own score at this beat (0 when it had no opinion). */
  detectors: Record<DetectorName, number>
  why: string[]
}

export interface DetectorContext {
  track: BeatTrack
  graph?: JukeboxGraph | null
}

export const DETECTORS: DetectorName[] = ['ending', 'energy', 'novelty', 'phrase', 'vocal', 'loop']

/** How much each detector is trusted in the fusion. */
export const DETECTOR_WEIGHTS: Record<DetectorName, number> = {
  ending: 0.9,
  energy: 0.7,
  novelty: 0.6,
  phrase: 0.45,
  vocal: 0.4,
  loop: 0.5
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value)
const mean = (beats: Beat[], from: number, to: number, pick: (beat: Beat) => number) => {
  let sum = 0
  let count = 0
  for (let i = Math.max(0, from); i < Math.min(beats.length, to); i += 1) {
    sum += pick(beats[i])
    count += 1
  }
  return count ? sum / count : 0
}

/** The level falls away and stays down. */
export function detectEnding({ track }: DetectorContext): Opinion[] {
  const { beats, medianLevel } = track
  const out: Opinion[] = []
  if (beats.length < 16) return out
  // Walk back from the end while the song is clearly under its usual level.
  let start = beats.length
  while (start > 0 && beats[start - 1].level < medianLevel - 9) start -= 1
  // Then on through the fade itself: monotonically quieter towards the end.
  let fade = start
  while (fade > 1 && beats[fade - 1].level < medianLevel - 3 && beats[fade - 1].level <= beats[fade - 2].level + 1.5) fade -= 1
  if (fade < beats.length - 1 && fade > beats.length * 0.5) {
    const depth = clamp01((medianLevel - mean(beats, fade, beats.length, (beat) => beat.level)) / 18)
    out.push({ beat: fade, detector: 'ending', score: 0.5 + 0.5 * depth, why: `the level falls away from here (${(beats.length - fade)} beats to the end)` })
  }
  return out
}

/** The low end drops out for at least a bar. */
export function detectEnergy({ track }: DetectorContext): Opinion[] {
  const { beats } = track
  const out: Opinion[] = []
  for (let i = 8; i < beats.length - 4; i += 1) {
    if (beats[i].bar !== 0) continue
    const before = mean(beats, i - 8, i, (beat) => beat.low * 10 ** (beat.level / 10))
    const after = mean(beats, i, i + 4, (beat) => beat.low * 10 ** (beat.level / 10))
    if (before <= 0) continue
    const drop = 10 * Math.log10((after + 1e-12) / before)
    if (drop < -6) out.push({ beat: i, detector: 'energy', score: clamp01(-drop / 18), why: `the low end drops ${(-drop).toFixed(0)} dB` })
  }
  return out
}

/** Foote novelty on the beat-synchronous self-similarity matrix. */
export function detectNovelty({ track }: DetectorContext, { kernel = 8 }: any = {}): Opinion[] {
  const { beats, vectors } = track
  const n = beats.length
  const out: Opinion[] = []
  if (n < kernel * 3) return out

  // One unit vector per beat: timbre (without its level term) and chroma.
  const width = 2 * (TIMBRE - 1) + 2 * CHROMA
  const unit = new Float32Array(n * width)
  for (let i = 0; i < n; i += 1) {
    let norm = 0
    let at = 0
    for (let half = 0; half < 2; half += 1) {
      for (let k = 1; k < TIMBRE; k += 1) unit[i * width + at++] = vectors[i * VECTOR + half * TIMBRE + k] / 20
      for (let k = 0; k < CHROMA; k += 1) unit[i * width + at++] = vectors[i * VECTOR + 2 * TIMBRE + half * CHROMA + k]
    }
    for (let k = 0; k < width; k += 1) norm += unit[i * width + k] ** 2
    norm = Math.sqrt(norm) || 1
    for (let k = 0; k < width; k += 1) unit[i * width + k] /= norm
  }
  const similarity = (a: number, b: number) => {
    let sum = 0
    for (let k = 0; k < width; k += 1) sum += unit[a * width + k] * unit[b * width + k]
    return sum
  }

  // Checkerboard kernel with a Gaussian taper: like-with-like on each side of
  // the boundary counts for it, like-across-the-boundary counts against.
  const novelty = new Float32Array(n)
  let top = 0
  for (let i = kernel; i < n - kernel; i += 1) {
    let value = 0
    for (let a = -kernel; a < kernel; a += 1) {
      for (let b = -kernel; b < kernel; b += 1) {
        const sign = (a < 0) === (b < 0) ? 1 : -1
        const taper = Math.exp(-((a + 0.5) ** 2 + (b + 0.5) ** 2) / (2 * (kernel * 0.6) ** 2))
        value += sign * taper * similarity(i + a, i + b)
      }
    }
    novelty[i] = Math.max(0, value)
    top = Math.max(top, novelty[i])
  }
  if (top <= 0) return out
  // Peaks only, and only the ones that stand out from the song's own average.
  let average = 0
  for (let i = 0; i < n; i += 1) average += novelty[i]
  average /= n
  for (let i = kernel; i < n - kernel; i += 1) {
    const value = novelty[i]
    if (value < novelty[i - 1] || value < novelty[i + 1]) continue
    if (value < average * 2 || value < top * 0.3) continue
    out.push({ beat: i, detector: 'novelty', score: clamp01(value / top), why: 'the song changes section' })
  }
  return out
}

/** Bar ones on 8- and 4-bar boundaries, counted from the first bar. */
export function detectPhrase(context: DetectorContext): Opinion[] {
  const { beats } = context.track
  const out: Opinion[] = []
  if (beats.length < 16) return out
  // Where the phrases start is not the same question as where the bars
  // start: songs open with pickups and odd-length intros. So the 8-bar grid
  // is laid where the song's own section changes fall — the offset, out of
  // the 32 possible, that collects the most evidence of change — with the
  // tracker's idea of the downbeat as a prior and as the fallback.
  const evidence = new Float64Array(beats.length)
  for (const opinion of [...detectNovelty(context), ...detectEnergy(context)]) {
    if (opinion.beat >= 0 && opinion.beat < beats.length) evidence[opinion.beat] = Math.max(evidence[opinion.beat], opinion.score)
  }
  let offset = Math.max(0, beats.findIndex((beat) => beat.bar === 0))
  let best = -1
  for (let candidate = 0; candidate < 32; candidate += 1) {
    let score = beats[candidate]?.bar === 0 ? 0.25 : 0
    for (let i = candidate; i < beats.length; i += 16) score += evidence[i] * ((i - candidate) % 32 === 0 ? 1 : 0.6)
    if (score > best + 1e-9) {
      best = score
      offset = candidate
    }
  }
  for (let i = offset % 16; i < beats.length; i += 16) {
    if (i === 0) continue
    const bars = (i - offset) / 4
    if (((bars % 8) + 8) % 8 === 0) out.push({ beat: i, detector: 'phrase', score: 1, why: 'an 8-bar phrase begins' })
    else out.push({ beat: i, detector: 'phrase', score: 0.6, why: 'a 4-bar phrase begins' })
  }
  return out
}

/** The vocal band was busy and has gone quiet. */
export function detectVocal({ track }: DetectorContext): Opinion[] {
  const { beats } = track
  const out: Opinion[] = []
  const presence = (beat: Beat) => beat.vocal * 10 ** (beat.level / 10)
  for (let i = 4; i < beats.length - 2; i += 1) {
    const before = mean(beats, i - 4, i, presence)
    const after = mean(beats, i, i + 2, presence)
    if (before <= 0) continue
    const drop = 10 * Math.log10((after + 1e-12) / before)
    if (drop < -5 && mean(beats, i - 4, i, (beat) => beat.vocal) > 0.35) {
      out.push({ beat: i, detector: 'vocal', score: clamp01(-drop / 14), why: 'the vocal line ends' })
    }
  }
  return out
}

/** Beats the jukebox can branch from: the song has been here before. */
export function detectLoop({ graph }: DetectorContext): Opinion[] {
  const out: Opinion[] = []
  if (!graph) return out
  graph.neighbours.forEach((edges, beat) => {
    if (edges.length === 0) return
    const closest = Math.min(...edges.map((edge) => edge.distance))
    out.push({ beat, detector: 'loop', score: clamp01(1 - closest / 80), why: `sounds like beat ${edges[0].to}` })
  })
  return out
}

const RUNNERS: Record<DetectorName, (context: DetectorContext) => Opinion[]> = {
  ending: detectEnding,
  energy: detectEnergy,
  novelty: detectNovelty,
  phrase: detectPhrase,
  vocal: detectVocal,
  loop: detectLoop
}

/** Run every detector (or the named ones) and return their raw opinions. */
export function detectAll(context: DetectorContext, only: DetectorName[] = DETECTORS): Opinion[] {
  const opinions: Opinion[] = []
  for (const name of only) {
    try {
      opinions.push(...RUNNERS[name](context))
    } catch {
      // One detector failing is one opinion fewer, not no seam.
    }
  }
  return opinions
}

/**
 * Fuse opinions into candidates, one per beat that anyone had a view on.
 *
 * An opinion one beat away still counts, at half weight: detectors that
 * measure a change across a boundary routinely disagree by a beat about
 * where the boundary is.
 */
export function fuse(track: BeatTrack, opinions: Opinion[], weights: Record<DetectorName, number> = DETECTOR_WEIGHTS, floor = 0.25): SeamCandidate[] {
  const byBeat = new Map<number, Opinion[]>()
  for (const opinion of opinions) {
    if (opinion.beat < 0 || opinion.beat >= track.beats.length) continue
    const list = byBeat.get(opinion.beat) ?? []
    list.push(opinion)
    byBeat.set(opinion.beat, list)
  }
  const scored: SeamCandidate[] = []
  for (const [beat, own] of byBeat) {
    const detectors = Object.fromEntries(DETECTORS.map((name) => [name, 0])) as Record<DetectorName, number>
    const why: string[] = []
    for (const opinion of own) {
      if (opinion.score > detectors[opinion.detector]) detectors[opinion.detector] = opinion.score
      why.push(opinion.why)
    }
    // A repeat is a reason to prefer a seam, not a reason to have one: in a
    // repetitive song nearly every beat sounds like some other beat.
    if (DETECTORS.every((name) => name === 'loop' || detectors[name] === 0)) continue
    for (const offset of [-1, 1]) {
      for (const opinion of byBeat.get(beat + offset) ?? []) {
        if (opinion.score * 0.5 > detectors[opinion.detector]) detectors[opinion.detector] = opinion.score * 0.5
      }
    }
    let miss = 1
    for (const name of DETECTORS) miss *= 1 - clamp01(weights[name] * detectors[name])
    const score = Number((1 - miss).toFixed(4))
    if (score >= floor) scored.push({ beat, atMs: Math.round(track.beats[beat].start * 1000), score, detectors, why })
  }
  // One seam per place: of two candidates on adjacent beats the better stays.
  const kept = new Map(scored.map((candidate) => [candidate.beat, candidate]))
  for (const candidate of [...scored].sort((x, y) => y.score - x.score || x.beat - y.beat)) {
    if (!kept.has(candidate.beat)) continue
    for (const offset of [-1, 1]) kept.delete(candidate.beat + offset)
  }
  return [...kept.values()].sort((x, y) => x.beat - y.beat)
}

export default detectAll
