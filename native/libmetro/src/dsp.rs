//! The two things that make a long crossfade slow.
//!
//! Livy's automix is written in JavaScript and most of it is fine: the
//! filters, the gain curves and the mixing are simple loops over a few
//! seconds of audio. Two stages are not.
//!
//!   • **Beat detection** — an STFT of the whole window, then an
//!     autocorrelation of the onset envelope over every plausible lag.
//!   • **WSOLA time stretch** — a similarity search per grain, four grains
//!     per window length.
//!
//! Both are O(n) in the crossfade length with a large constant, and both run
//! on the thread that is supposed to be releasing an MP3 frame every 26 ms.
//! At a 6 second crossfade that costs ~150 ms and nobody notices. At the 30
//! or 60 second blends this now supports it is most of a second each, twice
//! per seam — which is exactly the stutter the automix was accused of.
//!
//! So they are here, in Rust, and exposed as async tasks that run on the
//! thread pool. The algorithms are ports of `server/src/core/dsp.js`, kept
//! deliberately faithful — same window sizes, same comb weighting, same
//! log-Gaussian tempo prior, same parabolic interpolation, same search
//! strategy — so the JavaScript stays the readable reference implementation
//! and the two agree on real audio.

use std::f32::consts::PI;
use std::sync::Arc;

use rustfft::{num_complex::Complex32, FftPlanner};

/// A tempo, a grid, and how much to believe them.
pub struct Beat {
  pub bpm: f64,
  pub period_samples: f64,
  pub phase_samples: f64,
  pub confidence: f64,
}

fn hann(size: usize) -> Vec<f32> {
  (0..size)
    .map(|i| 0.5 - 0.5 * ((2.0 * PI * i as f32) / (size - 1) as f32).cos())
    .collect()
}

/// Spectral flux onset envelope: how much each frame *gains* over the last.
///
/// Normalised to a peak of 1 with the mean removed, which is what lets the
/// autocorrelation see pulses instead of loudness.
pub fn onset_envelope(mono: &[f32], frame_size: usize, hop_size: usize) -> Vec<f32> {
  if mono.len() < frame_size + hop_size {
    return Vec::new();
  }

  let frames = (mono.len() - frame_size) / hop_size + 1;
  if frames < 2 {
    return Vec::new();
  }

  let window = hann(frame_size);
  let mut planner = FftPlanner::<f32>::new();
  let fft = planner.plan_fft_forward(frame_size);

  let bins = frame_size / 2;
  let mut odf = vec![0f32; frames - 1];
  let mut buffer = vec![Complex32::new(0.0, 0.0); frame_size];
  let mut previous: Option<Vec<f32>> = None;

  for f in 0..frames {
    let start = f * hop_size;
    for i in 0..frame_size {
      buffer[i] = Complex32::new(mono[start + i] * window[i], 0.0);
    }
    fft.process(&mut buffer);

    let magnitude: Vec<f32> = buffer[..bins].iter().map(|c| c.norm()).collect();
    if let Some(last) = &previous {
      let flux: f32 = magnitude
        .iter()
        .zip(last.iter())
        .map(|(now, before)| (now - before).max(0.0))
        .sum();
      odf[f - 1] = flux;
    }
    previous = Some(magnitude);
  }

  // Remove the mean, then normalise to a peak of one.
  let mean = odf.iter().sum::<f32>() / odf.len().max(1) as f32;
  let mut peak = 0f32;
  for value in odf.iter_mut() {
    *value = (*value - mean).max(0.0);
    peak = peak.max(*value);
  }
  if peak > 0.0 {
    for value in odf.iter_mut() {
      *value /= peak;
    }
  }
  odf
}

const fn clamp(value: f64, low: f64, high: f64) -> f64 {
  if value < low {
    low
  } else if value > high {
    high
  } else {
    value
  }
}

/// Tempo and beat phase, the same way `dsp.js` does it.
pub fn estimate_beat(mono: &[f32], sample_rate: u32, frame_size: usize, hop_size: usize) -> Option<Beat> {
  let odf = onset_envelope(mono, frame_size, hop_size);
  if odf.len() < 16 {
    return None;
  }

  let odf_rate = sample_rate as f64 / hop_size as f64;
  let min_lag = ((60.0 / 200.0) * odf_rate).round().max(2.0) as usize;
  let max_lag = (((60.0 / 60.0) * odf_rate).round() as usize).min(odf.len() - 1);
  if max_lag <= min_lag {
    return None;
  }

  // Autocorrelation over every lag the comb can reach — the harmonic teeth
  // need something to bite on above the tempo range itself.
  let top_lag = (max_lag * 3).min(odf.len().saturating_sub(2));
  let mut acf = vec![0f64; top_lag + 1];
  for lag in min_lag..=top_lag {
    let n = odf.len().saturating_sub(lag);
    if n == 0 {
      break;
    }
    let mut sum = 0f64;
    for i in 0..n {
      sum += odf[i] as f64 * odf[i + lag] as f64;
    }
    acf[lag] = sum / n as f64;
  }

  let at = |lag: f64| -> f64 {
    let index = lag.round() as usize;
    if index <= top_lag {
      acf[index]
    } else {
      0.0
    }
  };

  let mut scores = vec![0f64; max_lag + 1];
  let mut best_lag = 0usize;
  let mut best_score = 0f64;
  for lag in min_lag..=max_lag {
    let comb = acf[lag] + 0.5 * at(lag as f64 * 2.0) + 0.25 * at(lag as f64 * 3.0);
    let bpm = (60.0 * odf_rate) / lag as f64;
    let weight = (-0.5 * ((bpm / 120.0).log2() / 0.9).powi(2)).exp();
    scores[lag] = comb * weight;
    if scores[lag] > best_score {
      best_score = scores[lag];
      best_lag = lag;
    }
  }
  if best_lag == 0 || best_score <= 0.0 {
    return None;
  }

  // Parabolic interpolation: the hop is ~6 ms, otherwise ±1 BPM of
  // quantisation error.
  let mut refined = best_lag as f64;
  if best_lag > min_lag && best_lag < max_lag {
    let (y0, y1, y2) = (scores[best_lag - 1], scores[best_lag], scores[best_lag + 1]);
    let denominator = y0 - 2.0 * y1 + y2;
    if denominator.abs() > 1e-12 {
      refined = best_lag as f64 + clamp((0.5 * (y0 - y2)) / denominator, -0.5, 0.5);
    }
  }

  // Phase: a pulse train of that period, correlated against the envelope.
  let mut best_phase = 0usize;
  let mut best_phase_score = -1f64;
  let mut hits = 0usize;
  for phase in 0..best_lag {
    let mut sum = 0f64;
    let mut n = 0usize;
    let mut i = phase;
    while i < odf.len() {
      sum += odf[i] as f64;
      n += 1;
      i += best_lag;
    }
    if sum > best_phase_score {
      best_phase_score = sum;
      best_phase = phase;
      hits = n;
    }
  }

  // Salience: how far the winner stands above the typical candidate.
  let mut field: Vec<f64> = (min_lag..=max_lag).map(|lag| scores[lag]).filter(|score| *score > 0.0).collect();
  field.sort_by(|a, b| a.partial_cmp(b).unwrap());
  let median = if field.is_empty() { 0.0 } else { field[field.len() / 2] };
  let salience = if median > 0.0 {
    clamp((best_score / median - 1.0) / 3.0, 0.0, 1.0)
  } else {
    0.0
  };

  // Grid strength, and peakiness — a sine wave must not read as a tempo.
  let mean_odf = odf.iter().map(|v| *v as f64).sum::<f64>() / odf.len().max(1) as f64;
  let on_grid = if hits > 0 { best_phase_score / hits as f64 } else { 0.0 };
  let grid = if mean_odf > 0.0 {
    clamp((on_grid / mean_odf - 1.0) / 2.0, 0.0, 1.0)
  } else {
    0.0
  };
  let peakiness = if mean_odf > 0.0 {
    clamp((1.0 / mean_odf - 4.0) / 10.0, 0.0, 1.0)
  } else {
    0.0
  };

  Some(Beat {
    bpm: (60.0 * odf_rate) / refined,
    period_samples: refined * hop_size as f64,
    phase_samples: (best_phase * hop_size) as f64,
    confidence: (salience * grid).sqrt() * peakiness,
  })
}

/* ------------------------------ stretching ----------------------------- */

/// The time map: how output position relates to input position, with an
/// optional ease-in so a stretch does not start abruptly.
#[derive(Clone, Copy)]
pub struct StretchMap {
  stretch: f64,
  ramp: f64,
  input_at_ramp_end: f64,
  linear: bool,
}

impl StretchMap {
  pub fn new(stretch: f64, ramp_samples: f64) -> Self {
    let linear = (stretch - 1.0).abs() < 1e-6;
    let ramp = ramp_samples.max(0.0);
    let input_at_ramp_end = if linear || ramp == 0.0 {
      ramp
    } else {
      (ramp / (stretch - 1.0)) * stretch.ln()
    };
    StretchMap {
      stretch,
      ramp,
      input_at_ramp_end,
      linear,
    }
  }

  pub fn input_at(&self, out: f64) -> f64 {
    if self.linear {
      return out;
    }
    if self.ramp == 0.0 {
      return out / self.stretch;
    }
    if out <= self.ramp {
      (self.ramp / (self.stretch - 1.0)) * (1.0 + ((self.stretch - 1.0) * out) / self.ramp).ln()
    } else {
      self.input_at_ramp_end + (out - self.ramp) / self.stretch
    }
  }

  pub fn output_at(&self, input: f64) -> f64 {
    if self.linear {
      return input;
    }
    if self.ramp == 0.0 {
      return input * self.stretch;
    }
    if input <= self.input_at_ramp_end {
      (self.ramp / (self.stretch - 1.0)) * ((((self.stretch - 1.0) * input) / self.ramp).exp() - 1.0)
    } else {
      self.ramp + (input - self.input_at_ramp_end) * self.stretch
    }
  }

  pub fn output_length(&self, input_length: usize) -> usize {
    self.output_at(input_length as f64).round().max(0.0) as usize
  }
}

pub struct Stretched {
  pub left: Vec<f32>,
  pub right: Vec<f32>,
  pub length: usize,
}

/// WSOLA: change the tempo without touching the pitch.
///
/// Each grain is taken from wherever, within a small window around where the
/// time map points, it best continues what has already been written — which
/// is what keeps a kick drum sounding like a kick drum rather than a flam.
/// Both channels move with the same offsets (chosen on the mono sum), so the
/// stereo image survives and the search runs once.
pub fn time_stretch(
  left: &[f32],
  right: &[f32],
  sample_rate: u32,
  stretch: f64,
  ramp_samples: f64,
  length: Option<usize>,
  search_ms: f64,
) -> Stretched {
  let map = StretchMap::new(stretch, ramp_samples);
  let input_length = left.len().min(right.len());
  let natural = map.output_length(input_length);
  let out_length = length.map(|value| value.min(natural)).unwrap_or(natural);

  if (stretch - 1.0).abs() < 1e-6 || input_length == 0 || out_length == 0 {
    let take = if out_length == 0 { input_length } else { out_length.min(input_length) };
    return Stretched {
      left: left[..take].to_vec(),
      right: right[..take].to_vec(),
      length: take,
    };
  }

  // ~46 ms grains: long enough for bass, short enough for drums.
  let n = {
    let ideal = (sample_rate as f64 * 0.046).log2().round() as u32;
    (1usize << ideal).max(512)
  };
  let hop = (n as f64 / 4.0).round() as usize; // 75 % overlap
  let search = (((search_ms / 1000.0) * sample_rate as f64).round() as usize).max(1);
  let corr_window = hop.min(512);

  let window = hann(n);

  let mut mono = vec![0f32; input_length];
  for i in 0..input_length {
    mono[i] = (left[i] + right[i]) * 0.5;
  }

  let mut out_left = vec![0f32; out_length + n];
  let mut out_right = vec![0f32; out_length + n];
  let mut norm = vec![0f32; out_length + n];
  let mut template = vec![0f32; corr_window];
  let mut first = true;

  let mut out_pos = 0usize;
  while out_pos < out_length {
    let target = map.input_at(out_pos as f64).round().max(0.0) as usize;
    let mut best = target;

    if !first && input_length > corr_window + 1 {
      let mut best_score = f32::NEG_INFINITY;
      let from = target.saturating_sub(search);
      let to = (target + search).min(input_length - corr_window - 1);

      // Coarse pass, every fourth sample and every second tap…
      let mut coarse = from;
      while coarse <= to {
        let mut dot = 0f32;
        let mut energy = 1e-9f32;
        let mut i = 0;
        while i < corr_window {
          let v = mono[coarse + i];
          dot += v * template[i];
          energy += v * v;
          i += 2;
        }
        let score = dot / energy.sqrt();
        if score > best_score {
          best_score = score;
          best = coarse;
        }
        coarse += 4;
      }

      // …then refine to the sample.
      let fine_from = best.saturating_sub(3);
      let fine_to = (best + 3).min(input_length - corr_window - 1);
      for fine in fine_from..=fine_to {
        let mut dot = 0f32;
        let mut energy = 1e-9f32;
        for i in 0..corr_window {
          let v = mono[fine + i];
          dot += v * template[i];
          energy += v * v;
        }
        let score = dot / energy.sqrt();
        if score > best_score {
          best_score = score;
          best = fine;
        }
      }
    }
    first = false;

    if best + n >= input_length {
      break;
    }

    for i in 0..n {
      let gain = window[i];
      out_left[out_pos + i] += left[best + i] * gain;
      out_right[out_pos + i] += right[best + i] * gain;
      norm[out_pos + i] += gain;
    }

    // The next grain should sound like this one, continued by one hop.
    let continue_at = best + hop;
    for i in 0..corr_window {
      template[i] = if continue_at + i < input_length { mono[continue_at + i] } else { 0.0 };
    }

    out_pos += hop;
  }

  for i in 0..out_length {
    let gain = norm[i].max(0.35);
    out_left[i] /= gain;
    out_right[i] /= gain;
  }

  out_left.truncate(out_length);
  out_right.truncate(out_length);
  Stretched {
    left: out_left,
    right: out_right,
    length: out_length,
  }
}

/// Shared between the sync and async entry points in `lib.rs`.
pub type SharedSamples = Arc<Vec<f32>>;
