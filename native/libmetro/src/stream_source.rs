//! A `MediaSource` that is fed from outside, so symphonia can pull from a
//! stream that has not finished arriving.
//!
//! Symphonia's readers are pull-based: they call `read()` and expect bytes.
//! A relay is push-based: bytes turn up when the network feels like it. The
//! join between the two is this — a shared buffer with a condition variable.
//! The decode loop runs on its own thread and blocks in `read()`; `push()`
//! wakes it. That is what lets a ten-minute FLAC block start playing after
//! the first few kilobytes instead of being held in memory whole.

use std::io::{Read, Result as IoResult, Seek, SeekFrom};
use std::sync::{Arc, Condvar, Mutex};

use symphonia::core::io::MediaSource;

#[derive(Default)]
struct Shared {
  /// Bytes that have arrived and not yet been read.
  data: Vec<u8>,
  /// Read cursor inside `data`.
  at: usize,
  /// No more bytes are coming.
  ended: bool,
  /// The reader gave up (the transcoder was dropped).
  cancelled: bool,
}

#[derive(Clone)]
pub struct Feeder {
  shared: Arc<(Mutex<Shared>, Condvar)>,
}

impl Feeder {
  pub fn new() -> (Feeder, StreamSource) {
    let shared = Arc::new((Mutex::new(Shared::default()), Condvar::new()));
    (
      Feeder {
        shared: Arc::clone(&shared),
      },
      StreamSource { shared },
    )
  }

  /// Hand more bytes to the decode thread.
  pub fn push(&self, bytes: &[u8]) {
    let (lock, signal) = &*self.shared;
    let mut shared = lock.lock().unwrap();
    shared.data.extend_from_slice(bytes);
    signal.notify_all();
  }

  /// No more bytes: the decoder should finish and stop.
  pub fn end(&self) {
    let (lock, signal) = &*self.shared;
    let mut shared = lock.lock().unwrap();
    shared.ended = true;
    signal.notify_all();
  }

  /// Stop now — used when a relay is torn down mid-stream.
  pub fn cancel(&self) {
    let (lock, signal) = &*self.shared;
    let mut shared = lock.lock().unwrap();
    shared.cancelled = true;
    shared.ended = true;
    signal.notify_all();
  }

  /// Bytes buffered ahead of the decoder.
  pub fn pending(&self) -> usize {
    let (lock, _) = &*self.shared;
    let shared = lock.lock().unwrap();
    shared.data.len().saturating_sub(shared.at)
  }
}

/// The read side, handed to symphonia.
pub struct StreamSource {
  shared: Arc<(Mutex<Shared>, Condvar)>,
}

impl Read for StreamSource {
  fn read(&mut self, out: &mut [u8]) -> IoResult<usize> {
    if out.is_empty() {
      return Ok(0);
    }
    let (lock, signal) = &*self.shared;
    let mut shared = lock.lock().unwrap();

    loop {
      if shared.cancelled {
        return Ok(0);
      }
      let available = shared.data.len() - shared.at;
      if available > 0 {
        let take = available.min(out.len());
        out[..take].copy_from_slice(&shared.data[shared.at..shared.at + take]);
        shared.at += take;

        // Keep the buffer from growing forever, but leave enough history
        // behind the cursor for the small backwards seeks a probe does.
        const HISTORY: usize = 1 << 20;
        if shared.at > HISTORY * 2 {
          let drop = shared.at - HISTORY;
          shared.data.drain(..drop);
          shared.at = HISTORY;
        }
        return Ok(take);
      }
      if shared.ended {
        return Ok(0); // clean EOF
      }
      shared = signal.wait(shared).unwrap();
    }
  }
}

impl Seek for StreamSource {
  fn seek(&mut self, to: SeekFrom) -> IoResult<u64> {
    // Only the small rewinds a format probe performs are supported; a live
    // stream has no end to seek relative to.
    let (lock, _) = &*self.shared;
    let mut shared = lock.lock().unwrap();
    let target = match to {
      SeekFrom::Start(position) => position as i64,
      SeekFrom::Current(delta) => shared.at as i64 + delta,
      SeekFrom::End(_) => {
        return Err(std::io::Error::new(
          std::io::ErrorKind::Unsupported,
          "cannot seek from the end of a live stream",
        ))
      }
    };
    if target < 0 || target as usize > shared.data.len() {
      return Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "seek outside the buffered window",
      ));
    }
    shared.at = target as usize;
    Ok(target as u64)
  }
}

impl MediaSource for StreamSource {
  fn is_seekable(&self) -> bool {
    false
  }

  fn byte_len(&self) -> Option<u64> {
    None
  }
}
