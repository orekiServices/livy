//! libmetro — **MetroS**, the relay engine behind Livy.
//!
//! Livy forwards MP3 bytes rather than transcoding them, so the work that
//! actually scales with listeners and relays is *framing*: finding frame
//! boundaries in a live byte stream, throwing away tags and metadata, and
//! handing whole frames to the pacer. In JavaScript that means a Buffer concat
//! and a byte-wise scan per chunk; here it is a single pass over a slice.
//!
//! The Node side never requires this addon. `server/src/util/metro.js` loads
//! it when a binary for the current platform is present and falls back to the
//! pure-JS implementation when it is not — same API, same results, slower.
//!
//! It also transcodes, because a relay is not always MP3: a plugin may hand
//! the node an AAC Icecast stream, an HLS transport stream, Ogg/Vorbis, FLAC
//! or an MP4 segment, and Livy broadcasts MP3. Decode with symphonia,
//! re-encode with shine, both pure Rust — and MP3 input is still forwarded
//! byte for byte, because the fastest transcode is the one that never runs.
//!
//! Exposed to JavaScript:
//!   • `version()` / `describe()`      — what is loaded, and what it can do
//!   • `scanFrames(buf)`               — one-shot frame table
//!   • `Framer`                        — streaming re-framer for live relays
//!   • `decode(buf)` / `decodeAsync`   — MP3 → f32 channels (the automix seam)
//!   • `decodeAudio(buf)`              — any supported codec → f32 channels
//!   • `encodeMp3(left, right, …)`     — f32 channels → MP3 (the automix output)
//!   • `transcode(buf, bitrate)`       — any file/segment → MP3, one shot
//!   • `Transcoder`                    — the same, streaming, for live relays
//!   • `sniff(buf)`                    — what is this? (mp3/aac/mpeg-ts/…)
//!   • `analyseBeat(pcm)` / `Async`    — tempo, grid and confidence
//!   • `timeStretch(pcm, ratio)` / `Async` — WSOLA, pitch untouched

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

mod adts;
mod decode;
mod dsp;
mod encode;
mod framer;
mod stream_source;
mod transcode;
mod ts;

/// One frame, as JavaScript sees it.
#[napi(object)]
pub struct FrameInfo {
  pub offset: u32,
  pub length: u32,
  pub bitrate: u32,
  pub sample_rate: u32,
  pub channels: u32,
  pub samples: u32,
  pub version: u32,
  pub layer: u32,
  pub duration_ms: f64,
}

impl From<framer::Frame> for FrameInfo {
  fn from(f: framer::Frame) -> Self {
    FrameInfo {
      offset: f.offset as u32,
      length: f.length as u32,
      bitrate: f.bitrate,
      sample_rate: f.sample_rate,
      channels: f.channels as u32,
      samples: f.samples,
      version: f.version as u32,
      layer: f.layer as u32,
      duration_ms: f.duration_ms,
    }
  }
}

/// What a scan or a push found, in aggregate.
#[napi(object)]
pub struct StreamInfo {
  pub frames: u32,
  pub bytes: u32,
  pub duration_ms: f64,
  pub bitrate: u32,
  pub sample_rate: u32,
  pub channels: u32,
  pub vbr: bool,
}

/// Decoded audio: two channels of f32, whatever the source was.
#[napi(object)]
pub struct DecodedAudio {
  pub left: Float32Array,
  pub right: Float32Array,
  pub sample_rate: u32,
  pub channels: u32,
  pub length: u32,
}

#[napi]
pub fn version() -> String {
  env!("CARGO_PKG_VERSION").to_string()
}

/// A one-line description of the loaded binary — the owner console prints it,
/// and it is the quickest way to tell a native node from a fallback one.
#[napi]
pub fn describe() -> String {
  format!(
    "MetroS {} · {} · {} · rust {}",
    env!("CARGO_PKG_VERSION"),
    std::env::consts::OS,
    std::env::consts::ARCH,
    option_env!("METRO_RUSTC").unwrap_or("stable")
  )
}

/// Frame table for a complete buffer. `skipVbrHeader` drops a leading
/// Xing/Info frame, which is metadata, not audio.
#[napi]
pub fn scan_frames(data: Buffer, skip_vbr_header: Option<bool>) -> Vec<FrameInfo> {
  let (frames, _) = framer::scan(&data, skip_vbr_header.unwrap_or(true));
  frames.into_iter().map(FrameInfo::from).collect()
}

/// Measure a buffer without copying any audio out of it.
#[napi]
pub fn probe(data: Buffer) -> StreamInfo {
  let (frames, _) = framer::scan(&data, true);
  summarise(&frames, data.len())
}

fn summarise(frames: &[framer::Frame], bytes: usize) -> StreamInfo {
  let first = frames.first();
  let vbr = frames
    .windows(2)
    .any(|pair| pair[0].bitrate != pair[1].bitrate);
  StreamInfo {
    frames: frames.len() as u32,
    bytes: bytes as u32,
    duration_ms: frames.iter().map(|f| f.duration_ms).sum(),
    bitrate: first.map(|f| f.bitrate).unwrap_or(0),
    sample_rate: first.map(|f| f.sample_rate).unwrap_or(0),
    channels: first.map(|f| f.channels as u32).unwrap_or(0),
    vbr,
  }
}

/// What one `push()` produced.
///
/// Note the shape: **one** contiguous buffer plus the frame lengths, not an
/// array of buffers. Handing back 1700 little Buffers costs more than the
/// scan itself — an object, an ArrayBuffer and a GC root each. The JS side
/// makes zero-copy `subarray` views out of `data` when it wants individual
/// frames, and writes `data` straight to the socket when it doesn't.
#[napi(object)]
pub struct PushResult {
  /// Whole frames, back to back, ready to hand to the pacer or the socket.
  pub data: Buffer,
  /// Length of each frame inside `data`, in order — only when the framer was
  /// created with `{ lengths: true }`. Allocating a typed array per chunk
  /// costs more than the scan, so a relay that just forwards bytes says no.
  pub lengths: Option<Uint32Array>,
  /// Number of frames in `data`.
  pub frames: u32,
  pub duration_ms: f64,
  /// Bytes still held back because the last frame is incomplete.
  pub pending: u32,
  /// Bytes dropped while resynchronising (tags, metadata, junk).
  pub dropped: u32,
  pub info: Option<FrameInfo>,
}

/// What one `pushInto()` produced. Scalars only: no buffer is allocated,
/// so a relay in steady state does zero allocation per chunk.
#[napi(object)]
pub struct FillResult {
  /// Frames written into the caller's buffer.
  pub frames: u32,
  /// Bytes written — use `out.subarray(0, bytes)`.
  pub bytes: u32,
  pub duration_ms: f64,
  pub pending: u32,
  pub dropped: u32,
  /// True when frames were left behind because `out` was full; call again
  /// with an empty chunk to collect them.
  pub overflow: bool,
  /// The stream's format — sent on the first frames and again whenever it
  /// changes, so the caller can cache it and the steady state stays free of
  /// object allocation.
  pub format: Option<FrameInfo>,
}

/// How a `Framer` should behave.
#[napi(object)]
pub struct FramerOptions {
  /// Drop a leading Xing/Info/VBRI frame (it is metadata, not audio). Default true.
  pub skip_vbr_header: Option<bool>,
  /// Also return per-frame lengths. Default false — see `PushResult.lengths`.
  pub lengths: Option<bool>,
}

/// Streaming re-framer.
///
/// Feed it whatever arrives from the network; get whole MP3 frames back. It
/// resynchronises on its own, so joining a live stream mid-frame, an ID3 tag
/// in the middle of a shoutcast relay or a dropped packet cost nothing more
/// than the bytes involved.
#[napi]
pub struct Framer {
  buffer: Vec<u8>,
  scratch: Vec<u8>,
  skip: usize,
  skip_vbr_header: bool,
  want_lengths: bool,
  started: bool,
  total_frames: u64,
  total_bytes: u64,
  total_dropped: u64,
  total_ms: f64,
  bitrate: u32,
  sample_rate: u32,
  channels: u32,
  vbr: bool,
  reported: bool,
}

#[napi]
impl Framer {
  #[napi(constructor)]
  pub fn new(options: Option<FramerOptions>) -> Self {
    let options = options.unwrap_or(FramerOptions {
      skip_vbr_header: None,
      lengths: None,
    });
    Framer {
      buffer: Vec::with_capacity(64 * 1024),
      scratch: Vec::with_capacity(64 * 1024),
      skip: 0,
      skip_vbr_header: options.skip_vbr_header.unwrap_or(true),
      want_lengths: options.lengths.unwrap_or(false),
      started: false,
      total_frames: 0,
      total_bytes: 0,
      total_dropped: 0,
      total_ms: 0.0,
      bitrate: 0,
      sample_rate: 0,
      channels: 0,
      vbr: false,
      reported: false,
    }
  }

  /// Push a chunk of bytes; get whole frames back.
  #[napi]
  pub fn push(&mut self, chunk: Buffer) -> PushResult {
    self.total_bytes += chunk.len() as u64;

    // A tag bigger than one chunk is still being skipped.
    if self.skip > 0 {
      let drop = self.skip.min(chunk.len());
      self.skip -= drop;
      self.total_dropped += drop as u64;
      if drop == chunk.len() {
        return self.empty_result(0);
      }
      self.buffer.extend_from_slice(&chunk[drop..]);
    } else {
      self.buffer.extend_from_slice(&chunk);
    }

    // ID3v2 at the head of the stream: remember the remainder if it spans
    // chunks, so we never scan tag bytes looking for sync words.
    if !self.started {
      let tag = framer::id3v2_size(&self.buffer);
      if tag > 0 {
        let have = tag.min(self.buffer.len());
        self.skip = tag - have;
        self.buffer.drain(..have);
        self.total_dropped += have as u64;
      }
    }

    let (frames, consumed) = framer::scan(&self.buffer, self.skip_vbr_header && !self.started);
    if !frames.is_empty() {
      self.started = true;
    }

    if frames.is_empty() {
      self.buffer.drain(..consumed);
      self.total_dropped += consumed as u64;
      return self.empty_result(consumed as u32);
    }

    let audio_bytes: usize = frames.iter().map(|f| f.length).sum();
    let duration_ms: f64 = frames.iter().map(|f| f.duration_ms).sum();
    let start = frames[0].offset;
    let end = frames[frames.len() - 1].offset + frames[frames.len() - 1].length;

    // The usual case — nothing was dropped between the frames — needs no
    // intermediate buffer at all: the audio is already one contiguous run
    // inside the framer, so it goes straight to JavaScript in one copy.
    let data = if end - start == audio_bytes {
      Buffer::from(&self.buffer[start..end])
    } else {
      self.scratch.clear();
      self.scratch.reserve(audio_bytes);
      for frame in &frames {
        self.scratch
          .extend_from_slice(&self.buffer[frame.offset..frame.offset + frame.length]);
      }
      Buffer::from(self.scratch.as_slice())
    };

    let lengths = if self.want_lengths {
      Some(Uint32Array::new(
        frames.iter().map(|f| f.length as u32).collect(),
      ))
    } else {
      None
    };

    let head = frames[0];
    if self.bitrate != 0 && self.bitrate != head.bitrate {
      self.vbr = true;
    }
    self.bitrate = head.bitrate;
    self.sample_rate = head.sample_rate;
    self.channels = head.channels as u32;

    let dropped = consumed.saturating_sub(audio_bytes);
    self.total_dropped += dropped as u64;
    self.total_frames += frames.len() as u64;
    self.total_ms += duration_ms;

    // Keep only the incomplete tail.
    self.buffer.drain(..consumed);

    PushResult {
      data,
      lengths,
      frames: frames.len() as u32,
      duration_ms,
      pending: self.buffer.len() as u32,
      dropped: dropped as u32,
      info: Some(FrameInfo::from(head)),
    }
  }

  /// The allocation-free path: write whole frames into a buffer the caller
  /// owns and reuses. This is what the relay uses in steady state — the only
  /// work per chunk is the scan and one `memcpy`, with nothing for the
  /// garbage collector to clean up afterwards.
  ///
  /// The caller must consume `out.subarray(0, bytes)` before the next push.
  /// Pass a reusable `lengths` array to get frame boundaries without
  /// allocating anything either.
  #[napi]
  pub fn push_into(
    &mut self,
    chunk: Buffer,
    mut out: Buffer,
    lengths: Option<Uint32Array>,
  ) -> FillResult {
    self.total_bytes += chunk.len() as u64;

    if self.skip > 0 {
      let drop = self.skip.min(chunk.len());
      self.skip -= drop;
      self.total_dropped += drop as u64;
      if drop == chunk.len() {
        return FillResult {
          frames: 0,
          bytes: 0,
          duration_ms: 0.0,
          pending: self.buffer.len() as u32,
          dropped: drop as u32,
          overflow: false,
          format: None,
        };
      }
      self.buffer.extend_from_slice(&chunk[drop..]);
    } else {
      self.buffer.extend_from_slice(&chunk);
    }

    if !self.started {
      let tag = framer::id3v2_size(&self.buffer);
      if tag > 0 {
        let have = tag.min(self.buffer.len());
        self.skip = tag - have;
        self.buffer.drain(..have);
        self.total_dropped += have as u64;
      }
    }

    let (frames, consumed) = framer::scan(&self.buffer, self.skip_vbr_header && !self.started);
    if !frames.is_empty() {
      self.started = true;
    }

    let room = out.len();
    let dest: &mut [u8] = out.as_mut();
    let mut lengths = lengths;
    let slots: &mut [u32] = match lengths.as_mut() {
      Some(array) => array.as_mut(),
      None => &mut [],
    };
    let mut written = 0usize;
    let mut count = 0usize;
    let mut duration_ms = 0.0;
    for frame in &frames {
      if written + frame.length > room {
        break;
      }
      if !slots.is_empty() {
        if count >= slots.len() {
          break; // caller's boundary array is full — hand the rest back next time
        }
        slots[count] = frame.length as u32;
      }
      dest[written..written + frame.length]
        .copy_from_slice(&self.buffer[frame.offset..frame.offset + frame.length]);
      written += frame.length;
      duration_ms += frame.duration_ms;
      count += 1;
    }

    // If `out` filled up, resume at the first frame we could not take.
    let overflow = count < frames.len();
    let consumed = if overflow { frames[count].offset } else { consumed };

    let mut format = None;
    if let Some(head) = frames.first() {
      if self.bitrate != 0 && self.bitrate != head.bitrate {
        self.vbr = true;
      }
      let changed = !self.reported
        || self.bitrate != head.bitrate
        || self.sample_rate != head.sample_rate
        || self.channels != head.channels as u32;
      self.bitrate = head.bitrate;
      self.sample_rate = head.sample_rate;
      self.channels = head.channels as u32;
      if changed && count > 0 {
        self.reported = true;
        format = Some(FrameInfo::from(*head));
      }
    }

    let dropped = consumed.saturating_sub(written);
    self.total_dropped += dropped as u64;
    self.total_frames += count as u64;
    self.total_ms += duration_ms;
    self.buffer.drain(..consumed);

    FillResult {
      frames: count as u32,
      bytes: written as u32,
      duration_ms,
      pending: self.buffer.len() as u32,
      dropped: dropped as u32,
      overflow,
      format,
    }
  }

  fn empty_result(&self, dropped: u32) -> PushResult {
    PushResult {
      data: Buffer::from(Vec::new()),
      lengths: if self.want_lengths {
        Some(Uint32Array::new(Vec::new()))
      } else {
        None
      },
      frames: 0,
      duration_ms: 0.0,
      pending: self.buffer.len() as u32,
      dropped,
      info: None,
    }
  }

  /// Bytes buffered behind an incomplete frame.
  #[napi(getter)]
  pub fn pending(&self) -> u32 {
    self.buffer.len() as u32
  }

  /// Running totals for the relay — what the node reports as relay health.
  #[napi]
  pub fn stats(&self) -> StreamInfo {
    StreamInfo {
      frames: self.total_frames as u32,
      bytes: self.total_bytes as u32,
      duration_ms: self.total_ms,
      bitrate: self.bitrate,
      sample_rate: self.sample_rate,
      channels: self.channels,
      vbr: self.vbr,
    }
  }

  /// Bytes thrown away while resynchronising since the relay started.
  #[napi(getter)]
  pub fn dropped(&self) -> u32 {
    self.total_dropped as u32
  }

  #[napi]
  pub fn reset(&mut self) {
    self.buffer.clear();
    self.skip = 0;
    self.started = false;
    self.reported = false;
  }
}

/// Decode MP3 bytes to f32 channels, on the calling thread.
#[napi]
pub fn decode(data: Buffer) -> Result<DecodedAudio> {
  let pcm = decode::decode(data.to_vec()).map_err(|e| Error::new(Status::GenericFailure, e))?;
  let length = pcm.left.len() as u32;
  Ok(DecodedAudio {
    left: Float32Array::new(pcm.left),
    right: Float32Array::new(pcm.right),
    sample_rate: pcm.sample_rate,
    channels: pcm.channels as u32,
    length,
  })
}

/// The same, on the thread pool: a seam decode never blocks the pacer.
#[napi]
pub fn decode_async(data: Buffer) -> AsyncTask<DecodeTask> {
  AsyncTask::new(DecodeTask {
    data: data.to_vec(),
  })
}

pub struct DecodeTask {
  data: Vec<u8>,
}

impl Task for DecodeTask {
  type Output = decode::Pcm;
  type JsValue = DecodedAudio;

  fn compute(&mut self) -> Result<Self::Output> {
    decode::decode(std::mem::take(&mut self.data)).map_err(|e| Error::new(Status::GenericFailure, e))
  }

  fn resolve(&mut self, _env: Env, pcm: Self::Output) -> Result<Self::JsValue> {
    let length = pcm.left.len() as u32;
    Ok(DecodedAudio {
      left: Float32Array::new(pcm.left),
      right: Float32Array::new(pcm.right),
      sample_rate: pcm.sample_rate,
      channels: pcm.channels as u32,
      length,
    })
  }
}

/* ====================================================================== *
 * Transcoding — anything → MP3
 * ====================================================================== */

/// What the transcoder has done so far.
#[napi(object)]
pub struct TranscodeStats {
  /// Detected input: "mp3", "aac", "mpeg-ts", "ogg", "flac", "wav", "mp4"…
  pub kind: String,
  /// Bytes buffered and not yet turned into MP3.
  pub pending: u32,
  pub bytes_in: u32,
  pub bytes_out: u32,
  pub frames_in: u32,
  pub duration_ms: f64,
  pub sample_rate: u32,
  pub channels: u32,
  /// Output bitrate in kbps, or 0 when the input is forwarded untouched.
  pub bitrate: u32,
  /// True when the input was already MP3 and no re-encoding happened.
  pub passthrough: bool,
}

/// What is this audio? Answers without decoding a single frame.
#[napi]
pub fn sniff(data: Buffer) -> String {
  transcode::detect(&data).name().to_string()
}

/// Decode any supported codec to f32 channels.
#[napi]
pub fn decode_audio(data: Buffer) -> Result<DecodedAudio> {
  let pcm = decode::decode_with_hint(data.to_vec(), None).map_err(to_js)?;
  Ok(pcm_to_js(pcm))
}

/// Encode f32 channels to MP3 — the automix's output path.
///
/// Roughly five times faster than the JavaScript encoder, which matters
/// because every crossfade in the node goes through it.
#[napi]
pub fn encode_mp3(left: Float32Array, right: Float32Array, sample_rate: u32, bitrate: Option<u32>) -> Result<Buffer> {
  let mut encoder = encode::Encoder::new(sample_rate, 2, bitrate.unwrap_or(128)).map_err(to_js)?;
  let mut out = encoder.push(&left, &right).map_err(to_js)?;
  out.extend_from_slice(&encoder.finish().map_err(to_js)?);
  Ok(Buffer::from(out))
}

/// One-shot transcode: a whole file or HLS segment in, MP3 out.
#[napi]
pub fn transcode(data: Buffer, bitrate: Option<u32>) -> Result<Buffer> {
  transcode::transcode(data.to_vec(), bitrate.unwrap_or(128))
    .map(Buffer::from)
    .map_err(to_js)
}

/// The same, on the thread pool.
#[napi]
pub fn transcode_async(data: Buffer, bitrate: Option<u32>) -> AsyncTask<TranscodeTask> {
  AsyncTask::new(TranscodeTask {
    data: data.to_vec(),
    bitrate: bitrate.unwrap_or(128),
  })
}

pub struct TranscodeTask {
  data: Vec<u8>,
  bitrate: u32,
}

impl Task for TranscodeTask {
  type Output = Vec<u8>;
  type JsValue = Buffer;

  fn compute(&mut self) -> Result<Self::Output> {
    transcode::transcode(std::mem::take(&mut self.data), self.bitrate).map_err(to_js)
  }

  fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
    Ok(Buffer::from(out))
  }
}

/// Streaming transcoder for live relays.
///
/// Push whatever arrives; get MP3 back. The format is detected once, the
/// decoder lives for the whole relay (so nothing glitches at a chunk
/// boundary), and MP3 input is passed through without re-encoding.
#[napi]
pub struct Transcoder {
  inner: transcode::Transcoder,
}

#[napi]
impl Transcoder {
  #[napi(constructor)]
  pub fn new(bitrate: Option<u32>) -> Self {
    Transcoder {
      inner: transcode::Transcoder::new(bitrate.unwrap_or(128)),
    }
  }

  /// Compressed bytes in, MP3 bytes out (possibly empty while buffering).
  #[napi]
  pub fn push(&mut self, chunk: Buffer) -> Result<Buffer> {
    self.inner.push(&chunk).map(Buffer::from).map_err(to_js)
  }

  /// End of stream: decode anything held whole and flush the encoder.
  #[napi]
  pub fn flush(&mut self) -> Result<Buffer> {
    self.inner.flush().map(Buffer::from).map_err(to_js)
  }

  /// What the input turned out to be.
  #[napi(getter)]
  pub fn kind(&self) -> String {
    self.inner.kind().name().to_string()
  }

  /// True when the relay is MP3 and is being forwarded untouched.
  #[napi(getter)]
  pub fn passthrough(&self) -> bool {
    self.inner.passthrough()
  }

  #[napi]
  pub fn stats(&self) -> TranscodeStats {
    let stats = self.inner.stats();
    TranscodeStats {
      kind: stats.kind.to_string(),
      pending: stats.pending,
      bytes_in: stats.bytes_in as u32,
      bytes_out: stats.bytes_out as u32,
      frames_in: stats.frames_in as u32,
      duration_ms: stats.duration_ms,
      sample_rate: stats.sample_rate,
      channels: stats.channels,
      bitrate: stats.bitrate,
      passthrough: stats.passthrough,
    }
  }
}

fn to_js(message: String) -> Error {
  Error::new(Status::GenericFailure, message)
}

fn pcm_to_js(pcm: decode::Pcm) -> DecodedAudio {
  let length = pcm.left.len() as u32;
  DecodedAudio {
    left: Float32Array::new(pcm.left),
    right: Float32Array::new(pcm.right),
    sample_rate: pcm.sample_rate,
    channels: pcm.channels as u32,
    length,
  }
}

/* ====================================================================== *
 * Smart Automix — the DSP that used to make long crossfades stutter
 * ====================================================================== */

/// A tempo, a grid and how much to believe them.
#[napi(object)]
pub struct BeatInfo {
  pub bpm: f64,
  pub period_samples: f64,
  pub phase_samples: f64,
  /// 0…1. Below ~0.25 the automix does not act on it.
  pub confidence: f64,
}

/// Stretched audio, ready to be mixed.
#[napi(object)]
pub struct StretchedAudio {
  pub left: Float32Array,
  pub right: Float32Array,
  pub length: u32,
}

/// Tempo and beat grid for a mono buffer.
///
/// The port of `estimateBeat` in `server/src/core/dsp.js`, down to the comb
/// weighting and the 120 BPM prior, so the two agree on real music.
#[napi]
pub fn analyse_beat(mono: Float32Array, sample_rate: u32, frame_size: Option<u32>, hop_size: Option<u32>) -> Option<BeatInfo> {
  dsp::estimate_beat(
    &mono,
    sample_rate,
    frame_size.unwrap_or(1024) as usize,
    hop_size.unwrap_or(256) as usize
  )
  .map(|beat| BeatInfo {
    bpm: beat.bpm,
    period_samples: beat.period_samples,
    phase_samples: beat.phase_samples,
    confidence: beat.confidence
  })
}

/// The same, on the thread pool — this is the one the automix uses, because
/// a 60 second window takes long enough to be heard as a stutter otherwise.
#[napi]
pub fn analyse_beat_async(mono: Float32Array, sample_rate: u32) -> AsyncTask<BeatTask> {
  AsyncTask::new(BeatTask {
    mono: mono.to_vec(),
    sample_rate
  })
}

pub struct BeatTask {
  mono: Vec<f32>,
  sample_rate: u32
}

impl Task for BeatTask {
  type Output = Option<dsp::Beat>;
  type JsValue = Option<BeatInfo>;

  fn compute(&mut self) -> Result<Self::Output> {
    Ok(dsp::estimate_beat(&self.mono, self.sample_rate, 1024, 256))
  }

  fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
    Ok(out.map(|beat| BeatInfo {
      bpm: beat.bpm,
      period_samples: beat.period_samples,
      phase_samples: beat.phase_samples,
      confidence: beat.confidence
    }))
  }
}

/// WSOLA time stretch: change the tempo, leave the pitch alone.
#[napi]
pub fn time_stretch(
  left: Float32Array,
  right: Float32Array,
  sample_rate: u32,
  stretch: f64,
  ramp_samples: Option<f64>,
  length: Option<u32>
) -> StretchedAudio {
  let out = dsp::time_stretch(
    &left,
    &right,
    sample_rate,
    stretch,
    ramp_samples.unwrap_or(0.0),
    length.map(|value| value as usize),
    8.0
  );
  StretchedAudio {
    left: Float32Array::new(out.left),
    right: Float32Array::new(out.right),
    length: out.length as u32
  }
}

/// The same, off the event loop.
#[napi]
pub fn time_stretch_async(
  left: Float32Array,
  right: Float32Array,
  sample_rate: u32,
  stretch: f64,
  ramp_samples: Option<f64>,
  length: Option<u32>
) -> AsyncTask<StretchTask> {
  AsyncTask::new(StretchTask {
    left: left.to_vec(),
    right: right.to_vec(),
    sample_rate,
    stretch,
    ramp_samples: ramp_samples.unwrap_or(0.0),
    length: length.map(|value| value as usize)
  })
}

pub struct StretchTask {
  left: Vec<f32>,
  right: Vec<f32>,
  sample_rate: u32,
  stretch: f64,
  ramp_samples: f64,
  length: Option<usize>
}

impl Task for StretchTask {
  type Output = dsp::Stretched;
  type JsValue = StretchedAudio;

  fn compute(&mut self) -> Result<Self::Output> {
    Ok(dsp::time_stretch(
      &self.left,
      &self.right,
      self.sample_rate,
      self.stretch,
      self.ramp_samples,
      self.length,
      8.0
    ))
  }

  fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
    Ok(StretchedAudio {
      left: Float32Array::new(out.left),
      right: Float32Array::new(out.right),
      length: out.length as u32
    })
  }
}
