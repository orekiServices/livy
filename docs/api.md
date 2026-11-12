# API reference

Base URL: `http://localhost:2333`. All `/api/v1` routes require
`Authorization: Bearer <API_KEY>` when `API_KEY` is set.

Errors are JSON: `{ "error": "<CODE>", "message": "…", "details"?: … }`.

## Health & info

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness probe → `{ ok: true, ts }` |
| GET | `/ready` | Readiness probe (checks database) |
| GET | `/metrics` | Prometheus metrics (text exposition) |
| GET | `/api/v1/info` | Server info: version, native addon, database, uptime, sources |
| GET | `/api/v1/config` | Public (redacted) configuration |
| GET | `/api/v1/db/status` | Database adapter status + health |

## Sources & track resolution (NodeLink-style)

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/sources` | List registered sources (priority, health) |
| GET | `/api/v1/sources/health` | Run health probes for all sources |
| GET | `/api/v1/loadtracks?identifier=` | Resolve a URL or `source:query` into tracks |
| GET | `/api/v1/trackstream?encoded=` | Direct stream URL for an encoded track |

Identifiers route by `source:` prefix (`hls:`, `local:`, `m3u:`, `icecast:`)
or by URL pattern. `loadtracks` returns Lavalink-compatible
`{ loadType, data: { tracks: [{ encoded, info, pluginInfo }] } }` where
`encoded` is an opaque base64 track string.

```bash
curl "localhost:2333/api/v1/loadtracks?identifier=https://example.com/live.m3u8"
curl "localhost:2333/api/v1/loadtracks?identifier=local:/music/song.mp3"
```

## HLS

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/stations/:id/hls` | Rewritten media playlist (segments proxied) |
| GET | `/api/v1/hls/segment?url=` | Proxy one HLS segment (AES-128 aware) |

## Stations

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/stations?page=&pageSize=&search=` | List stations (paginated) |
| POST | `/api/v1/stations` | Create station |
| GET | `/api/v1/stations/:id` | Get station |
| PATCH | `/api/v1/stations/:id` | Update station |
| DELETE | `/api/v1/stations/:id` | Delete station (cascades) |
| GET | `/api/v1/stations/:id/export` | Export station as JSON |
| POST | `/api/v1/stations/import` | Import station from JSON |

Create station body:

```json
{
  "name": "Lo-Fi Beats",
  "slug": "lo-fi-beats",
  "description": "Chill beats 24/7",
  "streamUrl": "https://example.com/lofi.mp3",
  "fallbackUrls": ["https://backup.example.com/lofi.mp3"],
  "coverUrl": "https://example.com/cover.png",
  "tags": ["chill", "beats"],
  "isPublic": true
}
```

`streamUrl` and each `fallbackUrls` entry are mirrored into stream sources
with priorities `1`, `10`, `11`, … for automatic failover.

## Stream sources

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/stations/:id/streams` | List sources (priority order) |
| POST | `/api/v1/stations/:id/streams` | Add source |
| PATCH | `/api/v1/stations/:id/streams/:streamId` | Update source |
| DELETE | `/api/v1/stations/:id/streams/:streamId` | Delete source |

Source body: `{ name, url, protocol?, codec?, priority?, enabled? }` where
`protocol ∈ http|https|hls|icecast|shoutcast` and
`codec ∈ mp3|aac|flac|opus|vorbis|unknown`. Lower `priority` wins.

## Playlists

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/stations/:id/playlists` | List playlists |
| POST | `/api/v1/stations/:id/playlists` | Create playlist |
| DELETE | `/api/v1/stations/:id/playlists/:playlistId` | Delete playlist |

Playlist body: `{ name, entries?: [{ url, title?, duration? }] }`.

## Playback & streaming

| Method | Path | Description |
|---|---|---|
| POST | `/api/v1/stations/:id/play` | Start a listener session → `{ id, … }` |
| GET | `/api/v1/stations/:id/stream?session=<id>` | Stream audio (proxy) |
| GET | `/api/v1/stations/:id/status` | Listener count, active source, now playing |
| POST | `/api/v1/stations/:id/stop` | Stop all sessions for the station |
| GET | `/api/v1/stations/sessions?stationId=` | List sessions |
| DELETE | `/api/v1/stations/sessions/:sessionId` | Stop one session |

Example:

```bash
SESSION=$(curl -s -X POST localhost:2333/api/v1/stations/<id>/play | jq -r .id)
curl "localhost:2333/api/v1/stations/<id>/stream?session=$SESSION" -o out.mp3
```

## TypeScript client example

```ts
import { createApp } from "livy/server"; // or plain fetch against the HTTP API

const res = await fetch("http://localhost:2333/api/v1/stations", {
	method: "POST",
	headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
	body: JSON.stringify({ name: "Jazz FM", streamUrl: "https://example.com/jazz.mp3" }),
});
const station = await res.json();
```
