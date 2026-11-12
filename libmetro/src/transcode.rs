//! Anything → MP3, in one pass, while it streams.
//!
//! Nodecast broadcasts MP3. A relay that arrives as AAC (Icecast), as an HLS
//! transport stream, as Ogg/Vorbis, FLAC or an MP4 segment therefore has to
//! be decoded and re-encoded — and it has to happen faster than real time on
//! a box that is also running several stations.
//!
//! The rules the transcoder follows:
//!
//!  * **MP3 in, MP3 out, untouched.** Detecting MP3 and passing the original
//!    frames through is the single most important optimisation here: most
//!    relays are already MP3 and must not be re-encoded.
//!  * **Stay streaming.** ADTS AAC and MPEG-TS are self-framing, so they are
//!    decoded frame by frame with one decoder kept alive for the whole relay
//!    — no per-chunk decoder, no glitch at a chunk boundary.
//!  * **Containers that are not streamable** (Ogg, FLAC, WAV, MP4) are held
//!    until `flush()`. HLS hands us whole segments anyway, which is exactly
//!    the shape that suits them.

use symphonia::core::audio::{AudioBufferRef, SampleBuffer, Signal};
use symphonia::core::codecs::{CodecParameters, Decoder, DecoderOptions, CODEC_TYPE_AAC};
use symphonia::core::formats::Packet;

use std::sync::mpsc::{Receiver, TryRecvError};

use crate::adts;
use crate::decode;
use crate::encode::Encoder;
use crate::framer;
use crate::stream_source::Feeder;
use crate::ts::{Elementary, TsDemuxer};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
  Unknown,
  /// Already MP3 — forwarded byte for byte.
  Mp3,
  /// Raw AAC in ADTS frames (Icecast AAC, `.aac` files, TS payloads).
  Adts,
  /// MPEG-TS, as used by HLS segments.
  Ts,
  /// A container we can only decode whole: Ogg, FLAC, WAV, MP4…
  Container(&'static str),
}

impl Kind {
  pub fn name(&self) -> &'static str {
    match self {
      Kind::Unknown => "unknown",
      Kind::Mp3 => "mp3",
      Kind::Adts => "aac",
      Kind::Ts => "mpeg-ts",
      Kind::Container(name) => name,
    }
  }
}

/// What is this? Called once per relay, on the first few kilobytes.
pub fn detect(buf: &[u8]) -> Kind {
  if buf.len() < 4 {
    return Kind::Unknown;
  }

  // An ID3 tag says "MP3" loudly enough, but AAC files carry them too, so
  // skip it and look at what follows.
  let start = framer::id3v2_size(buf);
  let body = if start < buf.len() { &buf[start..] } else { buf };

  if body.len() >= 4 {
    match &body[0..4] {
      b"OggS" => return Kind::Container("ogg"),
      b"fLaC" => return Kind::Container("flac"),
      b"RIFF" => return Kind::Container("wav"),
      _ => {}
    }
  }
  if body.len() >= 12 && &body[4..8] == b"ftyp" {
    return Kind::Container("mp4");
  }
  if body.len() >= 4 && body[0] == 0x1A && body[1] == 0x45 && body[2] == 0xDF && body[3] == 0xA3 {
    return Kind::Container("matroska");
  }
  if TsDemuxer::looks_like_ts(body) {
    return Kind::Ts;
  }

  // Both MP3 and ADTS start 0xFF Fx; the layer bits tell them apart.
  for at in 0..body.len().saturating_sub(4).min(8192) {
    if body[at] != 0xFF {
      continue;
    }
    if adts::parse_header(body, at).is_some() {
      return Kind::Adts;
    }
    if framer::parse_header(body, at).is_some() {
      return Kind::Mp3;
    }
  }

  Kind::Unknown
}

/// A live AAC decoder that survives across chunks.
struct AacState {
  decoder: Box<dyn Decoder>,
  sample_rate: u32,
  channels: u8,
  packets: u64,
}

impl AacState {
  fn new(frame: &adts::AdtsFrame) -> Result<Self, String> {
    let mut params = CodecParameters::new();
    params
      .for_codec(CODEC_TYPE_AAC)
      .with_sample_rate(frame.sample_rate)
      .with_extra_data(Box::new(frame.asc()));

    let decoder = symphonia::default::get_codecs()
      .make(&params, &DecoderOptions::default())
      .map_err(|e| format!("aac decoder: {e}"))?;

    Ok(AacState {
      decoder,
      sample_rate: frame.sample_rate,
      channels: frame.channels,
      packets: 0,
    })
  }
}

pub struct Stats {
  pub kind: &'static str,
  /// Bytes buffered and not yet turned into MP3.
  pub pending: u32,
  pub bytes_in: u64,
  pub bytes_out: u64,
  pub frames_in: u64,
  pub duration_ms: f64,
  pub sample_rate: u32,
  pub channels: u32,
  pub bitrate: u32,
  pub passthrough: bool,
}

/// A container being decoded on a worker thread.
struct Streaming {
  feeder: Feeder,
  pcm: Receiver<decode::Pcm>,
  worker: Option<std::thread::JoinHandle<()>>,
  failed: Option<String>,
}

pub struct Transcoder {
  kind: Kind,
  streaming: Option<Streaming>,
  bitrate: u32,
  buffer: Vec<u8>,
  elementary: Vec<u8>,
  ts: TsDemuxer,
  aac: Option<AacState>,
  encoder: Option<Encoder>,
  left: Vec<f32>,
  right: Vec<f32>,
  bytes_in: u64,
  bytes_out: u64,
  frames_in: u64,
  duration_ms: f64,
  mp3_started: bool,
}

const MAX_HELD: usize = 64 << 20; // a container we have to buffer whole

impl Transcoder {
  pub fn new(bitrate: u32) -> Self {
    Transcoder {
      kind: Kind::Unknown,
      streaming: None,
      bitrate: bitrate.clamp(32, 320),
      buffer: Vec::with_capacity(64 * 1024),
      elementary: Vec::new(),
      ts: TsDemuxer::new(),
      aac: None,
      encoder: None,
      left: Vec::new(),
      right: Vec::new(),
      bytes_in: 0,
      bytes_out: 0,
      frames_in: 0,
      duration_ms: 0.0,
      mp3_started: false,
    }
  }

  pub fn kind(&self) -> Kind {
    self.kind
  }

  /// True when the input is already MP3 and is being forwarded untouched.
  pub fn passthrough(&self) -> bool {
    self.kind == Kind::Mp3
  }

  pub fn stats(&self) -> Stats {
    Stats {
      kind: self.kind.name(),
      pending: (self.buffer.len()
        + self.elementary.len()
        + self.streaming.as_ref().map(|s| s.feeder.pending()).unwrap_or(0)) as u32,
      bytes_in: self.bytes_in,
      bytes_out: self.bytes_out,
      frames_in: self.frames_in,
      duration_ms: self.duration_ms,
      sample_rate: self
        .encoder
        .as_ref()
        .map(|e| e.sample_rate)
        .or_else(|| self.aac.as_ref().map(|a| a.sample_rate))
        .unwrap_or(0),
      channels: self.aac.as_ref().map(|a| a.channels as u32).unwrap_or(0),
      bitrate: if self.passthrough() { 0 } else { self.bitrate },
      passthrough: self.passthrough(),
    }
  }

  /// Push compressed bytes; get MP3 bytes back.
  pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<u8>, String> {
    self.bytes_in += chunk.len() as u64;
    self.buffer.extend_from_slice(chunk);

    if self.kind == Kind::Unknown {
      // Wait for enough bytes to be sure, but never stall a small file.
      if self.buffer.len() < 1024 {
        return Ok(Vec::new());
      }
      self.kind = detect(&self.buffer);
      if self.kind == Kind::Unknown {
        return Err("unrecognised audio: not mp3, aac, mpeg-ts, ogg, flac, wav or mp4".into());
      }
    }

    let out = match self.kind {
      Kind::Mp3 => self.pass_mp3(),
      Kind::Adts => self.run_adts(),
      Kind::Ts => self.run_ts(),
      // MP4 has to be seekable, so it waits for flush(); everything else
      // streams through the worker thread.
      Kind::Container("mp4") => {
        if self.buffer.len() > MAX_HELD {
          return Err("mp4 too large to buffer".into());
        }
        Ok(Vec::new())
      }
      Kind::Container(name) => self.run_container(name),
      Kind::Unknown => Ok(Vec::new()),
    }?;

    self.bytes_out += out.len() as u64;
    Ok(out)
  }

  /// Finish: drain the worker, decode anything held whole, flush the encoder.
  pub fn flush(&mut self) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();

    if self.streaming.is_some() {
      out.extend_from_slice(&self.drain_streaming(true)?);
    } else if let Kind::Container(name) = self.kind {
      let held = std::mem::take(&mut self.buffer);
      if !held.is_empty() {
        let pcm = decode::decode_with_hint(held, Some(name))?;
        self.duration_ms += pcm.left.len() as f64 / pcm.sample_rate as f64 * 1000.0;
        let encoder = self.encoder_for(pcm.sample_rate, pcm.channels)?;
        out.extend_from_slice(&encoder.push(&pcm.left, &pcm.right)?);
      }
    } else if self.kind == Kind::Ts {
      let tail = self.ts.flush();
      if !tail.is_empty() {
        self.elementary.extend_from_slice(&tail);
        out.extend_from_slice(&self.run_elementary()?);
      }
    }

    if let Some(encoder) = self.encoder.as_mut() {
      out.extend_from_slice(&encoder.finish()?);
    }
    self.bytes_out += out.len() as u64;
    Ok(out)
  }

  /* ------------------------------ mp3 ------------------------------- */

  /// Already MP3: emit whole frames and forward them byte for byte.
  fn pass_mp3(&mut self) -> Result<Vec<u8>, String> {
    let (frames, consumed) = framer::scan(&self.buffer, !self.mp3_started);
    if frames.is_empty() {
      self.buffer.drain(..consumed);
      return Ok(Vec::new());
    }
    self.mp3_started = true;

    let start = frames[0].offset;
    let last = frames[frames.len() - 1];
    let end = last.offset + last.length;
    let audio: Vec<u8> = self.buffer[start..end].to_vec();

    self.frames_in += frames.len() as u64;
    self.duration_ms += frames.iter().map(|f| f.duration_ms).sum::<f64>();
    self.buffer.drain(..consumed);
    Ok(audio)
  }

  /* --------------------------- containers --------------------------- */

  /// Feed the worker and collect whatever it has decoded so far.
  fn run_container(&mut self, name: &'static str) -> Result<Vec<u8>, String> {
    if self.streaming.is_none() {
      self.start_worker(name);
    }

    let chunk = std::mem::take(&mut self.buffer);
    if let Some(streaming) = self.streaming.as_ref() {
      if !chunk.is_empty() {
        streaming.feeder.push(&chunk);
      }
    }

    self.drain_streaming(false)
  }

  /// Decode on a worker thread: it blocks in `read()` while we push bytes.
  fn start_worker(&mut self, name: &'static str) {
    let (feeder, source) = Feeder::new();
    let (sender, receiver) = std::sync::mpsc::channel();

    let worker = std::thread::Builder::new()
      .name(format!("metros-{name}"))
      .spawn(move || {
        // Emit PCM in ~0.5 s pieces so audio reaches the pacer promptly.
        let _ = decode::decode_stream(source, Some(name), |pcm| sender.send(pcm).is_ok());
      })
      .ok();

    self.streaming = Some(Streaming {
      feeder,
      pcm: receiver,
      worker,
      failed: None,
    });
  }

  /// Pull decoded audio out of the worker and encode it.
  fn drain_streaming(&mut self, finish: bool) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut blocks: Vec<decode::Pcm> = Vec::new();

    {
      let streaming = match self.streaming.as_mut() {
        Some(streaming) => streaming,
        None => return Ok(out),
      };

      if finish {
        streaming.feeder.end();
        // The worker finishes what it has; the channel closes when it exits.
        while let Ok(pcm) = streaming.pcm.recv() {
          blocks.push(pcm);
        }
        if let Some(worker) = streaming.worker.take() {
          let _ = worker.join();
        }
      } else {
        loop {
          match streaming.pcm.try_recv() {
            Ok(pcm) => blocks.push(pcm),
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => {
              streaming.failed = Some("decoder stopped".into());
              break;
            }
          }
        }
      }
    }

    for pcm in blocks {
      if pcm.left.is_empty() {
        continue;
      }
      self.duration_ms += pcm.left.len() as f64 / pcm.sample_rate.max(1) as f64 * 1000.0;
      self.frames_in += 1;
      let (rate, channels) = (pcm.sample_rate, pcm.channels);
      let encoder = self.encoder_for(rate, channels)?;
      out.extend_from_slice(&encoder.push(&pcm.left, &pcm.right)?);
    }

    Ok(out)
  }

  /* ------------------------------ aac ------------------------------- */

  fn run_adts(&mut self) -> Result<Vec<u8>, String> {
    let buffer = std::mem::take(&mut self.buffer);
    let (frames, consumed) = adts::scan(&buffer);
    let result = self.decode_adts(&buffer, &frames);
    self.buffer = buffer;
    self.buffer.drain(..consumed);
    result
  }

  fn decode_adts(&mut self, buf: &[u8], frames: &[adts::AdtsFrame]) -> Result<Vec<u8>, String> {
    if frames.is_empty() {
      return Ok(Vec::new());
    }
    if self.aac.is_none() {
      self.aac = Some(AacState::new(&frames[0])?);
    }

    self.left.clear();
    self.right.clear();
    let mut sample_rate = 0;
    let mut channels = 0u8;

    for frame in frames {
      let payload = &buf[frame.offset + frame.header_len..frame.offset + frame.length];
      let state = self.aac.as_mut().unwrap();
      let packet = Packet::new_from_slice(0, state.packets * 1024, 1024, payload);
      state.packets += 1;

      match state.decoder.decode(&packet) {
        Ok(decoded) => {
          let spec = *decoded.spec();
          sample_rate = spec.rate;
          channels = spec.channels.count().min(2) as u8;
          append(&mut self.left, &mut self.right, decoded);
          self.frames_in += 1;
        }
        // One bad frame in a live stream is not worth dropping the relay for.
        Err(_) => continue,
      }
    }

    if self.left.is_empty() {
      return Ok(Vec::new());
    }

    if let Some(state) = self.aac.as_mut() {
      state.sample_rate = sample_rate;
      state.channels = channels;
    }
    self.duration_ms += self.left.len() as f64 / sample_rate as f64 * 1000.0;

    let bitrate = self.bitrate;
    if self.encoder.is_none() {
      self.encoder = Some(Encoder::new(sample_rate, channels, bitrate)?);
    }
    let left = std::mem::take(&mut self.left);
    let right = std::mem::take(&mut self.right);
    let out = self.encoder.as_mut().unwrap().push(&left, &right)?;
    self.left = left;
    self.right = right;
    Ok(out)
  }

  /* ---------------------------- mpeg-ts ----------------------------- */

  fn run_ts(&mut self) -> Result<Vec<u8>, String> {
    let buffer = std::mem::take(&mut self.buffer);
    let (es, consumed) = self.ts.push(&buffer);
    self.buffer = buffer;
    self.buffer.drain(..consumed);
    self.elementary.extend_from_slice(&es);
    self.run_elementary()
  }

  /// The audio inside a transport stream is either ADTS AAC or MP3.
  fn run_elementary(&mut self) -> Result<Vec<u8>, String> {
    if self.elementary.is_empty() {
      return Ok(Vec::new());
    }

    match self.ts.kind {
      Elementary::Mp3 => {
        let (frames, consumed) = framer::scan(&self.elementary, !self.mp3_started);
        if frames.is_empty() {
          self.elementary.drain(..consumed);
          return Ok(Vec::new());
        }
        self.mp3_started = true;
        let start = frames[0].offset;
        let last = frames[frames.len() - 1];
        let audio = self.elementary[start..last.offset + last.length].to_vec();
        self.frames_in += frames.len() as u64;
        self.duration_ms += frames.iter().map(|f| f.duration_ms).sum::<f64>();
        self.elementary.drain(..consumed);
        Ok(audio)
      }
      _ => {
        let buffer = std::mem::take(&mut self.elementary);
        let (frames, consumed) = adts::scan(&buffer);
        let out = self.decode_adts(&buffer, &frames);
        self.elementary = buffer;
        self.elementary.drain(..consumed);
        out
      }
    }
  }

  fn encoder_for(&mut self, sample_rate: u32, channels: u8) -> Result<&mut Encoder, String> {
    if self.encoder.is_none() {
      self.encoder = Some(Encoder::new(sample_rate, channels, self.bitrate)?);
    }
    Ok(self.encoder.as_mut().unwrap())
  }
}

/// Planar or interleaved, any sample format → two float channels.
fn append(left: &mut Vec<f32>, right: &mut Vec<f32>, decoded: AudioBufferRef<'_>) {
  let channels = decoded.spec().channels.count();
  match decoded {
    AudioBufferRef::F32(buf) => {
      left.extend_from_slice(buf.chan(0));
      right.extend_from_slice(buf.chan(if channels > 1 { 1 } else { 0 }));
    }
    other => {
      let mut samples = SampleBuffer::<f32>::new(other.capacity() as u64, *other.spec());
      samples.copy_interleaved_ref(other);
      for frame in samples.samples().chunks(channels) {
        left.push(frame[0]);
        right.push(if channels > 1 { frame[1] } else { frame[0] });
      }
    }
  }
}

/// One-shot: a complete file or segment in, MP3 out.
pub fn transcode(bytes: Vec<u8>, bitrate: u32) -> Result<Vec<u8>, String> {
  let mut transcoder = Transcoder::new(bitrate);
  let mut out = transcoder.push(&bytes)?;
  out.extend_from_slice(&transcoder.flush()?);
  Ok(out)
}

impl Drop for Transcoder {
  /// A relay that is torn down mid-stream must not leave its decode thread
  /// blocked in `read()` forever.
  fn drop(&mut self) {
    if let Some(streaming) = self.streaming.take() {
      streaming.feeder.cancel();
      if let Some(worker) = streaming.worker {
        let _ = worker.join();
      }
    }
  }
}
