# libmetro — MetroS

The relay engine behind [Livy](../README.md), written in Rust and bound to
Node with [napi-rs](https://napi.rs).

Livy forwards MP3 bytes rather than transcoding them, so the work that
scales with listeners, stations and relays is **framing**: finding frame
boundaries in a live byte stream, throwing away tags and metadata, and handing
whole frames to the pacer.

But a relay does not always arrive as MP3. An Icecast AAC station, an HLS
playlist of MPEG-TS segments, a lossless FLAC block, an MP4 chunk: all of it
has to become MP3 before it can go on air. So libmetro also decodes
(symphonia) and encodes (shine) — both pure Rust, so the addon still
cross-compiles everywhere and there is no ffmpeg to install.

```js
const metro = require('libmetro')

metro.describe()                        // 'MetroS 1.0.0 · linux · x86_64 · rust stable'
metro.sniff(buffer)                     // 'mp3' | 'aac' | 'mpeg-ts' | 'ogg' | 'flac' | 'mp4' | …
metro.probe(buffer)                     // { frames, durationMs, bitrate, sampleRate, channels, vbr }
await metro.decodeAsync(buffer)         // { left, right, sampleRate, channels, length }
metro.encodeMp3(left, right, 44100, 128)

const framer = new metro.Framer()       // live mp3 → whole frames
const out = Buffer.allocUnsafe(65536)
const r = framer.pushInto(chunk, out)   // allocation-free path
socket.write(out.subarray(0, r.bytes))

const t = new metro.Transcoder(128)     // anything → mp3, streaming
socket.on('data', (chunk) => station.write(t.push(chunk)))
socket.on('end', () => station.write(t.flush()))
t.kind                                  // what it turned out to be
t.passthrough                           // true when the feed was already mp3
```

## It is optional, always

Livy never requires this addon. `server/src/util/metro.js` loads a binary
if one exists for the host and silently uses its pure-JavaScript re-framer and
the WASM decoder if not — same API, same bytes out, a bit slower. There is no
postinstall compile step and no failure mode where a missing toolchain stops a
node from booting. Set `LIVY_DISABLE_METRO=1` to force the fallback (the
test suite runs both ways).

## What it plays

| Input | Route | Speed |
| --- | --- | --- |
| **MP3** | detected and forwarded byte for byte | a scan, no decode |
| **AAC** (ADTS: Icecast AAC, `.aac`, TS payloads) | decoded frame by frame with one long-lived decoder, re-encoded | ~145x realtime |
| **HLS** (MPEG-TS or fMP4 segments) | PAT/PMT → PES → elementary stream → decode → encode | ~72x realtime |
| **FLAC · Ogg/Vorbis · Matroska/WebM** | decoded on a worker thread that pulls as bytes arrive | ~75x realtime |
| **MP4 · M4A · ALAC · WAV · AIFF · CAF** | buffered (they need random access) and decoded whole | one pass |

HE-AAC streams decode at their base rate (symphonia has no SBR), so a 22 kHz
HE-AAC feed is aired as a 22 kHz MP3 rather than upsampled — honest, and
still perfectly listenable.

## What it buys

Measured on one machine against 44 s of 128 kbps stereo
(`bun run bench:metro` in `server/`, so you can check it on yours):

| | JavaScript | MetroS |
| --- | --- | --- |
| relay a live stream to air (64 KB chunks) | 0.48 ms | **0.42 ms** |
| probe a whole file | 0.31 ms | **0.04 ms** |
| decode 391 KB to PCM | 58.0 ms | **25.2 ms** |
| encode 5 s of stereo | ~250 ms (lamejs) | **49 ms** |

Three things matter more than the ratios:

* **Decoding runs on the thread pool.** `decodeAsync` renders a crossfade seam
  without blocking the event loop, so the pacer keeps releasing audio on time
  while automix works. That is the difference between a smooth seam and a
  hiccup on a busy node.
* **Relaying stops making garbage.** The old path produced one `Buffer` and one
  queue object per 26 ms frame — about 2,300 objects a minute per relay.
  MetroS hands the pacer a handful of contiguous blocks instead.
* **Nothing is buffered that does not have to be.** A ten-minute lossless FLAC
  block starts playing ~20 ms after the first packets arrive: the container is
  decoded on a worker thread that blocks in `read()` while the relay pushes
  bytes into it.

Straight frame scanning is roughly at parity with the JavaScript splitter for
large chunks: V8 is good, and `subarray` is free. The native engine wins where
JavaScript has to copy, allocate or decode.

## API

| | |
| --- | --- |
| `version()` | crate version |
| `describe()` | one line: version, OS, arch |
| `scanFrames(buf, skipVbrHeader?)` | array of `{ offset, length, bitrate, sampleRate, channels, samples, version, layer, durationMs }` |
| `probe(buf)` | totals for a whole buffer, without copying audio |
| `decode(buf)` / `decodeAsync(buf)` | f32 `left`/`right` channels; async runs on the thread pool |
| `sniff(buf)` | `mp3` · `aac` · `mpeg-ts` · `ogg` · `flac` · `wav` · `mp4` · `matroska` · `unknown` |
| `decodeAudio(buf)` | any supported codec → f32 channels |
| `encodeMp3(left, right, sampleRate, bitrate?)` | f32 channels → MP3 (shine) |
| `transcode(buf, bitrate?)` / `transcodeAsync` | a whole file or segment → MP3 |
| `new Transcoder(bitrate?)` | streaming: `push(chunk)` → MP3, `flush()`, `.kind`, `.passthrough`, `stats()` |
| `analyseBeat(mono, rate)` / `analyseBeatAsync` | tempo, beat grid and confidence — ~13x the JavaScript, and off the event loop |
| `timeStretch(l, r, rate, ratio, …)` / `timeStretchAsync` | WSOLA: change the tempo, leave the pitch |
| `new Framer({ skipVbrHeader, lengths })` | streaming re-framer |
| `framer.push(chunk)` | `{ data, lengths?, frames, durationMs, pending, dropped, info }` — one contiguous buffer, not an array of frames |
| `framer.pushInto(chunk, out, lengths?)` | the same, written into a buffer you own: zero allocation per chunk |
| `framer.stats()` / `.pending` / `.dropped` / `.reset()` | relay health |

Bitrates are **kbps** and durations are **milliseconds**, matching
`server/src/util/mp3.js` exactly — the two engines are interchangeable.

### Framing is strict on purpose

A lone `0xFF 0xEx` pair is not a frame. A candidate header is accepted only
when the frame it describes is followed by *another* valid header (or the end
of the buffer). That single check is what stops ID3 artwork, Shoutcast
metadata and plain noise from being aired as audio; on a resync the scanner
hunts the next sync word rather than crawling byte by byte.

ID3v2 tags (including ones that span several chunks) and Xing/Info/VBRI
headers are dropped rather than broadcast.

## Building

```sh
cargo build --release && bun scripts/link-local.js   # just Rust + Node
bun install && bun run build                          # via @napi-rs/cli
./scripts/build-linux-universal.sh                    # every Linux arch, from one box
```

### Every Linux architecture, from one machine

`scripts/build-linux-universal.sh` builds the whole Linux set without Docker
and without root. Cross-linking needs a linker that knows the target's libc;
[zig](https://ziglang.org) ships one for every target in a single tarball,
and `cargo-zigbuild` teaches cargo to use it:

| File | Runs on |
| --- | --- |
| `libmetro.linux-x64-gnu.node` | any x86-64 glibc distro — Debian, Ubuntu, RHEL, Arch |
| `libmetro.linux-x64-musl.node` | Alpine and other musl x86-64 (most Docker images) |
| `libmetro.linux-arm64-gnu.node` | Raspberry Pi 4/5 64-bit, Graviton, Ampere, Oracle free tier |
| `libmetro.linux-arm64-musl.node` | Alpine on arm64 |
| `libmetro.linux-arm-gnueabihf.node` | 32-bit ARM — Pi 2/3, older SBCs |

The glibc builds are pinned to **glibc 2.17** (CentOS 7 era), so one binary
runs on every distro still in service rather than only on machines newer than
the one that built it. Override with `LIBMETRO_GLIBC=2.28 ./scripts/…`.

Drop the whole set next to `index.js` and forget about it: the loader picks
the one that fits at `require()` time, and a binary that is present but will
not load (wrong libc, truncated download) is skipped rather than fatal — the
node simply continues on the JavaScript path and says so.

Either way the result is `libmetro.<platform>-<arch>[-abi].node` next to
`index.js`, which is exactly what the loader looks for.

Only `symphonia` (decode) and `shine` (encode) are used, both pure Rust, so
there is no ffmpeg, no system codec and nothing to install on the target
machine — and every target below cross-compiles from CI:

```
darwin-x64      darwin-arm64
linux-x64-gnu   linux-arm64-gnu   linux-arm-gnueabihf
linux-x64-musl  linux-arm64-musl
win32-x64-msvc  win32-arm64-msvc
```

`.github/workflows/libmetro.yml` builds the matrix and uploads the binaries.
The addon is compiled against N-API 8, so one binary per platform works on
every Node ≥ 16 — no rebuilds when Node upgrades.

## Licence

MIT. Livy's own licence applies to the rest of the repository.
