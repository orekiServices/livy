//! Livy native audio module — Node-API bindings.
//!
//! Performance-critical audio operations implemented in Rust:
//! - M3U8/HLS playlist parsing
//! - Audio format detection (magic bytes)
//! - PCM16 gain application
//! - MP3 frame counting
//! - PCM16 resampling (linear interpolation)
//!
//! The TypeScript layer (`src/audio/native.ts`) falls back to pure JS
//! implementations when this addon is not built, so behaviour is
//! identical with or without the native module.

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// A single HLS media segment.
#[napi(object)]
pub struct HlsSegment {
    pub uri: String,
    pub duration: f64,
    pub sequence: i64,
}

/// Parse an M3U8 media playlist into segments, resolving URIs against
/// `base_url`. Master playlists return an empty segment list.
#[napi]
pub fn parse_m3u8(playlist: String, base_url: String) -> Result<Vec<HlsSegment>> {
    let base = url::Url::parse(&base_url)
        .map_err(|e| Error::new(Status::InvalidArg, format!("invalid base URL: {e}")))?;

    let mut segments = Vec::new();
    let mut sequence: i64 = 0;
    let mut pending_duration: f64 = 0.0;

    for raw_line in playlist.lines() {
        let line = raw_line.trim();
        if let Some(rest) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            sequence = rest.parse::<i64>().unwrap_or(0);
        } else if let Some(rest) = line.strip_prefix("#EXTINF:") {
            let dur_str = rest.split(',').next().unwrap_or("0");
            pending_duration = dur_str.parse::<f64>().unwrap_or(0.0);
        } else if !line.is_empty() && !line.starts_with('#') {
            let uri = base
                .join(line)
                .map(|u| u.to_string())
                .unwrap_or_else(|_| line.to_string());
            segments.push(HlsSegment {
                uri,
                duration: pending_duration,
                sequence,
            });
            sequence += 1;
            pending_duration = 0.0;
        }
    }

    Ok(segments)
}

/// Detect an audio format from magic bytes. Returns one of:
/// "mp3" | "flac" | "ogg" | "wav" | "aac" | "unknown".
#[napi]
pub fn detect_format(header: Buffer) -> String {
    let bytes: &[u8] = &header;
    if bytes.len() >= 4 && &bytes[0..4] == b"fLaC" {
        return "flac".to_string();
    }
    if bytes.len() >= 3 && &bytes[0..3] == b"ID3" {
        return "mp3".to_string();
    }
    if bytes.len() >= 2 && bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0 {
        return "mp3".to_string();
    }
    if bytes.len() >= 4 && &bytes[0..4] == b"OggS" {
        return "ogg".to_string();
    }
    if bytes.len() >= 4 && &bytes[0..4] == b"RIFF" {
        return "wav".to_string();
    }
    if bytes.len() >= 12 && &bytes[8..12] == b"ftyp" {
        return "aac".to_string();
    }
    "unknown".to_string()
}

/// Apply a linear gain to interleaved PCM16-LE samples.
#[napi]
pub fn apply_gain_pcm16(samples: Buffer, gain: f64) -> Buffer {
    let input: &[u8] = &samples;
    let mut out = vec![0u8; input.len()];
    let frames = input.len() / 2;
    for i in 0..frames {
        let v = i16::from_le_bytes([input[i * 2], input[i * 2 + 1]]) as f64;
        let g = (v * gain).round().clamp(-32768.0, 32767.0) as i16;
        out[i * 2..i * 2 + 2].copy_from_slice(&g.to_le_bytes());
    }
    Buffer::from(out)
}

/// Count MP3 frame sync markers (0xFF 0xE0 mask) in a buffer.
#[napi]
pub fn count_mp3_frames(data: Buffer) -> i64 {
    let bytes: &[u8] = &data;
    let mut count: i64 = 0;
    if bytes.len() < 2 {
        return 0;
    }
    for i in 0..bytes.len() - 1 {
        if bytes[i] == 0xFF && (bytes[i + 1] & 0xE0) == 0xE0 {
            count += 1;
        }
    }
    count
}

/// Resample interleaved PCM16-LE samples from `from_rate` to `to_rate`
/// using nearest-neighbour (zero-order hold) interpolation.
#[napi]
pub fn resample_pcm16(samples: Buffer, from_rate: f64, to_rate: f64) -> Buffer {
    let input: &[u8] = &samples;
    if from_rate <= 0.0 || to_rate <= 0.0 || (from_rate - to_rate).abs() < f64::EPSILON {
        return Buffer::from(input.to_vec());
    }
    let frames = input.len() / 2;
    let out_frames = ((frames as f64 * to_rate / from_rate) as usize).max(1);
    let mut out = vec![0u8; out_frames * 2];
    for i in 0..out_frames {
        let src_idx = ((i as f64 * from_rate / to_rate) as usize).min(frames.saturating_sub(1));
        out[i * 2..i * 2 + 2].copy_from_slice(&input[src_idx * 2..src_idx * 2 + 2]);
    }
    Buffer::from(out)
}
