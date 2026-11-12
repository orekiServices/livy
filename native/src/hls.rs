//! M3U8 / HLS playlist parsing.
//!
//! Mirrors the TypeScript fallback (`src/audio/hls.ts`) so both
//! implementations produce the same shape. The TypeScript side validates
//! the JSON output with zod.

use napi::bindgen_prelude::*;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsVariant {
    pub url: String,
    pub bandwidth: Option<u32>,
    pub resolution: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsSegment {
    pub url: String,
    pub duration: f64,
    pub sequence: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsPlaylist {
    pub is_master: bool,
    pub variants: Vec<HlsVariant>,
    pub segments: Vec<HlsSegment>,
    pub target_duration: Option<u32>,
    pub media_sequence: u32,
    pub is_end_list: bool,
    pub version: Option<u32>,
}

fn resolve_url(base: &str, relative: &str) -> String {
    // Minimal URL resolution: absolute URLs pass through, relative ones are
    // joined against the base's directory. Full RFC 3986 resolution lives
    // on the TypeScript side (new URL()).
    if relative.starts_with("http://") || relative.starts_with("https://") {
        return relative.to_string();
    }
    if let Some(idx) = base.rfind('/') {
        format!("{}/{}", &base[..idx], relative.trim_start_matches('/'))
    } else {
        relative.to_string()
    }
}

fn parse_attributes(input: &str) -> std::collections::HashMap<String, String> {
    let mut attrs = std::collections::HashMap::new();
    for part in input.split(',') {
        if let Some((k, v)) = part.split_once('=') {
            attrs.insert(k.trim().to_string(), v.trim().trim_matches('"').to_string());
        }
    }
    attrs
}

/// Parse an M3U8 playlist text.
pub fn parse(text: &str, base_url: &str) -> Result<HlsPlaylist> {
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    if lines.first().map(|l| l.starts_with("#EXTM3U")).unwrap_or(false) == false {
        return Err(Error::new(Status::InvalidArg, "Invalid M3U8 playlist: missing #EXTM3U header"));
    }

    let mut playlist = HlsPlaylist {
        is_master: false,
        variants: Vec::new(),
        segments: Vec::new(),
        target_duration: None,
        media_sequence: 0,
        is_end_list: false,
        version: None,
    };

    let mut pending_duration = 0.0f64;
    let mut sequence = 0u32;
    let mut i = 1;

    while i < lines.len() {
        let line = lines[i].unwrap_or("");
        if line.is_empty() {
            i += 1;
            continue;
        }

        if let Some(rest) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            playlist.is_master = true;
            let attrs = parse_attributes(rest);
            if let Some(next) = lines.get(i + 1) {
                if !next.starts_with('#') {
                    playlist.variants.push(HlsVariant {
                        url: resolve_url(base_url, next),
                        bandwidth: attrs.get("BANDWIDTH").and_then(|v| v.parse().ok()),
                        resolution: attrs.get("RESOLUTION").cloned(),
                    });
                    i += 1;
                }
            }
        } else if let Some(rest) = line.strip_prefix("#EXTINF:") {
            pending_duration = rest.split(',').next().unwrap_or("0").parse().unwrap_or(0.0);
        } else if let Some(rest) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            playlist.target_duration = rest.parse().ok();
        } else if let Some(rest) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            playlist.media_sequence = rest.parse().unwrap_or(0);
            sequence = playlist.media_sequence;
        } else if let Some(rest) = line.strip_prefix("#EXT-X-VERSION:") {
            playlist.version = rest.parse().ok();
        } else if line == "#EXT-X-ENDLIST" {
            playlist.is_end_list = true;
        } else if !line.starts_with('#') {
            playlist.segments.push(HlsSegment {
                url: resolve_url(base_url, line),
                duration: pending_duration,
                sequence,
            });
            sequence += 1;
            pending_duration = 0.0;
        }

        i += 1;
    }

    Ok(playlist)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_media_playlist() {
        let text = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:42\n#EXTINF:9.5,\nseg1.ts\n#EXTINF:9.5,\nseg2.ts\n#EXT-X-ENDLIST\n";
        let pl = parse(text, "https://example.com/live/playlist.m3u8").unwrap();
        assert!(!pl.is_master);
        assert_eq!(pl.segments.len(), 2);
        assert_eq!(pl.segments[0].sequence, 42);
        assert!(pl.is_end_list);
    }

    #[test]
    fn parses_master_playlist() {
        let text = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nmid.m3u8\n";
        let pl = parse(text, "https://example.com/master.m3u8").unwrap();
        assert!(pl.is_master);
        assert_eq!(pl.variants.len(), 2);
        assert_eq!(pl.variants[0].bandwidth, Some(800000));
    }

    #[test]
    fn rejects_missing_header() {
        assert!(parse("not a playlist", "https://x/").is_err());
    }
}
