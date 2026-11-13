//! ADTS — how AAC arrives when it is not in a container.
//!
//! An Icecast AAC stream, the audio inside an HLS transport-stream segment and
//! most `.aac` files are all the same thing: a run of self-describing frames,
//! exactly like MP3. So the relay treats them the same way — find the frame
//! edges, hand whole frames to the decoder — and the decoder stays alive
//! across chunks, which is what keeps a transcode gapless.

/// Sample rates, indexed by the 4-bit field in the header.
pub const RATES: [u32; 16] = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350, 0, 0, 0,
];

#[derive(Clone, Copy, Debug)]
pub struct AdtsFrame {
  pub offset: usize,
  /// Whole frame, header included.
  pub length: usize,
  /// Where the raw AAC payload starts inside the frame (7 or 9).
  pub header_len: usize,
  pub sample_rate: u32,
  pub channels: u8,
  /// MPEG-4 audio object type (2 = AAC-LC).
  pub object_type: u8,
  pub freq_index: u8,
  pub channel_config: u8,
}

impl AdtsFrame {
  /// The AudioSpecificConfig the decoder wants, built from the header.
  ///
  /// Two bytes: 5 bits object type, 4 bits sample-rate index, 4 bits channel
  /// configuration, 3 bits of zero. That is all symphonia needs to start
  /// decoding raw AAC frames — no container, no init segment.
  pub fn asc(&self) -> [u8; 2] {
    [
      (self.object_type << 3) | (self.freq_index >> 1),
      ((self.freq_index & 1) << 7) | (self.channel_config << 3),
    ]
  }
}

/// Is there an ADTS header at `at`? (`0xFFF` sync, layer 00 — which is what
/// tells ADTS apart from an MP3 frame, where the layer bits are never 00.)
pub fn parse_header(buf: &[u8], at: usize) -> Option<AdtsFrame> {
  if at + 7 > buf.len() {
    return None;
  }
  if buf[at] != 0xFF || (buf[at + 1] & 0xF0) != 0xF0 || (buf[at + 1] & 0x06) != 0 {
    return None;
  }

  let freq_index = (buf[at + 2] >> 2) & 0x0F;
  let sample_rate = RATES[freq_index as usize];
  if sample_rate == 0 {
    return None;
  }

  let channel_config = ((buf[at + 2] & 0x01) << 2) | (buf[at + 3] >> 6);
  let length =
    (((buf[at + 3] as usize & 0x03) << 11) | ((buf[at + 4] as usize) << 3) | (buf[at + 5] as usize >> 5)) as usize;
  if length < 7 {
    return None;
  }

  // The CRC-protection bit is inverted: 0 means "CRC present", 9-byte header.
  let header_len = if (buf[at + 1] & 0x01) == 0 { 9 } else { 7 };
  if length < header_len {
    return None;
  }

  Some(AdtsFrame {
    offset: at,
    length,
    header_len,
    sample_rate,
    channels: if channel_config == 0 { 2 } else { channel_config.min(2) },
    object_type: ((buf[at + 2] >> 6) & 0x03) + 1,
    freq_index,
    channel_config: if channel_config == 0 { 2 } else { channel_config },
  })
}

/// Scan for whole ADTS frames, the same contract as the MP3 scanner:
/// `(frames, resume offset)`. A candidate is confirmed by the next header,
/// so noise between frames costs nothing but the bytes.
pub fn scan(buf: &[u8]) -> (Vec<AdtsFrame>, usize) {
  let mut frames = Vec::new();
  let mut at = 0usize;

  while at + 7 <= buf.len() {
    match parse_header(buf, at) {
      Some(frame) => {
        let end = at + frame.length;
        if end > buf.len() {
          break; // not all here yet
        }
        // Confirm with the next header where one should be.
        if end + 2 <= buf.len() && !(buf[end] == 0xFF && (buf[end + 1] & 0xF6) == 0xF0) {
          at += 1;
          continue;
        }
        frames.push(frame);
        at = end;
      }
      None => match buf[at + 1..].iter().position(|&b| b == 0xFF) {
        Some(delta) => at += delta + 1,
        None => {
          at = buf.len();
          break;
        }
      },
    }
  }

  (frames, at.min(buf.len()))
}
