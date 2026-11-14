/**
 * Beat tracking over a whole song, and the per-beat description everything
 * downstream works in.
 *
 * Tempo is the autocorrelation peak of the onset envelope under a log-normal
 * prior centred on 120 BPM; the beats are then placed by dynamic programming
 * (Ellis, "Beat Tracking by Dynamic Programming", 2007): each frame's score
 * is its onset strength plus the best earlier score one beat back, penalised
 * by how far that step is from the tempo. Backtracking from the best recent
 * frame gives a beat sequence that follows the music where the music is clear
 * and coasts on the tempo where it is not.
 *
 * The bar's first beat is whichever of the four phases collects the most
 * low-band flux — the kick lands on the one more often than anywhere else.
 * It is an estimate, and only relative position in the bar is used.
 */
import { CHROMA, TIMBRE, type FeatureStream } from './features.ts'

export interface Beat {
  index: number
  /** First analysis frame of the beat, and one past its last. */
  from: number
  to: number
  /** Seconds from the start of the song. */
  start: number
  duration: number
  /** 0–3: position in the bar. */
  bar: number
  /** 0…1: how clearly this beat was struck. */
  confidence: number
  /** Level at the beat's start and its loudest frame, dB. */
  loudStart: number
  loudMax: number
  /** Mean level across the beat, dB. */
  level: number
  low: number
  high: number
  vocal: number
  onset: number
}

export interface BeatTrack {
  bpm: number
  /** Frames per beat. */
  period: number
  confidence: number
  beats: Beat[]
  /**
   * `VECTOR` values per beat: timbre and chroma of each half of the beat,
   * then loudness start/max of each half, duration and confidence. The
   * halves are what make the comparison sensitive to rhythm inside the beat,
   * the job The Echo Nest's overlapping segments did.
   */
  vectors: Float32Array
  /** Median level of the song so far, dB. */
  medianLevel: number
}

/** Values per beat in `BeatTrack.vectors`. */
export const VECTOR = 2 * TIMBRE + 2 * CHROMA + 4 + 2

/** Tempo, in frames per beat, from the onset envelope. */
export function estimatePeriod(onset: Float32Array, fps: number, { minBpm = 60, maxBpm = 200 } = {}): { period: number; confidence: number } {
  const n = onset.length
  if (n < fps * 4) return { period: 0, confidence: 0 }
  // Remove the mean so a loud passage is not a tempo.
  let mean = 0
  for (let i = 0; i < n; i += 1) mean += onset[i]
  mean /= n
  const minLag = Math.max(2, Math.floor((60 * fps) / maxBpm))
  const maxLag = Math.min(n - 1, Math.ceil((60 * fps) / minBpm))
  // Thin very long songs: the autocorrelation needs periods, not minutes.
  const stride = n > fps * 240 ? 2 : 1
  let zero = 0
  for (let i = 0; i < n; i += stride) zero += (onset[i] - mean) ** 2
  if (zero <= 0) return { period: 0, confidence: 0 }

  let best = -Infinity
  let bestLag = 0
  const scores = new Float64Array(maxLag + 2)
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0
    for (let i = lag; i < n; i += stride) sum += (onset[i] - mean) * (onset[i - lag] - mean)
    const raw = sum / zero
    scores[lag] = raw
    const bpm = (60 * fps) / lag
    // Log-normal prior, one octave wide: 60 and 240 are both plausible
    // readings of 120, and 120 is where songs live.
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2)
    const score = raw * prior
    if (score > best) {
      best = score
      bestLag = lag
    }
  }
  if (bestLag === 0) return { period: 0, confidence: 0 }
  // Parabolic refinement: a beat is rarely a whole number of frames.
  const y0 = scores[bestLag - 1] || 0
  const y1 = scores[bestLag]
  const y2 = scores[bestLag + 1] || 0
  const denominator = y0 - 2 * y1 + y2
  const shift = denominator < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denominator)) : 0
  return { period: bestLag + shift, confidence: Math.max(0, Math.min(1, y1)) }
}

/** Beat positions (frame indices) by dynamic programming. */
export function placeBeats(onset: Float32Array, period: number, { tightness = 100 } = {}): number[] {
  const n = onset.length
  if (!(period > 1) || n < period * 2) return []
  // Normalise so `tightness` means the same thing on every song.
  let mean = 0
  for (let i = 0; i < n; i += 1) mean += onset[i]
  mean /= n
  let variance = 0
  for (let i = 0; i < n; i += 1) variance += (onset[i] - mean) ** 2
  const deviation = Math.sqrt(variance / n) || 1

  const from = Math.round(period / 2)
  const to = Math.round(period * 2)
  const penalty = new Float32Array(to + 1)
  for (let step = from; step <= to; step += 1) penalty[step] = -tightness * Math.log(step / period) ** 2

  const score = new Float32Array(n)
  const back = new Int32Array(n).fill(-1)
  for (let t = 0; t < n; t += 1) {
    const local = (onset[t] - mean) / deviation
    let best = -Infinity
    let bestAt = -1
    for (let step = from; step <= to && step <= t; step += 1) {
      const candidate = score[t - step] + penalty[step]
      if (candidate > best) {
        best = candidate
        bestAt = t - step
      }
    }
    if (bestAt >= 0) {
      score[t] = local + best
      back[t] = bestAt
    } else {
      score[t] = local
    }
  }

  // Start the backtrace from the best frame in the last beat.
  let last = n - 1
  for (let t = Math.max(0, n - Math.ceil(period)); t < n; t += 1) if (score[t] > score[last]) last = t
  const beats: number[] = []
  for (let t = last; t >= 0; t = back[t]) {
    beats.push(t)
    if (back[t] < 0) break
  }
  return beats.reverse()
}

const median = (values: number[]) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}

/** Track the beats of everything the feature stream has seen so far. */
export function trackBeats(features: FeatureStream): BeatTrack {
  const onset = features.onset.view()
  const { period, confidence } = estimatePeriod(onset, features.fps)
  const empty = { bpm: 0, period: 0, confidence: 0, beats: [], vectors: new Float32Array(0), medianLevel: -70 }
  if (!(period > 0)) return empty
  const frames = placeBeats(onset, period)
  if (frames.length < 4) return empty

  const level = features.level.view()
  const lowFlux = features.lowFlux.view()

  // Which of the four phases carries the kick?
  const phase = [0, 0, 0, 0]
  for (let i = 0; i < frames.length; i += 1) {
    let sum = 0
    for (let k = -1; k <= 2; k += 1) sum += lowFlux[frames[i] + k] ?? 0
    phase[i % 4] += sum
  }
  const one = phase.indexOf(Math.max(...phase))

  // Onset strength at the 95th percentile: "a clearly struck beat".
  const strengths = frames.map((frame) => Math.max(onset[frame] ?? 0, onset[frame + 1] ?? 0, onset[frame - 1] ?? 0))
  const strong = [...strengths].sort((a, b) => a - b)[Math.floor(strengths.length * 0.95)] || 1

  // The tracker works in analysis frames (11.6 ms). Where a beat was clearly
  // struck, a parabola through the onset peak says where between frames it
  // fell — two beats a jump joins should not be half a frame apart.
  const refine = (frame: number) => {
    let at = frame
    for (const k of [frame - 1, frame + 1]) if ((onset[k] ?? 0) > (onset[at] ?? 0)) at = k
    const y0 = onset[at - 1] ?? 0
    const y1 = onset[at] ?? 0
    const y2 = onset[at + 1] ?? 0
    if (y1 < strong * 0.3 || y1 < y0 || y1 < y2) return 0
    const curve = y0 - 2 * y1 + y2
    const fraction = curve < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / curve)) : 0
    return at - frame + fraction
  }

  const beats: Beat[] = []
  const vectors = new Float32Array(frames.length * VECTOR)
  const levels: number[] = []
  const timbre = features.timbre
  const chroma = features.chroma
  const total = features.frames

  for (let i = 0; i < frames.length; i += 1) {
    const from = frames[i]
    const to = i + 1 < frames.length ? frames[i + 1] : Math.min(total, from + Math.round(period))
    if (to <= from) continue
    const middle = Math.max(from + 1, (from + to) >> 1)
    const row = vectors.subarray(beats.length * VECTOR, (beats.length + 1) * VECTOR)

    let sumLevel = 0
    let sumLow = 0
    let sumHigh = 0
    let sumVocal = 0
    let loudMax = -100
    for (let half = 0; half < 2; half += 1) {
      const a = half === 0 ? from : middle
      const b = half === 0 ? middle : to
      const count = Math.max(1, b - a)
      let halfMax = -100
      for (let frame = a; frame < b; frame += 1) {
        const t = timbre.row(frame)
        const c = chroma.row(frame)
        for (let k = 0; k < TIMBRE; k += 1) row[half * TIMBRE + k] += t[k] / count
        for (let k = 0; k < CHROMA; k += 1) row[2 * TIMBRE + half * CHROMA + k] += c[k] / count
        const l = level[frame]
        if (l > halfMax) halfMax = l
        sumLevel += l
        sumLow += features.low.at(frame)
        sumHigh += features.high.at(frame)
        sumVocal += features.vocal.at(frame)
      }
      // Chroma as The Echo Nest gave it: the strongest pitch class is 1.
      let peak = 0
      for (let k = 0; k < CHROMA; k += 1) peak = Math.max(peak, row[2 * TIMBRE + half * CHROMA + k])
      if (peak > 0) for (let k = 0; k < CHROMA; k += 1) row[2 * TIMBRE + half * CHROMA + k] /= peak
      row[2 * TIMBRE + 2 * CHROMA + half * 2] = level[a] ?? -100 // loudness at the start
      row[2 * TIMBRE + 2 * CHROMA + half * 2 + 1] = halfMax // and at its loudest
      loudMax = Math.max(loudMax, halfMax)
    }
    const count = to - from
    const duration = count / features.fps
    const struck = Math.max(0, Math.min(1, strengths[i] / strong))
    row[VECTOR - 2] = duration
    row[VECTOR - 1] = struck
    const meanLevel = sumLevel / count
    levels.push(meanLevel)
    beats.push({
      index: beats.length,
      from,
      to,
      start: Math.max(0, (from + refine(from)) / features.fps),
      duration,
      bar: (((i - one) % 4) + 4) % 4,
      confidence: struck,
      loudStart: level[from] ?? -100,
      loudMax,
      level: meanLevel,
      low: sumLow / count,
      high: sumHigh / count,
      vocal: sumVocal / count,
      onset: strengths[i]
    })
  }

  return {
    bpm: (60 * features.fps) / period,
    period,
    confidence,
    beats,
    vectors: vectors.subarray(0, beats.length * VECTOR),
    medianLevel: median(levels)
  }
}

export default trackBeats
