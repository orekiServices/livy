//! MP3 encoding — the other half of a transcode.
//!
//! Pure Rust (shine), so the addon still cross-compiles to every platform
//! with nothing but a Rust toolchain. Shine is a fixed-point encoder: not as
//! clever as LAME at very low bitrates, but at the 128–192 kbps a relay uses
//! it is transparent enough and it runs at ~150x realtime, which is what
//! matters when one node is transcoding several stations at once.

use shine_rs::{Mp3Encoder, Mp3EncoderConfig, StereoMode};

/// Rates shine (and MPEG 1/2/2.5 Layer III) can actually write.
const MP3_RATES: [u32; 9] = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

/// Pick the MP3 sample rate for a decoded stream: the same rate when it is
/// legal (no resampling, no quality lost), otherwise the nearest one below.
pub fn target_rate(rate: u32) -> u32 {
  if MP3_RATES.contains(&rate) {
    return rate;
  }
  // 96k → 48k, 88.2k → 44.1k, 64k → 32k: exact halves keep the resampler honest.
  if rate % 2 == 0 && MP3_RATES.contains(&(rate / 2)) {
    return rate / 2;
  }
  *MP3_RATES
    .iter()
    .rev()
    .find(|&&candidate| candidate <= rate)
    .unwrap_or(&44100)
}

pub struct Encoder {
  inner: Mp3Encoder,
  pub sample_rate: u32,
  pub channels: u8,
  /// Source rate, when it differs from `sample_rate` and needs resampling.
  source_rate: u32,
  /// Fractional read position kept across chunks so resampling never clicks.
  position: f64,
  /// One sample of history per channel, for interpolating across a boundary.
  last: (f32, f32),
  primed: bool,
}

impl Encoder {
  pub fn new(source_rate: u32, channels: u8, bitrate: u32) -> Result<Self, String> {
    let sample_rate = target_rate(source_rate);
    let config = Mp3EncoderConfig::new()
      .sample_rate(sample_rate)
      .bitrate(bitrate.clamp(32, 320))
      .channels(channels.clamp(1, 2))
      .stereo_mode(if channels <= 1 { StereoMode::Mono } else { StereoMode::JointStereo });

    let inner = Mp3Encoder::new(config).map_err(|e| format!("mp3 encoder: {e:?}"))?;
    Ok(Encoder {
      inner,
      sample_rate,
      channels: channels.clamp(1, 2),
      source_rate,
      position: 0.0,
      last: (0.0, 0.0),
      primed: false,
    })
  }

  /// Encode a block of planar float samples. Returns MP3 bytes, which may be
  /// empty while the encoder fills its first frame.
  pub fn push(&mut self, left: &[f32], right: &[f32]) -> Result<Vec<u8>, String> {
    if left.is_empty() {
      return Ok(Vec::new());
    }

    let interleaved = if self.source_rate == self.sample_rate {
      let mut pcm = Vec::with_capacity(left.len() * self.channels as usize);
      for i in 0..left.len() {
        pcm.push(to_i16(left[i]));
        if self.channels > 1 {
          pcm.push(to_i16(*right.get(i).unwrap_or(&left[i])));
        }
      }
      pcm
    } else {
      self.resample(left, right)
    };

    let mut out = Vec::new();
    for block in self
      .inner
      .encode_interleaved(&interleaved)
      .map_err(|e| format!("mp3 encode: {e:?}"))?
    {
      out.extend_from_slice(&block);
    }
    Ok(out)
  }

  /// Flush the encoder's tail. The instance must not be used afterwards.
  pub fn finish(&mut self) -> Result<Vec<u8>, String> {
    self.inner.finish().map_err(|e| format!("mp3 flush: {e:?}"))
  }

  /// Linear resampling with the phase carried across calls.
  ///
  /// Only used for rates MP3 cannot write (96 kHz FLAC, mostly). Linear is
  /// crude, but the common case is an exact 2:1 ratio where it is just an
  /// average of two samples, and the alternative is refusing to play the
  /// stream at all.
  fn resample(&mut self, left: &[f32], right: &[f32]) -> Vec<i16> {
    let ratio = self.source_rate as f64 / self.sample_rate as f64;
    let stereo = self.channels > 1;
    let mut out = Vec::with_capacity((left.len() as f64 / ratio) as usize * self.channels as usize + 4);

    if !self.primed {
      self.last = (left[0], *right.first().unwrap_or(&left[0]));
      self.primed = true;
    }

    let mut at = self.position;
    while at < left.len() as f64 {
      let index = at.floor() as usize;
      let frac = (at - at.floor()) as f32;

      let (l0, r0) = if index == 0 {
        self.last
      } else {
        (left[index - 1], *right.get(index - 1).unwrap_or(&left[index - 1]))
      };
      let l1 = left[index];
      let r1 = *right.get(index).unwrap_or(&l1);

      out.push(to_i16(l0 + (l1 - l0) * frac));
      if stereo {
        out.push(to_i16(r0 + (r1 - r0) * frac));
      }
      at += ratio;
    }

    let last = left.len() - 1;
    self.last = (left[last], *right.get(last).unwrap_or(&left[last]));
    self.position = at - left.len() as f64;
    out
  }
}

#[inline]
fn to_i16(sample: f32) -> i16 {
  (sample.clamp(-1.0, 1.0) * 32767.0) as i16
}
