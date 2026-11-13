//! MetroFX — station filters as native kernels.
//!
//! Livy's filter chain is written in JavaScript first. It has to be: the
//! console, the preview renderer and a serverless deployment all need it, and
//! there is no toolchain in that environment. But a station runs the same
//! filters over every block, every listener, for weeks, and four of them are
//! per-sample maths that Rust does several times faster:
//!
//!   • **Biquad** — the 15-band EQ, the low/high-pass and the tesseract shaper.
//!   • **Compressor** — a `log10` and a `pow` per sample, per channel pair.
//!   • **Reverb** — 24 delay lines and 24 multiplies per sample.
//!   • **Distortion** — four waveshapers at 4× the stream rate.
//!
//! Each class owns its own state, exactly like the JavaScript object it
//! replaces, so the chain keeps calling `process(left, right, length)` per
//! block and the block boundary stays inaudible. The algorithms mirror
//! `server/src/core/filters/` deliberately; `metrofx` is faster, not a
//! different sound.
//!
//! Nothing here is required. `server/src/util/fx.js` loads this addon when a
//! binary exists and the JavaScript filters run otherwise.

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// A biquad section, transposed direct form II, two channels.
///
/// Coefficients and state are f64 even though the samples are f32: a 25 Hz
/// band on a 44.1 kHz stream has coefficients within 1e-5 of each other, and
/// that is exactly where f32 arithmetic loses the signal to rounding.
#[napi]
pub struct Biquad {
  b0: f64,
  b1: f64,
  b2: f64,
  a1: f64,
  a2: f64,
  z1l: f64,
  z2l: f64,
  z1r: f64,
  z2r: f64,
}

impl Biquad {
  fn new_inner() -> Self {
    Self {
      b0: 1.0,
      b1: 0.0,
      b2: 0.0,
      a1: 0.0,
      a2: 0.0,
      z1l: 0.0,
      z2l: 0.0,
      z1r: 0.0,
      z2r: 0.0,
    }
  }

  fn run_l(&mut self, sample: f64) -> f64 {
    let out = self.b0 * sample + self.z1l;
    self.z1l = self.b1 * sample - self.a1 * out + self.z2l;
    self.z2l = self.b2 * sample - self.a2 * out;
    out
  }

  fn run_r(&mut self, sample: f64) -> f64 {
    let out = self.b0 * sample + self.z1r;
    self.z1r = self.b1 * sample - self.a1 * out + self.z2r;
    self.z2r = self.b2 * sample - self.a2 * out;
    out
  }
}

#[napi]
impl Biquad {
  #[napi(constructor)]
  pub fn new() -> Self {
    Self::new_inner()
  }

  #[napi]
  pub fn set_coefficients(&mut self, b0: f64, b1: f64, b2: f64, a1: f64, a2: f64) {
    self.b0 = b0;
    self.b1 = b1;
    self.b2 = b2;
    self.a1 = a1;
    self.a2 = a2;
  }

  /// Peaking band, `gain_db` at `frequency` — the EQ's 15 bands.
  #[napi]
  pub fn set_peaking(&mut self, frequency: f64, gain_db: f64, sample_rate: f64, q: Option<f64>) {
    let q = q.unwrap_or(1.41);
    let a = 10f64.powf(gain_db / 40.0);
    let w0 = 2.0 * std::f64::consts::PI * frequency / sample_rate;
    let cos = w0.cos();
    let alpha = w0.sin() / (2.0 * q);
    let a0 = 1.0 + alpha / a;
    self.b0 = (1.0 + alpha * a) / a0;
    self.b1 = -2.0 * cos / a0;
    self.b2 = (1.0 - alpha * a) / a0;
    self.a1 = -2.0 * cos / a0;
    self.a2 = (1.0 - alpha / a) / a0;
  }

  #[napi]
  pub fn set_lowpass(&mut self, frequency: f64, sample_rate: f64, q: Option<f64>) {
    let q = q.unwrap_or(std::f64::consts::FRAC_1_SQRT_2);
    let w0 = 2.0 * std::f64::consts::PI * frequency / sample_rate;
    let cos = w0.cos();
    let alpha = w0.sin() / (2.0 * q);
    let a0 = 1.0 + alpha;
    self.b0 = (1.0 - cos) / 2.0 / a0;
    self.b1 = (1.0 - cos) / a0;
    self.b2 = (1.0 - cos) / 2.0 / a0;
    self.a1 = -2.0 * cos / a0;
    self.a2 = (1.0 - alpha) / a0;
  }

  #[napi]
  pub fn set_highpass(&mut self, frequency: f64, sample_rate: f64, q: Option<f64>) {
    let q = q.unwrap_or(std::f64::consts::FRAC_1_SQRT_2);
    let w0 = 2.0 * std::f64::consts::PI * frequency / sample_rate;
    let cos = w0.cos();
    let alpha = w0.sin() / (2.0 * q);
    let a0 = 1.0 + alpha;
    self.b0 = (1.0 + cos) / 2.0 / a0;
    self.b1 = -(1.0 + cos) / a0;
    self.b2 = (1.0 + cos) / 2.0 / a0;
    self.a1 = -2.0 * cos / a0;
    self.a2 = (1.0 - alpha) / a0;
  }

  /// Process both channels in place. `length` defaults to the shorter array.
  #[napi]
  pub fn process(&mut self, mut left: Float32Array, mut right: Float32Array, length: Option<u32>) {
    let l = left.as_mut();
    let r = right.as_mut();
    let n = length.map(|n| n as usize).unwrap_or_else(|| l.len().min(r.len()));
    let n = n.min(l.len()).min(r.len());
    for i in 0..n {
      l[i] = self.run_l(l[i] as f64) as f32;
      r[i] = self.run_r(r[i] as f64) as f32;
    }
  }

  #[napi]
  pub fn reset(&mut self) {
    self.z1l = 0.0;
    self.z2l = 0.0;
    self.z1r = 0.0;
    self.z2r = 0.0;
  }
}

/// Stereo-linked soft-knee compressor, same detector and gain smoothing as
/// `filters/compressor.js`.
#[napi]
pub struct Compressor {
  threshold_db: f64,
  ratio: f64,
  attack: f64,
  release: f64,
  gain: f64,
  makeup: f64,
  envelope: f64,
  gain_per_sample: f64,
}

#[napi]
impl Compressor {
  #[napi(constructor)]
  pub fn new() -> Self {
    Self {
      threshold_db: 0.0,
      ratio: 1.0,
      attack: 0.0,
      release: 0.0,
      gain: 1.0,
      makeup: 1.0,
      envelope: 0.0,
      gain_per_sample: 1.0,
    }
  }

  #[napi]
  pub fn set_params(
    &mut self,
    threshold: f64,
    ratio: f64,
    attack_seconds: f64,
    release_seconds: f64,
    gain: f64,
    makeup: f64,
    sample_rate: f64,
  ) {
    self.threshold_db = 20.0 * (threshold.max(1e-4)).log10();
    self.ratio = ratio.max(1.0);
    self.attack = (-1.0 / (attack_seconds.max(1e-4) * sample_rate)).exp();
    self.release = (-1.0 / (release_seconds.max(1e-4) * sample_rate)).exp();
    self.gain = gain;
    self.makeup = makeup;
  }

  fn reduction(&self, input_db: f64) -> f64 {
    const KNEE_DB: f64 = 6.0;
    let over = input_db - self.threshold_db;
    if over <= -KNEE_DB / 2.0 {
      return 0.0;
    }
    if over >= KNEE_DB / 2.0 {
      return over * (1.0 - 1.0 / self.ratio);
    }
    let t = over + KNEE_DB / 2.0;
    ((1.0 - 1.0 / self.ratio) * t * t) / (2.0 * KNEE_DB)
  }

  #[napi]
  pub fn process(&mut self, mut left: Float32Array, mut right: Float32Array, length: Option<u32>) {
    let l = left.as_mut();
    let r = right.as_mut();
    let n = length.map(|n| n as usize).unwrap_or_else(|| l.len().min(r.len()));
    let n = n.min(l.len()).min(r.len());
    for i in 0..n {
      let driven_left = l[i] as f64 * self.gain;
      let driven_right = r[i] as f64 * self.gain;
      let peak = driven_left.abs().max(driven_right.abs());
      let coefficient = if peak > self.envelope { self.attack } else { self.release };
      self.envelope = peak + coefficient * (self.envelope - peak);

      let level_db = 20.0 * self.envelope.max(1e-5).log10();
      let target = 10f64.powf(-self.reduction(level_db) / 20.0);
      let smoothed = target + coefficient * (self.gain_per_sample - target);
      self.gain_per_sample = smoothed;

      let gain = smoothed * self.makeup;
      l[i] = (driven_left * gain).clamp(-1.0, 1.0) as f32;
      r[i] = (driven_right * gain).clamp(-1.0, 1.0) as f32;
    }
  }

  #[napi]
  pub fn reset(&mut self) {
    self.envelope = 0.0;
    self.gain_per_sample = 1.0;
  }
}

struct Comb {
  buffer: Vec<f32>,
  index: usize,
  filter: f32,
  feedback: f32,
  damp: f32,
}

impl Comb {
  fn new(size: usize) -> Self {
    Self { buffer: vec![0.0; size.max(2)], index: 0, filter: 0.0, feedback: 0.5, damp: 0.5 }
  }

  fn run(&mut self, input: f32) -> f32 {
    let output = self.buffer[self.index];
    self.filter = output * (1.0 - self.damp) + self.filter * self.damp;
    self.buffer[self.index] = input + self.filter * self.feedback;
    self.index = (self.index + 1) % self.buffer.len();
    output
  }

  fn reset(&mut self) {
    self.buffer.fill(0.0);
    self.filter = 0.0;
  }
}

struct Allpass {
  buffer: Vec<f32>,
  index: usize,
  feedback: f32,
}

impl Allpass {
  fn new(size: usize) -> Self {
    Self { buffer: vec![0.0; size.max(2)], index: 0, feedback: 0.5 }
  }

  fn run(&mut self, input: f32) -> f32 {
    let delayed = self.buffer[self.index];
    self.buffer[self.index] = input + delayed * self.feedback;
    self.index = (self.index + 1) % self.buffer.len();
    delayed - input
  }

  fn reset(&mut self) {
    self.buffer.fill(0.0);
  }
}

const COMB_DELAYS: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_DELAYS: [usize; 4] = [556, 441, 341, 225];
const STEREO_SPREAD: usize = 23;
const INPUT_GAIN: f32 = 0.015;

/// Freeverb-style reverb: eight combs into four all-passes per channel.
#[napi]
pub struct Reverb {
  combs_l: Vec<Comb>,
  combs_r: Vec<Comb>,
  allpass_l: Vec<Allpass>,
  allpass_r: Vec<Allpass>,
  width: f32,
  wet: f32,
  dry: f32,
}

#[napi]
impl Reverb {
  #[napi(constructor)]
  pub fn new(sample_rate: Option<u32>) -> Self {
    let rate = sample_rate.unwrap_or(44_100) as f64 / 44_100.0;
    let scale = |size: usize| (size as f64 * rate).round() as usize;
    Self {
      combs_l: COMB_DELAYS.iter().map(|size| Comb::new(scale(*size))).collect(),
      combs_r: COMB_DELAYS.iter().map(|size| Comb::new(scale(*size + STEREO_SPREAD))).collect(),
      allpass_l: ALLPASS_DELAYS.iter().map(|size| Allpass::new(scale(*size))).collect(),
      allpass_r: ALLPASS_DELAYS.iter().map(|size| Allpass::new(scale(*size + STEREO_SPREAD))).collect(),
      width: 0.0,
      wet: 0.0,
      dry: 1.0,
    }
  }

  /// `room_size` and `damping` are 0…1 as in the console; feedback stays just
  /// below 1 the way Freeverb's own mapping does.
  #[napi]
  pub fn set_params(&mut self, room_size: f64, damping: f64, width: f64, wet: f64, dry: f64) {
    let feedback = (0.7 + room_size.clamp(0.0, 1.0) * 0.28) as f32;
    let damp = (damping.clamp(0.0, 1.0) * 0.4) as f32;
    for comb in self.combs_l.iter_mut().chain(self.combs_r.iter_mut()) {
      comb.feedback = feedback;
      comb.damp = damp;
    }
    self.width = width.clamp(0.0, 1.0) as f32;
    self.wet = wet.clamp(0.0, 1.0) as f32;
    self.dry = dry.clamp(0.0, 1.0) as f32;
  }

  #[napi]
  pub fn process(&mut self, mut left: Float32Array, mut right: Float32Array, length: Option<u32>) {
    let l = left.as_mut();
    let r = right.as_mut();
    let n = length.map(|n| n as usize).unwrap_or_else(|| l.len().min(r.len()));
    let n = n.min(l.len()).min(r.len());
    for i in 0..n {
      let input = (l[i] + r[i]) * 0.5 * INPUT_GAIN;
      let mut out_l = 0.0f32;
      let mut out_r = 0.0f32;
      for comb in self.combs_l.iter_mut() {
        out_l += comb.run(input);
      }
      for comb in self.combs_r.iter_mut() {
        out_r += comb.run(input);
      }
      for allpass in self.allpass_l.iter_mut() {
        out_l = allpass.run(out_l);
      }
      for allpass in self.allpass_r.iter_mut() {
        out_r = allpass.run(out_r);
      }

      let mid = (out_l + out_r) * 0.5;
      out_l = out_l * self.width + mid * (1.0 - self.width);
      out_r = out_r * self.width + mid * (1.0 - self.width);
      l[i] = l[i] * self.dry + out_l * self.wet;
      r[i] = r[i] * self.dry + out_r * self.wet;
    }
  }

  #[napi]
  pub fn reset(&mut self) {
    for comb in self.combs_l.iter_mut().chain(self.combs_r.iter_mut()) {
      comb.reset();
    }
    for allpass in self.allpass_l.iter_mut().chain(self.allpass_r.iter_mut()) {
      allpass.reset();
    }
  }
}

/// 4× oversampled waveshaper, matching `filters/distortion.js`.
#[napi]
pub struct Distortion {
  sin_offset: f64,
  sin_scale: f64,
  cos_offset: f64,
  cos_scale: f64,
  tan_offset: f64,
  tan_scale: f64,
  offset: f64,
  scale: f64,
  previous_l: f64,
  previous_r: f64,
  lowpass_l: Biquad,
  lowpass_r: Biquad,
  oversample: u32,
}

#[napi]
impl Distortion {
  #[napi(constructor)]
  pub fn new(sample_rate: Option<u32>, oversample: Option<u32>) -> Self {
    let rate = sample_rate.unwrap_or(44_100) as f64;
    let os = oversample.unwrap_or(4).clamp(1, 8);
    let mut lowpass_l = Biquad::new_inner();
    let mut lowpass_r = Biquad::new_inner();
    lowpass_l.set_lowpass(rate * 0.45, rate * os as f64, None);
    lowpass_r.set_lowpass(rate * 0.45, rate * os as f64, None);
    Self {
      sin_offset: 0.0,
      sin_scale: 1.0,
      cos_offset: 0.0,
      cos_scale: 1.0,
      tan_offset: 0.0,
      tan_scale: 1.0,
      offset: 0.0,
      scale: 1.0,
      previous_l: 0.0,
      previous_r: 0.0,
      lowpass_l,
      lowpass_r,
      oversample: os,
    }
  }

  #[napi]
  #[allow(clippy::too_many_arguments)]
  pub fn set_params(
    &mut self,
    sin_offset: f64,
    sin_scale: f64,
    cos_offset: f64,
    cos_scale: f64,
    tan_offset: f64,
    tan_scale: f64,
    offset: f64,
    scale: f64,
  ) {
    self.sin_offset = sin_offset;
    self.sin_scale = sin_scale;
    self.cos_offset = cos_offset;
    self.cos_scale = cos_scale;
    self.tan_offset = tan_offset;
    self.tan_scale = tan_scale;
    self.offset = offset;
    self.scale = scale;
  }

  fn shape(&self, input: f64) -> f64 {
    let sin = self.sin_offset != 0.0 || self.sin_scale != 1.0;
    let cos = self.cos_offset != 0.0 || self.cos_scale != 1.0;
    let tan = self.tan_offset != 0.0 || self.tan_scale != 1.0;
    let mut x = input;
    if sin {
      x = (x * self.sin_scale + self.sin_offset).sin();
    }
    if cos {
      x = (x * self.cos_scale + self.cos_offset).cos();
    }
    if tan {
      x = (x * self.tan_scale + self.tan_offset).tanh();
    }
    x = x * self.scale + self.offset;
    // The same normalised tanh soft clip the JavaScript uses: ±1 maps to ±1,
    // and anything beyond is bounded rather than clipped hard.
    ((x * 1.1).tanh() / 1.1f64.tanh()).clamp(-1.0, 1.0)
  }

  #[napi]
  pub fn process(&mut self, mut left: Float32Array, mut right: Float32Array, length: Option<u32>) {
    let l = left.as_mut();
    let r = right.as_mut();
    let n = length.map(|n| n as usize).unwrap_or_else(|| l.len().min(r.len()));
    let n = n.min(l.len()).min(r.len());
    let steps = self.oversample.max(1) as f64;
    for i in 0..n {
      let target_l = l[i] as f64;
      let target_r = r[i] as f64;
      let mut out_l = self.previous_l;
      let mut out_r = self.previous_r;
      for step in 1..=self.oversample.max(1) {
        let t = step as f64 / steps;
        let up_l = self.previous_l + (target_l - self.previous_l) * t;
        let up_r = self.previous_r + (target_r - self.previous_r) * t;
        out_l = self.lowpass_l.run_l(self.shape(up_l));
        out_r = self.lowpass_r.run_r(self.shape(up_r));
      }
      self.previous_l = target_l;
      self.previous_r = target_r;
      l[i] = (out_l as f32).clamp(-1.0, 1.0);
      r[i] = (out_r as f32).clamp(-1.0, 1.0);
    }
  }

  #[napi]
  pub fn reset(&mut self) {
    self.lowpass_l.reset();
    self.lowpass_r.reset();
    self.previous_l = 0.0;
    self.previous_r = 0.0;
  }
}

#[napi]
pub fn version() -> String {
  env!("CARGO_PKG_VERSION").to_string()
}

#[napi]
pub fn describe() -> String {
  format!(
    "MetroFX {} · {} · {} · rust {}",
    env!("CARGO_PKG_VERSION"),
    std::env::consts::OS,
    std::env::consts::ARCH,
    option_env!("METRO_RUSTC").unwrap_or("stable")
  )
}
