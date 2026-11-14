/**
 * Sorting beats into kinds.
 *
 * A transition is chosen for two places — where one song is left and where
 * the next is entered — and what matters about each is what the music is
 * *doing* there. "Leaving a breakdown for a drop" and "leaving a chorus for
 * a quiet intro" are different problems with different answers, and a model
 * that only sees tempos and a correlation cannot tell them apart.
 *
 * Every beat is described by eight numbers relative to its own song (so a
 * quiet song's chorus and a loud song's chorus look alike), and sorted into
 * the nearest of eight kinds:
 *
 *   silence  nothing is playing            sparse  quiet, little rhythm
 *   groove   the song's steady state       build   rising, brighter
 *   drop     the low end arrives           break   the low end is gone
 *   vocal    the voice carries it          fade    falling away
 *
 * The kinds are centroids. The ones below are prototypes written by hand;
 * the RL model carries its own, fitted to the beats a station has actually
 * played and *anchored* to these — a centroid is pulled towards its
 * prototype by `anchor` pseudo-observations, so "drop" keeps meaning drop
 * and a model file from one station still reads sensibly on another.
 */
import type { Beat, BeatTrack } from './beats.ts'

export const CATEGORIES = ['silence', 'sparse', 'groove', 'build', 'drop', 'break', 'vocal', 'fade'] as const
export type Category = (typeof CATEGORIES)[number]

export const DESCRIPTOR = ['loud', 'low', 'high', 'vocal', 'struck', 'trend', 'lowTrend', 'density'] as const
export const WIDTH = DESCRIPTOR.length

/** Hand-written centroids, one row per category, in `DESCRIPTOR` order. */
export const PROTOTYPES: number[][] = [
  /* silence */ [-2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
  /* sparse  */ [-0.8, 0.3, 0.3, 0.5, 0.3, 0.0, 0.0, 0.2],
  /* groove  */ [0.1, 0.7, 0.35, 0.4, 0.8, 0.0, 0.0, 0.5],
  /* build   */ [0.0, 0.4, 0.55, 0.4, 0.7, 0.5, -0.1, 0.7],
  /* drop    */ [0.4, 0.85, 0.35, 0.3, 1.0, 0.2, 0.7, 0.7],
  /* break   */ [-0.3, 0.15, 0.4, 0.5, 0.3, -0.1, -0.7, 0.3],
  /* vocal   */ [0.0, 0.35, 0.3, 0.85, 0.5, 0.0, 0.0, 0.4],
  /* fade    */ [-0.7, 0.4, 0.25, 0.4, 0.4, -0.7, -0.2, 0.3]
]

const clamp = (value: number, low: number, high: number) => (value < low ? low : value > high ? high : value)

/** The eight numbers for every beat of a song, row-major. */
export function describeBeats(track: BeatTrack): Float32Array {
  const { beats, medianLevel } = track
  const n = beats.length
  const out = new Float32Array(n * WIDTH)
  if (n === 0) return out
  const onsets = beats.map((beat) => beat.onset).sort((a, b) => a - b)
  const typical = onsets[n >> 1] || 1
  const around = (from: number, to: number, pick: (beat: Beat) => number) => {
    let sum = 0
    let count = 0
    for (let i = Math.max(0, from); i < Math.min(n, to); i += 1) {
      sum += pick(beats[i])
      count += 1
    }
    return count ? sum / count : null
  }
  const lowDb = (beat: Beat) => 10 * Math.log10(beat.low * 10 ** (beat.level / 10) + 1e-12)
  for (let i = 0; i < n; i += 1) {
    const beat = beats[i]
    const before = around(i - 4, i, (b) => b.level)
    const after = around(i + 1, i + 5, (b) => b.level)
    const lowBefore = around(i - 4, i, lowDb)
    const lowAfter = around(i, i + 4, lowDb)
    const row = out.subarray(i * WIDTH, (i + 1) * WIDTH)
    row[0] = clamp((beat.level - medianLevel) / 12, -2, 1)
    row[1] = Math.sqrt(clamp(beat.low, 0, 1))
    row[2] = Math.sqrt(clamp(beat.high, 0, 1))
    row[3] = clamp(beat.vocal, 0, 1)
    row[4] = clamp(beat.confidence, 0, 1)
    row[5] = before == null || after == null ? 0 : clamp((after - before) / 12, -1, 1)
    row[6] = lowBefore == null || lowAfter == null ? 0 : clamp((lowAfter - lowBefore) / 12, -1, 1)
    row[7] = clamp(beat.onset / typical / 3, 0, 1)
  }
  return out
}

/** Index of the nearest centroid. */
export function nearest(row: ArrayLike<number>, centroids: number[][] = PROTOTYPES): number {
  let best = 0
  let bestDistance = Infinity
  for (let k = 0; k < centroids.length; k += 1) {
    let distance = 0
    for (let j = 0; j < WIDTH; j += 1) distance += (row[j] - centroids[k][j]) ** 2
    if (distance < bestDistance) {
      bestDistance = distance
      best = k
    }
  }
  return best
}

/** The category of every beat. */
export function sortBeats(track: BeatTrack, centroids: number[][] = PROTOTYPES): { categories: Uint8Array; descriptors: Float32Array; histogram: Record<Category, number> } {
  const descriptors = describeBeats(track)
  const n = track.beats.length
  const categories = new Uint8Array(n)
  const histogram = Object.fromEntries(CATEGORIES.map((name) => [name, 0])) as Record<Category, number>
  for (let i = 0; i < n; i += 1) {
    categories[i] = nearest(descriptors.subarray(i * WIDTH, (i + 1) * WIDTH), centroids)
    histogram[CATEGORIES[categories[i]]] += 1
  }
  return { categories, descriptors, histogram }
}

/**
 * Fit centroids to observed beats: k-means, started from and anchored to the
 * prototypes. With no samples it returns the prototypes; with a few it moves
 * a little; `anchor` is how many observations the prior is worth.
 */
export function fitCentroids(samples: ArrayLike<number>[], { prior = PROTOTYPES, iterations = 12, anchor = 20 }: { prior?: number[][]; iterations?: number; anchor?: number } = {}): { centroids: number[][]; counts: number[] } {
  let centroids = prior.map((row) => [...row])
  let counts = prior.map(() => 0)
  const usable = samples.filter((row) => row && row.length >= WIDTH)
  for (let pass = 0; pass < iterations && usable.length; pass += 1) {
    const sums = prior.map(() => new Array(WIDTH).fill(0))
    counts = prior.map(() => 0)
    for (const row of usable) {
      const k = nearest(row, centroids)
      counts[k] += 1
      for (let j = 0; j < WIDTH; j += 1) sums[k][j] += row[j]
    }
    const next = prior.map((proto, k) => proto.map((value, j) => (sums[k][j] + anchor * value) / (counts[k] + anchor)))
    const moved = next.reduce((sum, row, k) => sum + row.reduce((s, value, j) => s + Math.abs(value - centroids[k][j]), 0), 0)
    centroids = next
    if (moved < 1e-4) break
  }
  return { centroids, counts }
}

export default sortBeats
