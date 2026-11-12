//! Shoutcast/Icecast ICY metadata parsing.
//!
//! Stream layout: `metaint` audio bytes, then a 1-byte length (×16) followed
//! by that many metadata bytes, repeating. Metadata looks like
//! `StreamTitle='Artist - Title';`.

use crate::IcyResult;
use napi::bindgen_prelude::Uint8Array;

/// Parse one chunk, returning clean audio bytes and an optional title.
pub fn parse_chunk(chunk: &[u8], metaint: usize) -> IcyResult {
    if metaint == 0 {
        return IcyResult {
            audio: Uint8Array::from(chunk.to_vec()),
            metadata: None,
        };
    }

    let mut audio = Vec::with_capacity(chunk.len());
    let mut metadata: Option<String> = None;
    let mut offset = 0usize;
    let mut bytes_until_metadata = metaint;

    while offset < chunk.len() {
        if bytes_until_metadata > 0 {
            let take = bytes_until_metadata.min(chunk.len() - offset);
            audio.extend_from_slice(&chunk[offset..offset + take]);
            offset += take;
            bytes_until_metadata -= take;
        } else {
            let len_byte = chunk[offset];
            offset += 1;
            let meta_len = (len_byte as usize) * 16;
            if meta_len > 0 {
                let end = (offset + meta_len).min(chunk.len());
                let block = &chunk[offset..end];
                if let Some(title) = parse_metadata_block(block) {
                    metadata = Some(title);
                }
                offset = end;
            }
            bytes_until_metadata = metaint;
        }
    }

    IcyResult {
        audio: Uint8Array::from(audio.as_slice()),
        metadata,
    }
}

fn parse_metadata_block(block: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(block);
    let start = text.find("StreamTitle='")? + "StreamTitle='".len();
    let rest = &text[start..];
    let end = rest.find('\'')?;
    let title = rest[..end].trim();
    if title.is_empty() {
        None
    } else {
        Some(title.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_metadata_block() {
        // metaint=4: "AAAA" + len byte 1 (16 bytes) + "BBBB"
        let mut chunk = Vec::new();
        chunk.extend_from_slice(b"AAAA");
        chunk.push(1);
        let meta = b"StreamTitle='X';\x00\x00\x00\x00\x00\x00\x00";
        chunk.extend_from_slice(&meta[..16]);
        chunk.extend_from_slice(b"BBBB");
        let result = parse_chunk(&chunk, 4);
        assert_eq!(result.audio.to_vec(), b"AAAABBBB");
        assert_eq!(result.metadata.as_deref(), Some("X"));
    }

    #[test]
    fn passes_through_without_metaint() {
        let result = parse_chunk(b"hello", 0);
        assert_eq!(result.audio.to_vec(), b"hello");
        assert!(result.metadata.is_none());
    }
}
