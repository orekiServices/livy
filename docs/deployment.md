# Livy Deployment Guide

## Runtime model

Continuous radio streaming needs a **persistent process**: long-lived
HTTP connections, upstream fetches and in-memory sessions. Livy
therefore separates:

- **Persistent streaming server** — Deplexo / Docker / any Node host.
  Serves `/stream/*`, `/hls/*` and the full API.
- **Serverless API layer** — Vercel. Serves only stateless endpoints
  (stations, sources, playlists, Lavalink compat, health) with the
  in-memory adapter. `/stream/*` returns `501` with guidance.

## Deplexo

Deplexo is a managed PaaS that deploys GitHub repositories as
always-on containers with automatic HTTPS and custom domains. It
auto-detects Node.js projects; Livy ships `deplexo.yaml` and a
`Dockerfile` (multi-stage: builds TS + Rust native addon, runs slim).

1. Push the repo to GitHub.
2. Connect the repo in Deplexo.
3. Set environment variables (`DB_TYPE=sqlite`, `API_KEY`, …).
4. Deploy — Livy listens on the configured `PORT` (default 3000).

## Vercel Serverless

`vercel.json` + `api/index.ts` expose the API surface. Limitations
(by design, not by accident):

- Functions are stateless (60s max) — no continuous streams.
- Filesystem is read-only — the in-memory adapter is forced.
- Data does not persist between invocations.

Use Vercel for the management API in front of a persistent streaming
server, or for demos/tests.

## Self-hosted (Docker)

```bash
docker build -t livy .
docker run -d --name livy -p 3000:3000 \
  -e DB_TYPE=sqlite -e DB_URL=/data/livy.db \
  -v livy-data:/data livy
```

Or without Docker:

```bash
npm ci && npm run build && npm start
```

For production, run behind a reverse proxy (nginx/Caddy) with TLS,
and set `API_KEY` to protect mutating routes.

## Environment variables

See `.env.example`. The most important:

| Variable | Notes |
|---|---|
| `DB_TYPE` / `DB_URL` | `sqlite` + file path recommended for self-hosting |
| `API_KEY` | Protects mutating API routes |
| `STREAM_MAX_LISTENERS_PER_STATION` | Resource guard |
| `LOG_LEVEL` | `info` in production, `debug` when diagnosing |
