# 🎵 Livy

**Livy** is a Discord music bot powered by **[NodeLink](https://github.com/PerformanC/NodeLink)** —
PerformanC's performant Lavalink alternative written in Node.js.

> **Rebrand:** Livy was formerly **NodeCast**. The codebase has been rebuilt
> from scratch (the original NodeCast sources were unavailable in the build
> environment), with NodeLink integration researched and fixed properly.
> Everything user-facing now says *Livy*; nothing references NodeCast except
> this note.

## How it works

```
Discord ──slash/prefix commands──▶ Livy (discord.js + FastLink)
                                        │  Lavalink v4 API (HTTP + WebSocket)
                                        ▼
                                   NodeLink ──▶ Discord voice
```

- **NodeLink** is the audio server: track resolution (YouTube, SoundCloud,
  Spotify, Deezer, …), decoding, filters, and Discord voice transport.
- **FastLink** (`@performanc/fastlink`) is PerformanC's official Node.js
  Lavalink/NodeLink client — Livy uses it as the transport layer.
- **Livy** owns everything Discord-facing: commands, queue, embeds,
  voice-channel lifecycle.

## Requirements

- Node.js **20+** (NodeLink itself needs Node 22+)
- A Discord bot token (Developer Portal → Bot → *Message Content Intent* on)
- A running **NodeLink** node (or Lavalink v4 — Livy detects which it is)

## Quick start

```bash
npm install
cp .env.example .env   # fill in DISCORD_TOKEN
npm start
```

### Running NodeLink

NodeLink defaults: **port `3000`**, password **`youshallnotpass`**
(note: `2333` is the *Lavalink* default — a classic misconfiguration).

```bash
git clone https://github.com/PerformanC/NodeLink.git
cd NodeLink
npm install
cp config.default.ts config.ts   # set server.password / server.port
npm run start
```

Or with Docker (bot + NodeLink together):

```bash
cp .env.example .env   # set DISCORD_TOKEN
docker compose up --build
```

## Configuration

See [`.env.example`](.env.example). Highlights:

| Variable | Default | Notes |
|---|---|---|
| `DISCORD_TOKEN` | — | **Required.** |
| `NODELINK_HOST` / `NODELINK_PORT` / `NODELINK_PASSWORD` | `127.0.0.1` / `3000` / `youshallnotpass` | Single-node config. |
| `NODELINK_NODES` | — | Multi-node: `id,host,port,password,secure;…` |
| `DEFAULT_SEARCH_SOURCE` | `ytsearch:` | `scsearch:`, `spsearch:`, `dzsearch:`, … |
| `MAX_PLAYLIST_LENGTH` | `100` | Cap per playlist enqueue. |
| `EMPTY_LEAVE_SECONDS` | `60` | Auto-leave empty voice channels (`0` = never). |
| `COMMANDS_GUILD_ID` | — | Instant guild-only slash registration (dev). |

## Commands

Slash commands (`/play …`) and prefix commands (`!play …`) both work.

| Command | Description |
|---|---|
| `/play <query>` | Play a URL or search query (playlists enqueue all tracks) |
| `/pause` · `/resume` | Pause / resume |
| `/skip` | Skip current track |
| `/stop` | Stop + clear queue (stays in channel) |
| `/leave` | Stop + leave voice channel |
| `/queue [page]` | Show queue with now-playing |
| `/nowplaying` | Current track + progress bar |
| `/volume <0–200>` | Set volume |
| `/loop <off\|track\|queue>` | Loop mode |
| `/shuffle` | Shuffle upcoming tracks |
| `/seek <1:30\|90s\|2m>` | Seek within track |
| `/lyrics` | Lyrics via NodeLink `/v4/loadlyrics` |
| `/filter <preset>` | `bassboost`, `nightcore`, `vaporwave`, `8d`, `lofi`, `karaoke`, … |
| `/stats` | NodeLink node status (`/v4/info` + `/v4/stats`) |
| `/ping` · `/help` | Health check · command list |

Search prefixes follow NodeLink: `ytsearch:`, `ytmsearch:`, `scsearch:`,
`spsearch:`, `dzsearch:`, `bcsearch:`, … — or just pass a URL.

## Architecture

```
src/
  index.js               entry point, graceful shutdown
  config.js              env parsing (incl. multi-node NODELINK_NODES)
  client.js              discord.js client + FastLink wiring
  fastlink-compat.js     FastLink v2/v3 shim + upstream-bug workarounds
  managers/
    PlayerManager.js     per-guild playback lifecycle
    QueueManager.js      Livy-owned queue (metadata + loop/shuffle)
    LyricsManager.js     NodeLink lyrics with cache
    FilterManager.js     Lavalink v4 filter presets
  commands/              slash + prefix commands
  events/                interaction, message, voice-state, ready
  utils/                 embeds, formatting, search, permissions, logger
test/                    node:test unit tests (npm test)
```

**Why does Livy own the queue?** FastLink's built-in queue stores only
encoded strings (no titles/requesters) and its loop handling is buggy in
`2.4.1` (`loop=track` replays the *next* track; `loop=queue` duplicates
the wrong entry). Livy runs FastLink with `queue: false` and manages
queueing itself, using FastLink purely as the NodeLink transport.

## What was fixed vs. the original NodeCast

Researched against [NodeLink](https://github.com/PerformanC/NodeLink),
[FastLink](https://github.com/PerformanC/FastLink), and the
[NodeLink API docs](https://nodelink.js.org/docs/api):

1. **Wrong default port** — NodeCast-era code used Lavalink's `2333`;
   NodeLink defaults to `3000`. Now configurable, defaults to `3000`.
2. **FastLink API drift** — README examples use `playerCreated()` /
   `createPlayer()` / `FastLink.other.handleRaw`, but FastLink v3 changed
   all three (`isCreated`, `createPlayer(node)`, `FastLink.handleRaw`).
   A compat shim (`src/fastlink-compat.js`) supports both.
3. **`player.disconnect()` throws** upstream (forwards `null` into
   `connect()`, which rejects it). Livy sends the voice-disconnect
   payload directly.
4. **Dead `loadType === 'short'` branch** (copied from an outdated
   README) — replaced with correct Lavalink v4 load types.
5. **Playlists via `tracks.encodeds`** — a FastLink-v2-only extension
   that breaks on v3/NodeLink. Livy enqueues each track client-side.
6. **Hanging `loadTrack()`** — FastLink never rejects on HTTP errors,
   so requests now have timeouts.
7. **No queue metadata** — queue now tracks title, requester, duration.
8. **No voice hygiene** — added same-channel checks, empty-channel
   auto-leave, external disconnect/move handling.
9. **Hard-coded token/prefix** — everything is env-configured.
10. **Prefix-only commands** — full slash commands + prefix fallback.

## Development

```bash
npm test     # unit tests (queue, formatting, search, filters, config)
npm run dev  # node --watch
```

## License

MIT. NodeLink is GPL-3.0 and FastLink is BSD-3-Clause — see their repos.
