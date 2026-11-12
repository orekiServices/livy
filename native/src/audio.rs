//! Codec probing from raw bytes.
//!
//! Header sniffing only — full decode (MP3/FLAC/AAC via symphonia) is a
//! future extension behind the same `probeAudio` surface. The TypeScript
//! fallback implements identical sniffing rules.

use crate::AudioInfo;

/// Sniff the codec from the first bytes of a stream.
pub fn probe(data: &[u8]) -> Option<AudioInfo> {
    if data.len() < 4 {
        return None;
    }

    // ID3v2 tag → MP3
    if data[0] == 0x49 && data[1] == 0x44 && data[2] == 0x33 {
        return Some(info("mp3"));
    }
    // fLaC magic
    if data[0] == 0x66 && data[1] == 0x4c && data[2] == 0x61 && data[3] == 0x43 {
        return Some(info("flac"));
    }
    // OggS → Opus or Vorbis
    if data[0] == 0x4f && data[1] == 0x67 && data[2] == 0x67 && data[3] == 0x53 {
        let text = String::from_utf8_lossy(data);
        if text.contains("OpusHead") {
            return Some(info("opus"));
        }
        return Some(info("vorbis"));
    }
    // ADTS sync → AAC
    if data[0] == 0xff && (data[1] & 0xf6) == 0xf0 {
        return Some(info("aac"));
    }
    // MP3 frame sync
    if data[0] == 0xff && (data[1] & 0xe0) == 0xe0 {
        return Some(info("mp3"));
    }

    None
}

fn info(codec: &str) -> AudioInfo {
    AudioInfo {
        codec: codec.to_string(),
        sample_rate: 0,
        channels: 0,
        duration_ms: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_flac_magic() {
        let data = b"fLaC\x80\x00\x00\x00";
        assert_eq!(probe(data).unwrap().codec, "flac");
    }

    #[test]
    fn detects_id3_mp3() {
        let data = b"ID3\x04\x00\x00\x00";
        assert_eq!(probe(data).unwrap().codec, "mp3");
    }

    #[test]
    fn detects_adts_aac() {
        let data = [0xff, 0xf1, 0x50, 0x80];
        assert_eq!(probe(&data).unwrap().codec, "aac");
    }

    #[test]
    fn returns_none_for_short_input() {
        assert!(probe(b"ab").is_none());
    }
}
