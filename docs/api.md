# Livy API Reference

Base URL: `http://localhost:3000`. All JSON responses use
`{ error, message }` for failures.

## Authentication

- **API key** (optional): set `API_KEY`; mutating routes then require
  `Authorization: Bearer <key>`. Stream endpoints stay public.
- **Lavalink**: `/v4/*` routes require `Authorization: <LAVALINK_PASSWORD>`.

## Stations

### Create station
```
POST /api/v1/stations
{ "name": "My Radio", "description": "...", "defaultFormat": "mp3",
  "metadataTitle": "My Radio — Live", "categories": ["music"] }
→ 201 { id, name, slug, ... }
```

### List / get / update / delete
```
GET    /api/v1/stations
GET    /api/v1/stations/:id          (id or slug)
PATCH  /api/v1/stations/:id
DELETE /api/v1/stations/:id          → 204
```

### Export / import
```
GET  /api/v1/stations/:id/export     → { version: 1, station, sources, playlists }
POST /api/v1/stations/import         → { stationId, sourcesImported, playlistsImported }
```

## Stream sources

```
POST   /api/v1/stations/:stationId/sources
       { "name": "Main", "url": "https://…/stream.mp3", "priority": 10 }
GET    /api/v1/stations/:stationId/sources
GET    /api/v1/sources/:id
PATCH  /api/v1/sources/:id
DELETE /api/v1/sources/:id           → 204
```

Sources are ordered by `priority` (lower first). The first enabled
source is the station's primary stream.

## Playlists

```
POST   /api/v1/stations/:stationId/playlists
       { "name": "Evening", "entries": [{ "title": "Song", "url": "https://…" }] }
GET    /api/v1/stations/:stationId/playlists
GET    /api/v1/playlists/:id
PATCH  /api/v1/playlists/:id
DELETE /api/v1/playlists/:id         → 204
POST   /api/v1/stations/:stationId/playlists/import-m3u
       { "name": "Imported", "content": "#EXTM3U\n…", "baseUrl": "https://…" }
GET    /api/v1/playlists/:id/export-m3u   → audio/x-mpegurl
```

## Playback

```
GET /stream/:stationId              live audio (audio/mpeg, …) with ICY metadata
GET /stream/:stationId/status       { stationId, online, listeners, currentSourceUrl, … }
GET /hls/:stationId/playlist.m3u8   HLS media playlist
```

## Operations

```
GET /health                         { status: "ok" }
GET /ready                          DB liveness
GET /api/v1/status                  all station statuses
```

## Lavalink v4 compatibility

```
GET  /v4/info
GET  /v4/version
GET  /v4/stats
GET  /v4/loadtracks?identifier=<stationId|slug|livysearch:query|https://url>
GET  /v4/decodetrack?encodedTrack=…
POST /v4/decodetracks               { "tracks": ["…"] }
```

`loadtracks` returns `{ loadType: "track" | "search" | "empty", data }`
with Lavalink-shaped track objects (`encoded`, `info`, `pluginInfo`,
`userData`).

## Errors

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Invalid payload |
| 401 | `UNAUTHORIZED` | Bad/missing credentials |
| 404 | `NOT_FOUND` | Unknown resource |
| 409 | `CONFLICT` | Duplicate slug, unsupported import version |
| 502 | `STREAM_ERROR` | Upstream stream unavailable |
| 501 | `NOT_SUPPORTED_IN_SERVERLESS` | `/stream/*` on Vercel |
