# Architecture

## Overview

Livy is a hybrid TypeScript–Rust application. TypeScript owns everything
application-shaped (HTTP, validation, auth, config, orchestration, persistence);
Rust owns the byte-level hot paths (codec probing, playlist parsing, ICY
metadata stripping). The native addon is **optional**: every native capability
has a TypeScript fallback with identical semantics, so the server runs with or
without a Rust toolchain.

## Layers

### TypeScript layer (`src/`)

| Module | Responsibility |
|---|---|
| `api/server.ts` | Hono app assembly, health/info/config/metrics routes, error mapping |
| `api/routes/stations.ts` | Station / stream-source / playlist CRUD, import/export |
| `api/routes/streams.ts` | Play, stream proxy, status, session management |
| `api/routes/sources.ts` | Source list/health, `loadtracks`, `trackstream` (NodeLink-style) |
| `api/routes/hls.ts` | HLS playlist rewrite + segment proxy (AES-128 aware) |
| `api/middleware.ts` | Request logging, Bearer auth, CORS |
| `api/ratelimit.ts` | Token-bucket rate limiter (NodeLink rateLimitManager-style) |
| `api/schemas.ts` | zod request schemas |
| `sources/` | Source system (see below) |
| `stations/service.ts` | Station business logic; station isolation |
| `streams/service.ts` | Playback sessions, upstream failover proxy via the source manager |
| `audio/codecs.ts` | Codec sniffing (ID3/fLaC/OggS/ADTS/MP3 sync), MIME mapping |
| `audio/hls.ts` | M3U8 (master/media) and M3U parsing/serialisation |
| `audio/pipeline.ts` | ICY metadata stripping, ID3v2 skipping, native probe delegation |
| `audio/native.ts` | napi addon loader with graceful fallback |
| `db/` | `DatabaseAdapter` interface + memory/sqlite/postgres drivers |
| `metrics.ts` | Prometheus text exposition (counters + gauges) |
| `config.ts` | Env parsing/validation (zod) |
| `errors.ts` | Typed errors → HTTP status mapping |
| `logger.ts` | Structured JSON-lines logger |

### Source system (`src/sources/`)

Modelled on NodeLink's source architecture:

| Module | Responsibility |
|---|---|
| `types.ts` | `SourceInstance`, `TrackInfo`, `TrackData`, `SourceResult` contracts |
| `track.ts` | Lavalink-compatible base64 track encode/decode |
| `manager.ts` | `SourceManager` — prefix routing (`source:query`), URL patterns, health probes |
| `http.ts` | Direct audio URLs: HEAD→GET validation, ID3 skip, Range reconnect + backoff |
| `icecast.ts` | Icecast/Shoutcast mounts: `icy-*` headers, metadata stripping |
| `hls.ts` | M3U8 master/media, variant selection, AES-128-CBC segment decryption |
| `m3u.ts` | M3U playlists → track lists |
| `local.ts` | `file://` paths and absolute filesystem paths |

Identifiers route by `source:` prefix first, then by URL pattern in priority
order (icecast mount points → http files → hls → m3u → local). Station
streaming proxies through the same manager, so station sources get identical
hardening as `loadtracks` resolution.

### Rust layer (`native/`)

Built with [napi-rs](https://napi.rs) (Node-API). Exposes:

- `version`, `supportedCodecs` — capability probing
- `probeAudio(data)` — codec detection from raw bytes
- `parseHlsPlaylist(text, baseUrl)` — M3U8 parsing → JSON
- `icyParse(chunk, metaint)` — ICY metadata stripping
- `bufferStats(data)` — benchmark helper

Unit tests live in each Rust module (`cargo test`).

### Data model

```
Station 1───* StreamSource    (priority-ordered upstream failover list)
Station 1───* Playlist        (named, ordered URL entries)
Station 1───* PlaybackSession (ephemeral; in-memory only)
```

Stations are fully isolated: every repository operation is scoped by
`stationId`, and stream sessions are tracked per-station in `StreamService`.
The model leaves room for future extensions (permissions, categories,
schedules, analytics) without schema changes to existing tables.

### Database adapters

All persistence goes through `DatabaseAdapter` (`src/db/adapter.ts`):

- **memory** — zero-dependency, for development/tests. Data is lost on restart.
- **sqlite** — Bun's built-in `bun:sqlite`, WAL mode, parameterised queries.
  Schema is created idempotently on `init()`.
- **postgres** — the `postgres` npm package (optional dependency) with a
  connection pool. Same schema as SQLite.

Drivers are created by `createDatabase()` from `DATABASE_TYPE`.

### Streaming flow

1. `POST /api/v1/stations/:id/play` creates a session (capacity-checked).
2. `GET /api/v1/stations/:id/stream?session=…` walks enabled sources in
   priority order, fetching the first reachable upstream.
3. The response body pipes upstream bytes to the listener with minimal
   copying; ICY metadata (if `icy-metaint` is present) is stripped and
   `StreamTitle` values are logged.
4. Bytes streamed are counted per session; `GET …/status` reports listener
   count, active source and now-playing.

### Deployment topology

- **Persistent host (Deplexo / self-hosted):** `src/index.ts` via Bun or Node.
  Continuous streaming runs here.
- **Vercel serverless:** `api/index.ts` exposes the management API only.
  Serverless functions are stateless and time-limited, so they never proxy
  continuous audio. Point `DATABASE_TYPE=postgres` at an external database.

## Error model

`LivyError` subclasses carry an HTTP status and stable `code`:
`NOT_FOUND` (404), `VALIDATION_ERROR` (400), `CONFLICT` (409),
`UNAUTHORIZED` (401), `STREAM_ERROR` (502), `CAPACITY_EXCEEDED` (429).
The Hono `onError` handler renders `{ error, message, details? }` JSON.
