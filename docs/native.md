# Native addon (Rust / napi-rs)

The Rust addon in `native/` implements performance-critical audio operations
behind Node-API bindings. It is **optional** — the TypeScript layer probes for
it at startup and falls back to pure-TypeScript implementations when absent.

## What it provides

| Export | Description |
|---|---|
| `version` | Addon version string |
| `supportedCodecs()` | `["mp3", "flac", "aac", "opus", "vorbis"]` |
| `probeAudio(data)` | Codec detection from raw bytes → `{ codec, sampleRate, channels, durationMs }` |
| `parseHlsPlaylist(text, baseUrl)` | M3U8 parsing → JSON (master + media playlists) |
| `icyParse(chunk, metaint)` | ICY metadata stripping → `{ audio, metadata }` |
| `bufferStats(data)` | Length + checksum (benchmark helper) |

## Building

Requires a Rust toolchain (stable) and the napi CLI:

```bash
bun run build:native          # release build
bun run build:native:debug    # debug build
cargo test --manifest-path native/Cargo.toml   # Rust unit tests
```

The build outputs `native/livy-native.*.node`, which
`src/audio/native.ts` loads via `createRequire`. No code changes are needed
on the TypeScript side — `GET /api/v1/info` will report
`nativeAvailable: true`.

## Design notes

- **Zero-copy where it matters:** `probeAudio` and `icyParse` operate on
  borrowed byte slices; the TypeScript side passes `Uint8Array` views.
- **Same semantics as the fallback:** codec sniffing rules (ID3/fLaC/OggS/
  ADTS/MP3 sync) and HLS parsing mirror `src/audio/codecs.ts` and
  `src/audio/hls.ts` exactly, so behaviour is identical with or without the
  addon. The Rust side returns JSON for HLS so TypeScript stays in control of
  validation.
- **Full decoding is a future extension:** MP3/FLAC/AAC decode via symphonia
  would slot behind the same `probeAudio` surface without API changes.

## Benchmarks

```bash
bun run bench
```

Times HLS parsing and codec sniffing in TypeScript, plus the native bindings
when the addon is built.
