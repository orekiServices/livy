//! The frame scanner.
//!
//! An MP3 stream is a run of self-describing frames, and a relay does not need
//! to understand the audio inside them — it needs to find their edges, quickly
//! and without ever mistaking noise for a header. That is all this file does,
//! and it is the hot loop of the whole node: every byte of every live relay
//! passes through it.
//!
//! The scanner is deliberately strict. A single 0xFF 0xEx pair is *not* a
//! frame: we only accept a candidate when the header parses and the frame that
//! would follow it is itself followed by another valid header (or the end of
//! the buffer). That one extra check is what keeps ID3 art, shoutcast metadata
//! and plain garbage from being decoded as audio.

/// Bitrates per (version, layer) index, in kbps (the unit the rest of
/// Livy uses). 0 = free/invalid.
const BITRATES_V1_L3: [u32; 16] = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V1_L2: [u32; 16] = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0];
const BITRATES_V1_L1: [u32; 16] = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0];
const BITRATES_V2_L1: [u32; 16] = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0];
const BITRATES_V2_L23: [u32; 16] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];

const RATES_V1: [u32; 4] = [44100, 48000, 32000, 0];
const RATES_V2: [u32; 4] = [22050, 24000, 16000, 0];
const RATES_V25: [u32; 4] = [11025, 12000, 8000, 0];

/// Everything a relay needs to know about one frame.
#[derive(Clone, Copy, Debug)]
pub struct Frame {
  pub offset: usize,
  pub length: usize,
  /// kbps, to match `src/util/mp3.js` exactly.
  pub bitrate: u32,
  pub sample_rate: u32,
  pub channels: u8,
  pub samples: u32,
  pub version: u8, // 10 = MPEG-1, 20 = MPEG-2, 25 = MPEG-2.5
  pub layer: u8,
  pub duration_ms: f64,
}

/// Parse a frame header at `at`. Returns `None` for anything that is not one.
pub fn parse_header(buf: &[u8], at: usize) -> Option<Frame> {
  if at + 4 > buf.len() {
    return None;
  }
  let (b0, b1, b2, b3) = (buf[at], buf[at + 1], buf[at + 2], buf[at + 3]);
  if b0 != 0xff || (b1 & 0xe0) != 0xe0 {
    return None;
  }

  let version_bits = (b1 >> 3) & 0b11;
  let layer_bits = (b1 >> 1) & 0b11;
  if version_bits == 1 || layer_bits == 0 {
    return None; // reserved
  }

  let bitrate_index = (b2 >> 4) as usize;
  let rate_index = ((b2 >> 2) & 0b11) as usize;
  if bitrate_index == 0 || bitrate_index == 15 || rate_index == 3 {
    return None; // free-format and reserved rates are not relayable
  }

  let layer = match layer_bits {
    3 => 1u8,
    2 => 2u8,
    _ => 3u8,
  };
  let version = match version_bits {
    3 => 10u8,
    2 => 20u8,
    _ => 25u8,
  };

  let bitrate_table = match (version, layer) {
    (10, 1) => &BITRATES_V1_L1,
    (10, 2) => &BITRATES_V1_L2,
    (10, 3) => &BITRATES_V1_L3,
    (_, 1) => &BITRATES_V2_L1,
    _ => &BITRATES_V2_L23,
  };
  let bitrate = bitrate_table[bitrate_index];
  if bitrate == 0 {
    return None;
  }
  let bitrate_bps = bitrate * 1000;

  let sample_rate = match version {
    10 => RATES_V1[rate_index],
    20 => RATES_V2[rate_index],
    _ => RATES_V25[rate_index],
  };
  if sample_rate == 0 {
    return None;
  }

  let padding = ((b2 >> 1) & 1) as u32;
  let channels: u8 = if (b3 >> 6) & 0b11 == 3 { 1 } else { 2 };

  // Samples per frame, then bytes per frame from the bitrate.
  let samples: u32 = match (version, layer) {
    (_, 1) => 384,
    (10, 3) => 1152,
    (_, 3) => 576,
    _ => 1152,
  };
  let length = if layer == 1 {
    ((12 * bitrate_bps / sample_rate + padding) * 4) as usize
  } else {
    (samples / 8 * bitrate_bps / sample_rate + padding) as usize
  };
  if length < 8 {
    return None;
  }

  Some(Frame {
    offset: at,
    length,
    bitrate,
    sample_rate,
    channels,
    samples,
    version,
    layer,
    duration_ms: (samples as f64 / sample_rate as f64) * 1000.0,
  })
}

/// Length of an ID3v2 tag at the head of `buf`, or 0.
pub fn id3v2_size(buf: &[u8]) -> usize {
  if buf.len() < 10 || &buf[0..3] != b"ID3" {
    return 0;
  }
  let size = ((buf[6] as usize & 0x7f) << 21)
    | ((buf[7] as usize & 0x7f) << 14)
    | ((buf[8] as usize & 0x7f) << 7)
    | (buf[9] as usize & 0x7f);
  size + 10
}

/// Is this frame a Xing/Info/VBRI header rather than audio?
pub fn is_vbr_header(frame: &[u8]) -> bool {
  let window = &frame[..frame.len().min(200)];
  window
    .windows(4)
    .any(|w| w == b"Xing" || w == b"Info" || w == b"VBRI")
}

/// A candidate is trusted when the next header lands exactly where this frame
/// says it should — the cheap check that makes resynchronisation reliable.
fn confirms(buf: &[u8], frame: &Frame) -> bool {
  let next = frame.offset + frame.length;
  if next + 4 > buf.len() {
    return true; // nothing left to disagree with
  }
  parse_header(buf, next).is_some()
}

/// Scan `buf` for whole frames. Returns the frames and the offset where the
/// next scan should resume (i.e. the start of the incomplete tail).
pub fn scan(buf: &[u8], skip_vbr_header: bool) -> (Vec<Frame>, usize) {
  let mut frames = Vec::with_capacity(buf.len() / 418 + 1);
  let mut offset = id3v2_size(buf);
  let mut first = true;

  while offset + 4 <= buf.len() {
    match parse_header(buf, offset) {
      Some(frame) if confirms(buf, &frame) => {
        if offset + frame.length > buf.len() {
          break; // frame is not all here yet
        }
        if first && skip_vbr_header && is_vbr_header(&buf[offset..offset + frame.length]) {
          offset += frame.length;
          first = false;
          continue;
        }
        first = false;
        offset += frame.length;
        frames.push(frame);
      }
      _ => {
        // Resynchronise on the next possible sync word rather than byte by byte.
        match buf[offset + 1..].iter().position(|&b| b == 0xff) {
          Some(delta) => offset += delta + 1,
          None => {
            offset = buf.len();
            break;
          }
        }
      }
    }
  }

  (frames, offset.min(buf.len()))
}
