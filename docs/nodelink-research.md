# NodeLink Research Notes

Research basis for Livy's design. Primary sources: the NodeLink
repository (PerformanC/NodeLink) and the Lavalink v4 REST
documentation.

## What NodeLink is

NodeLink is a Lavalink-compatible audio server written in Node.js
(TypeScript). It implements the Lavalink v4 protocol — REST endpoints
under `/v4/*` plus a WebSocket session gateway — and adds extensions
beyond stock Lavalink:

- **Source resolution** — a source manager picks a provider module by
  identifier/search prefix (YouTube, SoundCloud, Spotify, …). Some
  sources return playable streams directly; others resolve metadata
  and delegate audio retrieval.
- **Segmented streaming** — HLS (master + media playlists, AES-128
  decryption, live windows) and DASH (MPD manifests, fragmented MP4)
  handlers with buffering/backpressure.
- **Audio pipeline** — 48 kHz / 20 ms PCM frames (960 samples/channel,
  3,840 bytes stereo 16-bit), Opus encoding for Discord voice, with
  a 19,200-byte high-water mark (5 frames) for backpressure.
- **Extensions** — lyrics (`/v4/loadlyrics`), chapters
  (`/v4/loadchapters`), direct stream URLs (`/v4/trackstream`), raw
  PCM (`/v4/loadstream`), filters, mixing, ducking, SponsorBlock,
  Prometheus metrics, profiler.
- **Detection** — `/v4/info` includes `isNodelink: true` so clients
  can feature-detect.

## Lavalink v4 REST surface (subset)

| Endpoint | Purpose |
|---|---|
| `GET /v4/loadtracks?identifier=` | Resolve a track/playlist/search |
| `GET /v4/decodetrack?encodedTrack=` | Decode an encoded track |
| `POST /v4/decodetracks` | Batch decode |
| `GET /v4/info` | Server info (version, source managers, filters) |
| `GET /v4/stats` | Players, memory, CPU, frame stats |
| `GET /v4/version` | Version info |

Track objects carry `encoded` (opaque base64), `info` (identifier,
title, author, length, isStream, sourceName, …), `pluginInfo` and
`userData`. Load results use `loadType`: `track | playlist | search |
empty | error`.

## What Livy adopts

- **Lavalink v4 compatibility layer** (`src/routes/lavalink.ts`) —
  stations resolve as stream tracks; `encoded` is
  `base64url({stationId, url})`. Existing Lavalink clients can
  discover Livy stations via `loadtracks` with a station id, slug,
  `livysearch:` query, or direct URL.
- **Source resolution pattern** — Livy's stream sources are the
  radio equivalent of NodeLink's source modules: each station has
  prioritized sources; the primary enabled source is used for
  playback.
- **HLS handling** — media/master playlist parsing, live-edge
  streaming, playlist refresh (see `src/audio/pipeline.ts`).
- **Backpressure-aware piping** — Node streams with configurable
  `highWaterMark` (`STREAM_BUFFER_SIZE`).
- **Feature detection** — `/v4/info` includes `isLivy: true`
  (alongside `isNodelink: false`) so clients can distinguish Livy.

## What Livy deliberately changes

- **HTTP radio instead of Discord voice** — no Opus/Discord voice
  packets; output is the source audio (MP3/FLAC/…) with ICY metadata
  for standard radio players.
- **Multi-station model** — NodeLink manages per-guild players;
  Livy manages independent stations with their own sources,
  playlists and sessions.
- **Database abstraction** — NodeLink is largely in-memory; Livy
  adds pluggable persistence (memory/json/sqlite/postgres/mysql).
- **Deployment split** — persistent streaming server vs. serverless
  API layer, since continuous streaming cannot run in Vercel
  functions.
