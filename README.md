# Livy

**Livy** is a production-ready, extensible **radio streaming server** built with
**TypeScript and Rust** — a flexible TypeScript application layer for HTTP APIs,
routing, validation and orchestration, backed by a Rust native layer (Node-API /
napi-rs) for performance-critical audio work: codec probing, M3U8/HLS parsing
and ICY metadata stripping.

Livy is inspired by [NodeLink](https://github.com/PerformanC/NodeLink) (the
Node.js Lavalink-compatible audio server) but is purpose-built for **multi-station
radio streaming**: unlimited independent stations, each with its own stream
sources, playlists and playback sessions, behind a database-agnostic adapter
layer.

## Features

- **Multi-station management** — create, update, delete and organise unlimited
  stations; each station owns an isolated collection of stream sources and
  playlists. Import/export station configurations as JSON.
- **Streaming proxy with failover** — listeners connect to a station session;
  Livy proxies the highest-priority reachable upstream (Icecast/Shoutcast/HLS/
  direct) with automatic failover and ICY `StreamTitle` metadata handling.
- **NodeLink-style source system** — five providers (http, icecast, hls, m3u,
  local) behind a prefix-routed source manager, with `loadtracks` /
  `trackstream` resolution, HEAD→GET validation, ID3v2 skipping, Range
  reconnect with backoff, HLS segment proxying with AES-128 decryption,
  source health probes, Prometheus metrics and token-bucket rate limiting.
- **Hybrid TS + Rust** — Rust native addon (napi-rs) for codec probing, HLS
  parsing and ICY stripping, with a pure-TypeScript fallback so the server runs
  with or without the addon built.
- **Database-agnostic** — unified adapter interface with in-memory, SQLite
  (Bun-native) and PostgreSQL drivers. Connection pooling and schema creation
  are handled per-driver.
- **Deployment-aware** — persistent runtime for Deplexo/self-hosted (Docker),
  plus a Vercel serverless API layer for management endpoints (continuous
  streaming never runs inside serverless functions).
- **Typed API** — strict TypeScript, zod validation, structured JSON errors,
  Bearer-token auth, health/readiness probes, graceful shutdown.

## Quick start

Requires [Bun](https://bun.sh) ≥ 1.1 (or Node.js ≥ 20).

```bash
bun install
cp .env.example .env
bun run dev          # watch mode on http://localhost:2333
```

```bash
# Create a station
curl -X POST localhost:2333/api/v1/stations \
  -H 'Content-Type: application/json' \
  -d '{"name":"Lo-Fi Beats","streamUrl":"https://example.com/lofi.mp3"}'

# Start a listener session and stream
curl -X POST localhost:2333/api/v1/stations/<id>/play
curl "localhost:2333/api/v1/stations/<id>/stream?session=<sessionId>"
```

## Scripts

| Command | Description |
|---|---|
| `bun run dev` | Dev server with watch mode |
| `bun run start` | Start the server |
| `bun run build` | Build TypeScript + native addon |
| `bun run build:native` | Build the Rust addon (requires Rust toolchain) |
| `bun run check` | Biome lint + strict typecheck |
| `bun run check:bun` | Bun-native type checker (`bun check`, ~10× faster than tsc) |
| `bun run lint` | `bunx @biomejs/biome check .` |
| `bun run fmt` | Bun-native formatter (`bun fmt`) |
| `bun run build:exe` | Standalone executable (`bun build --compile`) |
| `bun run start:smol` | Low-memory mode (`--smol`, for constrained hosts) |
| `bun run test` | Run the test suite (`bun test`) |
| `bun run bench` | Audio pipeline benchmarks |
| `bun run db:migrate` | Initialise the configured database schema |

## Configuration

All configuration is via environment variables — see [`.env.example`](.env.example).

| Variable | Default | Description |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `2333` | Bind address |
| `API_KEY` | *(empty)* | Bearer token for `/api/v1`; empty disables auth |
| `DATABASE_TYPE` | `memory` | `memory` \| `sqlite` \| `postgres` |
| `DATABASE_PATH` | `./data/livy.db` | SQLite file path |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `MAX_LISTENERS_PER_STATION` | `100` | Per-station listener cap |
| `STREAM_TIMEOUT_MS` | `15000` | Upstream fetch timeout |
| `USE_NATIVE_AUDIO` | `true` | Use the Rust addon when built |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins |

## API overview

See [docs/api.md](docs/api.md) for the full reference. Highlights:

- `GET /health`, `GET /ready` — liveness/readiness probes
- `GET /api/v1/info` — server info incl. native addon availability
- `GET/POST /api/v1/stations` — station collection
- `GET/PATCH/DELETE /api/v1/stations/:id` — single station
- `GET/POST /api/v1/stations/:id/streams` — upstream sources (failover order)
- `GET/POST /api/v1/stations/:id/playlists` — playlists
- `POST /api/v1/stations/:id/play` — start a listener session
- `GET /api/v1/stations/:id/stream?session=…` — audio stream
- `GET /api/v1/stations/:id/status` — listener count, active source, now playing
- `GET /api/v1/stations/:id/export`, `POST /api/v1/stations/import` — JSON portability

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ TypeScript layer (Bun / Node)                           │
│  HTTP API (Hono) · validation (zod) · auth · config     │
│  StationService · StreamService · DB adapters           │
└───────────────┬───────────────────────────┬─────────────┘
                │ napi-rs (optional)        │ fetch proxy
┌───────────────▼───────────────────────────▼─────────────┐
│ Rust native addon (native/)                             │
│  codec probing · M3U8/HLS parsing · ICY stripping       │
└─────────────────────────────────────────────────────────┘
```

See [docs/architecture.md](docs/architecture.md) for details.

## Deployment

- **Deplexo / self-hosted:** `Dockerfile` + `deplexo.yaml` run the persistent
  streaming runtime. See [docs/deployment.md](docs/deployment.md).
- **Vercel:** `api/index.ts` + `vercel.json` expose the management API as
  serverless functions; streaming runs on the persistent host.

## Project structure

```
src/          TypeScript application
  api/        Hono routes, middleware, schemas
  audio/      codec sniffing, HLS/M3U parsing, pipeline, native loader
  db/         adapter interface + memory/sqlite/postgres drivers
  stations/   station business logic
  streams/    playback sessions + upstream proxy
native/       Rust napi-rs addon
api/          Vercel serverless entry point
tests/        bun test suites
benchmarks/   audio pipeline benchmarks
docs/         architecture, API, deployment, native guides
```

## License

MIT
