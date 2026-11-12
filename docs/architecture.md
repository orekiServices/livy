# Livy Architecture

## Overview

Livy is a hybrid TypeScript + Rust radio streaming server. The design
follows NodeLink's proven separation (API/session layer vs. audio
pipeline) but targets HTTP radio streaming instead of Discord voice.

```
┌─────────────────────────────────────────────────────────────┐
│ TypeScript layer (Node.js + Fastify)                        │
│  routes/      HTTP API, validation, auth                    │
│  services/    stations, sources, playlists, playback        │
│  db/          adapter interface + drivers                   │
│  audio/       codecs, M3U8, ICY, pipeline (orchestration)  │
└──────────────┬──────────────────────────────────────────────┘
               │ Node-API (napi-rs) — zero-copy Buffers
┌──────────────▼──────────────────────────────────────────────┐
│ Rust layer (native/)                                        │
│  parse_m3u8 · detect_format · apply_gain_pcm16              │
│  count_mp3_frames · resample_pcm16                          │
└─────────────────────────────────────────────────────────────┘
```

## Design decisions

### Why Fastify + Zod
Fastify gives high-throughput HTTP with first-class TypeScript and
built-in validation; Zod validates request bodies and environment
configuration at the boundary. Both are maintained, mainstream choices.

### Why a native fallback
The Rust addon is optional at runtime. `src/audio/native.ts` loads the
addon if present and otherwise uses pure-TS implementations with
identical semantics. This keeps local development, CI and serverless
deployments working without a Rust toolchain, while production
containers build the addon for hot-loop performance.

### Database abstraction
All persistence goes through `DatabaseAdapter`. Drivers:
- **memory** — dev/tests/serverless (stateless).
- **json** — small self-hosted deployments (single file).
- **sqlite** — Node's built-in `node:sqlite`, WAL mode, FK cascades.
- **postgres / mysql** — optional drivers loaded lazily via dynamic
  import (`src/db/postgres.ts`, `src/db/mysql.ts`); they are not
  required dependencies of the core server.

### Station isolation
Each station owns its sources/playlists in the DB (scoped by
`stationId`) and its playback session in `PlaybackService` (keyed by
station id). Deleting a station cascades to its sources and playlists
in every adapter.

### Streaming pipeline
`openStream()`:
1. **Progressive HTTP** — fetch upstream with timeout/abort, pipe to
   listener, inject ICY metadata blocks every 8 KiB when requested.
2. **HLS** — fetch media playlist, stream from the live edge, refresh
   the playlist as segments are consumed (VOD ends cleanly).
3. **Cleanup** — listener disconnect aborts the upstream fetch;
   per-station listener caps prevent resource exhaustion.

### Lavalink v4 compatibility
Stations resolve as stream "tracks" via `/v4/loadtracks`. The
`encoded` payload is `base64url({stationId, url})`. This is a
deliberate subset of Lavalink — Livy's native API is `/api/v1/*`.

## Project structure

```
src/
  index.ts        entry point (persistent server)
  server.ts       app factory (shared by server + serverless)
  config.ts       env validation (Zod)
  types/          domain types
  db/             adapter interface + memory/json/sqlite/postgres/mysql
  audio/          native loader, m3u8, codecs, icy, pipeline
  services/       station, stream, playlist, playback
  middleware/     auth, error handling
  routes/         stations, streams, playlists, playback, health, lavalink
  utils/          errors, ids, logger
native/           Rust crate (napi-rs)
api/              Vercel serverless entry
tests/            vitest unit + integration tests
docs/             architecture, API, deployment, research notes
```
