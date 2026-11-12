//! MPEG-TS — the container HLS segments arrive in.
//!
//! An HLS `.ts` segment is a run of 188-byte packets carrying (for radio) one
//! audio elementary stream, usually ADTS AAC and occasionally MP3. Nothing
//! here tries to be a general transport-stream demuxer: it finds the audio
//! PID through the PAT and PMT, unwraps the PES payloads and hands back the
//! elementary stream. That is all a relay needs, and it is a few hundred
//! bytes of state.

pub const PACKET: usize = 188;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Elementary {
  Unknown,
  Aac,
  Mp3,
}

pub struct TsDemuxer {
  pmt_pid: Option<u16>,
  audio_pid: Option<u16>,
  pub kind: Elementary,
  /// PES payload being assembled for the audio PID.
  pending: Vec<u8>,
}

impl Default for TsDemuxer {
  fn default() -> Self {
    Self::new()
  }
}

impl TsDemuxer {
  pub fn new() -> Self {
    TsDemuxer {
      pmt_pid: None,
      audio_pid: None,
      kind: Elementary::Unknown,
      pending: Vec::with_capacity(8192),
    }
  }

  /// Does this look like a transport stream? (`0x47` every 188 bytes.)
  pub fn looks_like_ts(buf: &[u8]) -> bool {
    if buf.len() < PACKET * 2 {
      return buf.first() == Some(&0x47);
    }
    buf[0] == 0x47 && buf[PACKET] == 0x47 && (buf.len() < PACKET * 3 || buf[PACKET * 2] == 0x47)
  }

  /// Feed whole packets; get elementary-stream bytes back. Returns the bytes
  /// and how much of `buf` was consumed (always a multiple of 188).
  pub fn push(&mut self, buf: &[u8]) -> (Vec<u8>, usize) {
    let mut out = Vec::with_capacity(buf.len());
    let mut at = 0usize;

    while at + PACKET <= buf.len() {
      let packet = &buf[at..at + PACKET];
      at += PACKET;
      if packet[0] != 0x47 {
        continue; // lost alignment; the next 188 boundary usually recovers
      }

      let pid = (((packet[1] & 0x1F) as u16) << 8) | packet[2] as u16;
      let start = (packet[1] & 0x40) != 0; // payload_unit_start_indicator
      let adaptation = (packet[3] >> 4) & 0x03;
      if adaptation == 0 || adaptation == 2 {
        continue; // no payload
      }

      let mut payload = 4;
      if adaptation == 3 {
        payload += 1 + packet[4] as usize;
        if payload >= PACKET {
          continue;
        }
      }
      let data = &packet[payload..];

      if pid == 0 {
        self.read_pat(data, start);
      } else if Some(pid) == self.pmt_pid {
        self.read_pmt(data, start);
      } else if Some(pid) == self.audio_pid {
        self.read_pes(data, start, &mut out);
      }
    }

    (out, at)
  }

  /// Anything still held in a half-finished PES packet.
  pub fn flush(&mut self) -> Vec<u8> {
    std::mem::take(&mut self.pending)
  }

  fn read_pat(&mut self, data: &[u8], start: bool) {
    let section = if start {
      let pointer = *data.first().unwrap_or(&0) as usize;
      if 1 + pointer >= data.len() {
        return;
      }
      &data[1 + pointer..]
    } else {
      data
    };
    // table_id 0x00, then 8 bytes of header before the program entries.
    if section.first() != Some(&0x00) || section.len() < 13 {
      return;
    }
    let entries = &section[8..];
    for entry in entries.chunks(4) {
      if entry.len() < 4 {
        break;
      }
      let program = ((entry[0] as u16) << 8) | entry[1] as u16;
      let pid = (((entry[2] & 0x1F) as u16) << 8) | entry[3] as u16;
      if program != 0 {
        self.pmt_pid = Some(pid);
        return;
      }
    }
  }

  fn read_pmt(&mut self, data: &[u8], start: bool) {
    let section = if start {
      let pointer = *data.first().unwrap_or(&0) as usize;
      if 1 + pointer >= data.len() {
        return;
      }
      &data[1 + pointer..]
    } else {
      data
    };
    if section.first() != Some(&0x02) || section.len() < 13 {
      return;
    }
    let program_info_len = (((section[10] & 0x0F) as usize) << 8) | section[11] as usize;
    let mut at = 12 + program_info_len;

    while at + 5 <= section.len() {
      let stream_type = section[at];
      let pid = (((section[at + 1] & 0x1F) as u16) << 8) | section[at + 2] as u16;
      let es_info_len = (((section[at + 3] & 0x0F) as usize) << 8) | section[at + 4] as usize;
      at += 5 + es_info_len;

      match stream_type {
        0x0F | 0x11 => {
          // 0x0F = ADTS AAC, 0x11 = LATM (decoded as AAC too, best effort)
          self.audio_pid = Some(pid);
          self.kind = Elementary::Aac;
          return;
        }
        0x03 | 0x04 => {
          self.audio_pid = Some(pid);
          self.kind = Elementary::Mp3;
          return;
        }
        _ => {}
      }
    }
  }

  fn read_pes(&mut self, data: &[u8], start: bool, out: &mut Vec<u8>) {
    if start {
      // Emit whatever the previous PES packet left behind, then skip the
      // 6-byte PES header plus its variable extension.
      out.append(&mut self.pending);
      if data.len() < 9 || data[0] != 0x00 || data[1] != 0x00 || data[2] != 0x01 {
        return;
      }
      let header_len = data[8] as usize;
      let body = 9 + header_len;
      if body < data.len() {
        self.pending.extend_from_slice(&data[body..]);
      }
    } else {
      self.pending.extend_from_slice(data);
    }

    // Don't let a malformed stream grow the buffer without bound.
    if self.pending.len() > 1 << 20 {
      out.append(&mut self.pending);
    }
  }
}
