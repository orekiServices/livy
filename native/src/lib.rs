//! Livy native addon — performance-critical audio & streaming operations.
//!
//! Exposes napi-rs bindings for:
//! - `version` / `supportedCodecs` — capability probing
//! - `probeAudio` — codec detection from raw bytes (MP3/FLAC/AAC/Opus/Vorbis)
//! - `parseHlsPlaylist` — M3U8 parsing (master + media playlists)
//! - `icyParse` — Shoutcast/Icecast ICY metadata stripping
//! - `bufferStats` — zero-copy buffer statistics for benchmarking
//!
//! The TypeScript layer treats this addon as optional and falls back to
//! pure-TypeScript implementations when it is not built.

#![deny(clippy::all)]

mod audio;
mod hls;
mod icy;

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Addon version, reported to the TypeScript layer at startup.
#[napi]
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Codecs supported by the native pipeline.
#[napi]
pub fn supported_codecs() -> Vec<String> {
    vec![
        "mp3".to_string(),
        "flac".to_string(),
        "aac".to_string(),
        "opus".to_string(),
        "vorbis".to_string(),
    ]
}

/// Probe audio format from the first bytes of a stream.
///
/// Returns `None` when the format cannot be determined.
#[napi]
pub fn probe_audio(data: Uint8Array) -> Option<AudioInfo> {
    audio::probe(&data.to_vec())
}

/// Parse an M3U8 playlist. Returns a JSON string (kept as a string so the
/// TypeScript side can validate it with zod and stay in control of types).
///
/// # Errors
/// Returns an error when the playlist text is not valid M3U8.
#[napi]
pub fn parse_hls_playlist(text: String, base_url: String) -> Result<String> {
    let playlist = hls::parse(&text, &base_url)?;
    Ok(serde_json::to_string(&playlist).unwrap_or_else(|_| "{}".to_string()))
}

/// Strip one ICY metadata block from a chunk.
///
/// `metaint` is the `icy-metaint` header value: audio bytes between metadata
/// blocks. Returns the clean audio bytes plus the metadata title if present.
#[napi]
pub fn icy_parse(chunk: Uint8Array, metaint: u32) -> IcyResult {
    icy::parse_chunk(&chunk.to_vec(), metaint as usize)
}

/// Buffer statistics used by benchmarks (avoids JS-side allocation loops).
#[napi]
pub fn buffer_stats(data: Uint8Array) -> BufferStats {
    let bytes = data.to_vec();
    let len = bytes.len();
    let checksum: u64 = bytes.iter().map(|b| *b as u64).sum();
    BufferStats {
        length: len as u32,
        checksum,
    }
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct AudioInfo {
    pub codec: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub duration_ms: u32,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct IcyResult {
    pub audio: Uint8Array,
    pub metadata: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct BufferStats {
    pub length: u32,
    pub checksum: u64,
}
