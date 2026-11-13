//! Decoding, for the one place Livy actually needs samples: the automix
//! seam. Everything else is passthrough, so this is called for a few seconds
//! of audio per track change and wants to be quick and allocation-light.
//!
//! Symphonia is pure Rust, so the same code cross-compiles to every platform
//! we ship a binary for — no ffmpeg, no system codecs, no WASM warm-up.

use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::default::{get_codecs, get_probe};

use std::io::Cursor;

pub struct Pcm {
  pub left: Vec<f32>,
  pub right: Vec<f32>,
  pub sample_rate: u32,
  pub channels: u8,
  /// What it turned out to be: "mp3", "aac", "flac", "vorbis"…
  pub codec: String,
}

/// Decode a whole MP3 buffer (the automix seam path).
pub fn decode(bytes: Vec<u8>) -> Result<Pcm, String> {
  decode_with_hint(bytes, Some("mp3"))
}

/// Decode any container symphonia can read — MP3, AAC/MP4, FLAC, Ogg/Vorbis,
/// WAV, Matroska/WebM — to f32 channels.
///
/// Mono in, mono duplicated out: every caller upstream expects two channels,
/// and doing it here saves a copy in JavaScript. `extension` is only a hint;
/// the probe still decides, so a mislabelled stream still plays.
pub fn decode_with_hint(bytes: Vec<u8>, extension: Option<&str>) -> Result<Pcm, String> {
  let source = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());

  let mut hint = Hint::new();
  if let Some(extension) = extension {
    hint.with_extension(extension);
  }

  let probed = get_probe()
    .format(&hint, source, &FormatOptions::default(), &MetadataOptions::default())
    .map_err(|e| format!("not decodable audio: {e}"))?;
  let mut format = probed.format;

  let track = format
    .tracks()
    .iter()
    .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
    .ok_or_else(|| "no audio track".to_string())?;
  let track_id = track.id;
  let codec = codec_name(track.codec_params.codec);

  let mut decoder = get_codecs()
    .make(&track.codec_params, &DecoderOptions::default())
    .map_err(|e| format!("no decoder: {e}"))?;

  let mut left: Vec<f32> = Vec::new();
  let mut right: Vec<f32> = Vec::new();
  let mut sample_rate = track.codec_params.sample_rate.unwrap_or(44_100);
  let mut channels: u8 = 2;

  loop {
    let packet = match format.next_packet() {
      Ok(packet) => packet,
      // A truncated stream is normal: a relay hands us whatever arrived.
      Err(SymphoniaError::IoError(_)) | Err(SymphoniaError::ResetRequired) => break,
      Err(SymphoniaError::DecodeError(_)) => continue,
      Err(e) => return Err(format!("read failed: {e}")),
    };
    if packet.track_id() != track_id {
      continue;
    }

    match decoder.decode(&packet) {
      Ok(decoded) => {
        let spec = *decoded.spec();
        sample_rate = spec.rate;
        channels = spec.channels.count().min(2) as u8;

        match decoded {
          AudioBufferRef::F32(buf) => append(&mut left, &mut right, buf.chan(0), buf.spec().channels.count(), |b| {
            buf.chan(b)
          }),
          other => {
            // Anything not already f32 gets converted once, in Rust.
            let count = other.spec().channels.count();
            let mut sample_buf =
              symphonia::core::audio::SampleBuffer::<f32>::new(other.capacity() as u64, *other.spec());
            sample_buf.copy_interleaved_ref(other);
            let samples = sample_buf.samples();
            for frame in samples.chunks(count) {
              left.push(frame[0]);
              right.push(if count > 1 { frame[1] } else { frame[0] });
            }
          }
        }
      }
      Err(SymphoniaError::DecodeError(_)) => continue, // one bad frame, keep going
      Err(e) => return Err(format!("decode failed: {e}")),
    }
  }

  if left.is_empty() {
    return Err("no audio decoded".to_string());
  }

  Ok(Pcm {
    left,
    right,
    sample_rate,
    channels,
    codec,
  })
}

/// Decode a stream as it arrives, handing out PCM in short pieces.
///
/// Used for containers that would otherwise have to be buffered whole — a
/// ten-minute lossless block, an endless Ogg stream. `emit` returns false to
/// stop (the listener went away). The source blocks in `read()` until more
/// bytes are pushed, so this must run on its own thread.
pub fn decode_stream<S, F>(source: S, extension: Option<&str>, mut emit: F) -> Result<(), String>
where
  S: symphonia::core::io::MediaSource + 'static,
  F: FnMut(Pcm) -> bool,
{
  let stream = MediaSourceStream::new(Box::new(source), Default::default());

  let mut hint = Hint::new();
  if let Some(extension) = extension {
    hint.with_extension(extension);
  }

  let probed = get_probe()
    .format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default())
    .map_err(|e| format!("not decodable audio: {e}"))?;
  let mut format = probed.format;

  let track = format
    .tracks()
    .iter()
    .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
    .ok_or_else(|| "no audio track".to_string())?;
  let track_id = track.id;
  let codec = codec_name(track.codec_params.codec);

  let mut decoder = get_codecs()
    .make(&track.codec_params, &DecoderOptions::default())
    .map_err(|e| format!("no decoder: {e}"))?;

  // Roughly half a second of audio per piece: long enough that the encoder
  // stays efficient, short enough that nothing waits on it.
  const PIECE: usize = 24_000;
  let mut left: Vec<f32> = Vec::with_capacity(PIECE * 2);
  let mut right: Vec<f32> = Vec::with_capacity(PIECE * 2);
  let mut sample_rate = 0u32;
  let mut channels = 2u8;

  loop {
    let packet = match format.next_packet() {
      Ok(packet) => packet,
      Err(SymphoniaError::IoError(_)) | Err(SymphoniaError::ResetRequired) => break,
      Err(SymphoniaError::DecodeError(_)) => continue,
      Err(_) => break,
    };
    if packet.track_id() != track_id {
      continue;
    }

    match decoder.decode(&packet) {
      Ok(decoded) => {
        let spec = *decoded.spec();
        sample_rate = spec.rate;
        channels = spec.channels.count().min(2) as u8;
        push_samples(&mut left, &mut right, decoded);
      }
      Err(SymphoniaError::DecodeError(_)) => continue,
      Err(_) => break,
    }

    if left.len() >= PIECE {
      if !emit(Pcm {
        left: std::mem::take(&mut left),
        right: std::mem::take(&mut right),
        sample_rate,
        channels,
        codec: codec.clone(),
      }) {
        return Ok(());
      }
      left = Vec::with_capacity(PIECE * 2);
      right = Vec::with_capacity(PIECE * 2);
    }
  }

  if !left.is_empty() {
    emit(Pcm {
      left,
      right,
      sample_rate,
      channels,
      codec,
    });
  }
  Ok(())
}

/// Planar or interleaved, any sample format → two float channels.
fn push_samples(left: &mut Vec<f32>, right: &mut Vec<f32>, decoded: AudioBufferRef<'_>) {
  let channels = decoded.spec().channels.count();
  match decoded {
    AudioBufferRef::F32(buf) => {
      left.extend_from_slice(buf.chan(0));
      right.extend_from_slice(buf.chan(if channels > 1 { 1 } else { 0 }));
    }
    other => {
      let mut samples = symphonia::core::audio::SampleBuffer::<f32>::new(other.capacity() as u64, *other.spec());
      samples.copy_interleaved_ref(other);
      for frame in samples.samples().chunks(channels) {
        left.push(frame[0]);
        right.push(if channels > 1 { frame[1] } else { frame[0] });
      }
    }
  }
}

/// A short, human name for a symphonia codec id.
fn codec_name(codec: symphonia::core::codecs::CodecType) -> String {
  use symphonia::core::codecs::*;
  let named = [
    (CODEC_TYPE_MP3, "mp3"),
    (CODEC_TYPE_AAC, "aac"),
    (CODEC_TYPE_FLAC, "flac"),
    (CODEC_TYPE_VORBIS, "vorbis"),
    (CODEC_TYPE_ALAC, "alac"),
    (CODEC_TYPE_PCM_S16LE, "pcm"),
    (CODEC_TYPE_PCM_S24LE, "pcm"),
    (CODEC_TYPE_PCM_F32LE, "pcm"),
    (CODEC_TYPE_ADPCM_IMA_WAV, "adpcm"),
  ];
  named
    .iter()
    .find(|(id, _)| *id == codec)
    .map(|(_, name)| (*name).to_string())
    .unwrap_or_else(|| "audio".to_string())
}

/// Push a planar buffer into the two output channels.
fn append<'a, F>(left: &mut Vec<f32>, right: &mut Vec<f32>, first: &[f32], channels: usize, chan: F)
where
  F: Fn(usize) -> &'a [f32],
{
  left.extend_from_slice(first);
  if channels > 1 {
    right.extend_from_slice(chan(1));
  } else {
    right.extend_from_slice(first);
  }
}
