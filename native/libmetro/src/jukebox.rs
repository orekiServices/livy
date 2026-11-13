//! The Infinite Jukebox kernel: for every beat of a song, the beats that
//! sound most like it.
//!
//! This is the one part of seam analysis that is quadratic in the length of
//! the song — a five-minute track at 128 BPM is 640 beats and 100,000
//! same-position pairs of 54 numbers each — and it is the part worth doing
//! here. Everything else (features, beat tracking, the graph's thresholds
//! and reachability, the walk) is linear and stays in
//! `server/src/core/seams/`.
//!
//! The reference is `nearestNeighbours` in `seams/jukebox.ts`. This must
//! return the same triples: the same weights, the same thinned sample for
//! the median, the same tie order (a stable sort by distance, so equal
//! distances keep beat order). Arithmetic is in `f64` on `f32` inputs, as
//! JavaScript does it, so the two agree to the last bit that an `f32`
//! triple can hold.

const TIMBRE: usize = 12;
const CHROMA: usize = 12;

const W_TIMBRE: f64 = 1.0;
const W_PITCH: f64 = 10.0;
const W_LOUD_START: f64 = 1.0;
const W_LOUD_MAX: f64 = 1.0;
const W_DURATION: f64 = 100.0;
const W_CONFIDENCE: f64 = 1.0;

/// The layout the TypeScript side builds: two halves of timbre, two halves
/// of chroma, two (start, max) loudness pairs, duration, confidence.
pub const VECTOR: usize = 2 * TIMBRE + 2 * CHROMA + 4 + 2;

pub struct Neighbours {
  /// `[from, to, distance]`, `limit` per beat at most, nearest first.
  pub triples: Vec<f32>,
  /// Median of a thinned sample of all same-position distances.
  pub median: f64,
}

/// The segment distance of the original, between two beat vectors.
#[inline]
pub fn beat_distance(x: &[f32], y: &[f32]) -> f64 {
  let mut total = 0.0f64;
  for half in 0..2 {
    let mut timbre = 0.0f64;
    let t = half * TIMBRE;
    for k in 0..TIMBRE {
      let d = x[t + k] as f64 - y[t + k] as f64;
      timbre += d * d;
    }
    let mut pitch = 0.0f64;
    let c = 2 * TIMBRE + half * CHROMA;
    for k in 0..CHROMA {
      let d = x[c + k] as f64 - y[c + k] as f64;
      pitch += d * d;
    }
    let l = 2 * TIMBRE + 2 * CHROMA + half * 2;
    total += timbre.sqrt() * W_TIMBRE
      + pitch.sqrt() * W_PITCH
      + (x[l] as f64 - y[l] as f64).abs() * W_LOUD_START
      + (x[l + 1] as f64 - y[l + 1] as f64).abs() * W_LOUD_MAX;
  }
  total / 2.0
    + (x[VECTOR - 2] as f64 - y[VECTOR - 2] as f64).abs() * W_DURATION
    + (x[VECTOR - 1] as f64 - y[VECTOR - 1] as f64).abs() * W_CONFIDENCE
}

/// Nearest `limit` same-bar-position beats for every beat.
///
/// `vectors` is row-major, `width` values per beat; `bars` is each beat's
/// position in its bar. Returns `None` when the shapes do not agree, which
/// the caller treats as "use the fallback".
pub fn neighbours(vectors: &[f32], width: usize, bars: &[u8], limit: usize) -> Option<Neighbours> {
  let n = bars.len();
  if width != VECTOR || vectors.len() < n * width {
    return None;
  }
  let mut triples: Vec<f32> = Vec::with_capacity(n * limit * 3);
  let mut sample: Vec<f64> = Vec::with_capacity(n * n / 32 + 1);
  // The reference keeps distances in a Float32Array row and sorts by it, so
  // the comparison here is on the rounded value too.
  let mut row: Vec<(f32, u32)> = Vec::with_capacity(n);

  for a in 0..n {
    row.clear();
    let x = &vectors[a * width..(a + 1) * width];
    for b in 0..n {
      if b == a || bars[b] != bars[a] {
        continue;
      }
      let exact = beat_distance(x, &vectors[b * width..(b + 1) * width]);
      row.push((exact as f32, b as u32));
      // The sample keeps full precision, as the reference's does.
      if ((a * 31 + b * 17) & 7) == 0 {
        sample.push(exact);
      }
    }
    // Stable: equal distances stay in beat order, as Array.prototype.sort does.
    row.sort_by(|p, q| p.0.partial_cmp(&q.0).unwrap_or(std::cmp::Ordering::Equal));
    for &(distance, b) in row.iter().take(limit) {
      triples.push(a as f32);
      triples.push(b as f32);
      triples.push(distance);
    }
  }

  sample.sort_by(|p, q| p.partial_cmp(q).unwrap_or(std::cmp::Ordering::Equal));
  let median = if sample.is_empty() { 0.0 } else { sample[sample.len() >> 1] };
  Some(Neighbours { triples, median })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn song(beats: usize) -> (Vec<f32>, Vec<u8>) {
    // Two alternating 8-beat "sections", so repeats exist.
    let mut vectors = vec![0.0f32; beats * VECTOR];
    let mut bars = vec![0u8; beats];
    for i in 0..beats {
      bars[i] = (i % 4) as u8;
      let section = (i / 8) % 2;
      let row = &mut vectors[i * VECTOR..(i + 1) * VECTOR];
      for k in 0..VECTOR - 2 {
        row[k] = ((k * 7 + (i % 8) * 3 + section * 11) % 13) as f32 / 13.0;
      }
      row[VECTOR - 2] = 0.5;
      row[VECTOR - 1] = 1.0;
    }
    (vectors, bars)
  }

  #[test]
  fn identical_beats_are_at_distance_zero() {
    let (vectors, _) = song(32);
    assert_eq!(beat_distance(&vectors[0..VECTOR], &vectors[16 * VECTOR..17 * VECTOR]), 0.0);
    assert!(beat_distance(&vectors[0..VECTOR], &vectors[8 * VECTOR..9 * VECTOR]) > 0.0);
  }

  #[test]
  fn nearest_is_the_repeat_and_shares_the_bar_position() {
    let (vectors, bars) = song(64);
    let out = neighbours(&vectors, VECTOR, &bars, 4).unwrap();
    assert_eq!(out.triples.len() % 3, 0);
    for triple in out.triples.chunks(3) {
      let (from, to) = (triple[0] as usize, triple[1] as usize);
      assert_ne!(from, to);
      assert_eq!(bars[from], bars[to]);
    }
    // Beat 0's nearest neighbour is its first repeat, 16 beats on.
    assert_eq!(out.triples[1] as usize, 16);
    assert_eq!(out.triples[2], 0.0);
    assert!(out.median > 0.0);
  }

  #[test]
  fn a_wrong_width_is_refused() {
    let (vectors, bars) = song(8);
    assert!(neighbours(&vectors, VECTOR - 1, &bars, 4).is_none());
    assert!(neighbours(&vectors[..VECTOR], VECTOR, &bars, 4).is_none());
  }
}
