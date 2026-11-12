# Livy — TypeScript & Rust Hybrid Radio Streaming Server

Livy is a production-ready, extensible radio streaming server built with
**TypeScript and Rust**, combining the flexibility of a TypeScript
architecture with the performance of native Rust components. It is
inspired by [NodeLink](https://github.com/PerformanC/NodeLink) (a
Lavalink-v4-compatible audio server) and adapts its concepts — source
resolution, HLS handling, REST + session APIs — for HTTP radio
streaming with independent multi-station management.

## Features

- **Multi-station management** — unlimited stations, each with its own
  stream sources, playlists and playback session (fully isolated state).
- **Hybrid TS + Rust** — TypeScript handles APIs, orchestration and
  integrations; Rust (Node-API) handles M3U8 parsing, format detection,
  PCM processing and resampling. A pure-TS fallback keeps everything
  working without a Rust toolchain.
- **Pluggable databases** — in-memory, JSON file, SQLite (built-in
  `node:sqlite`), plus optional Postgres/MySQL drivers behind one
  adapter interface.
- **Streaming pipeline** — HTTP proxying, HLS live-edge following,
  ICY metadata injection, per-station listener limits.
- **Lavalink v4 compatibility** — `/v4/info`, `/v4/loadtracks`,
  `/v4/decodetrack(s)`, `/v4/stats` so existing Lavalink clients work.
- **Deployment-aware** — persistent server for Deplexo/self-hosted
  (continuous streaming), serverless API layer for Vercel.

## Quick start

```bash
npm install
npm run build
npm start          # http://localhost:3000
```

Create a station and attach a stream:

```bash
# 1. Create a station
curl -X POST localhost:3000/api/v1/stations \
  -H 'Content-Type: application/json' \
  -d '{"name":"My Radio"}'

# 2. Add a stream source
curl -X POST localhost:3000/api/v1/stations/<id>/sources \
  -H 'Content-Type: application/json' \
  -d '{"name":"Main","url":"https://example.com/stream.mp3"}'

# 3. Listen
curl localhost:3000/stream/<id> --output out.mp3
```

## Configuration

Copy `.env.example` to `.env` and adjust. Key variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Server bind |
| `API_KEY` | _(empty)_ | If set, mutating routes require `Authorization: Bearer <key>` |
| `DB_TYPE` | `memory` | `memory` \| `json` \| `sqlite` \| `postgres` \| `mysql` |
| `DB_URL` | `./data/livy.db` | File path or connection string |
| `STREAM_MAX_LISTENERS_PER_STATION` | `1000` | Listener cap |
| `LAVALINK_ENABLED` / `LAVALINK_PASSWORD` | `true` / `livy` | Lavalink compat layer |

## API

See [docs/api.md](docs/api.md) for the full reference.

| Area | Endpoints |
|---|---|
| Stations | `POST/GET /api/v1/stations`, `GET/PATCH/DELETE /api/v1/stations/:id`, `GET .../export`, `POST /api/v1/stations/import` |
| Sources | `POST/GET /api/v1/stations/:stationId/sources`, `GET/PATCH/DELETE /api/v1/sources/:id` |
| Playlists | `POST/GET /api/v1/stations/:stationId/playlists`, `GET/PATCH/DELETE /api/v1/playlists/:id`, `.../import-m3u`, `.../export-m3u` |
| Playback | `GET /stream/:stationId`, `GET /stream/:stationId/status`, `GET /hls/:stationId/playlist.m3u8` |
| Ops | `GET /health`, `GET /ready`, `GET /api/v1/status` |
| Lavalink v4 | `GET /v4/info`, `/v4/version`, `/v4/stats`, `/v4/loadtracks`, `/v4/decodetrack(s)` |

## Rust native module

```bash
npm --prefix native install
npm --prefix native run build   # requires Rust toolchain
```

The native addon accelerates M3U8 parsing, format detection, PCM gain,
MP3 frame counting and resampling. Without it, Livy uses identical
pure-TS implementations.

## Deployment

- **Deplexo** — `deplexo.yaml` + `Dockerfile` included; Livy runs as an
  always-on container (required for continuous streaming).
- **Vercel** — `vercel.json` + `api/index.ts` expose the stateless API
  only; `/stream/*` returns `501` with guidance (serverless cannot hold
  continuous streams).
- **Self-hosted** — `docker build -t livy . && docker run -p 3000:3000 livy`.

See [docs/deployment.md](docs/deployment.md).

## Tests

```bash
npm test
```

## Documentation

- [Architecture](docs/architecture.md)
- [API reference](docs/api.md)
- [Deployment](docs/deployment.md)
- [NodeLink research notes](docs/nodelink-research.md)

## License

MIT
