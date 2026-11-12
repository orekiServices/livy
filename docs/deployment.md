# Deployment

Livy has two deployment shapes because continuous radio streaming cannot run
inside serverless functions (stateless, time-limited, no long-lived sockets).

## 1. Persistent runtime — Deplexo / self-hosted

Runs `src/index.ts` under Bun (or Node) and handles all streaming.

### Deplexo

Deplexo deploys GitHub repositories as always-on containers. Livy ships:

- `Dockerfile` — multi-stage Bun build → slim runtime, exposes `2333`
- `deplexo.yaml` — app name, port, healthcheck, environment

Push the repo and point Deplexo at it. The free tier (128 MB RAM / 0.25 CPU)
runs the TypeScript fallback fine; set `USE_NATIVE_AUDIO=false` there and use
`DATABASE_TYPE=sqlite` with a persistent volume mounted at `/data` (or switch
to an external Postgres via `DATABASE_URL`).

### Self-hosted (Docker / bare metal)

```bash
docker build -t livy .
docker run -p 2333:2333 -e DATABASE_TYPE=sqlite -e DATABASE_PATH=/data/livy.db -v livy-data:/data livy
```

Or directly with Bun:

```bash
bun install --frozen-lockfile
bun run build:ts
bun run start:node   # or: bun run dist/index.js
```

## 2. Serverless API — Vercel

`api/index.ts` + `vercel.json` expose the **management API** (stations,
sources, playlists, config, health) as a serverless function. Streaming
endpoints are not suitable for serverless and should be called against the
persistent host.

Configuration for Vercel:

- `DATABASE_TYPE=postgres` + `DATABASE_URL` (external database required —
  serverless instances are ephemeral)
- `API_KEY` for auth
- `USE_NATIVE_AUDIO=false` (native addons are not built in the serverless
  bundle)

## Environment reference

See [`.env.example`](../.env.example) for all variables. Key production
settings:

| Variable | Production guidance |
|---|---|
| `NODE_ENV` | `production` |
| `LOG_LEVEL` | `info` (or `warn`) |
| `API_KEY` | Set a strong random token |
| `DATABASE_TYPE` | `sqlite` (single host) or `postgres` (multi-host) |
| `MAX_LISTENERS_PER_STATION` | Tune to bandwidth/CPU |
| `STREAM_TIMEOUT_MS` | `15000` default; raise for slow upstreams |

## Native addon in production

The Rust addon is optional. To build it you need a Rust toolchain:

```bash
bun run build:native   # napi build --release --cwd native
```

The TypeScript layer detects the addon at startup (`GET /api/v1/info` reports
`nativeAvailable`). Without it, codec probing, HLS parsing and ICY stripping
run in TypeScript with identical semantics.
