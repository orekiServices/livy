# Livy

**A radio station that fits in one process.**

Livy pulls music from seventeen sources, mixes the seams like a DJ — real
beatmatching, not a fade — and streams each station as one continuous MP3 with
ICY metadata. Two web front ends ship in the same process: **`/listen`**, a minimalist
player that shows what is on air and lets anyone play a song, and **`/owner`**,
the control room. Both are *plugins of the node, not a second service*, served
from the same port. Switch the plugin off and you have a headless broadcast
API.

Bun + Rust. No ffmpeg, no database server, no external mixer.

```
server/   the node — sources, automix, filters, REST + ICY
web/      the owner console — Next.js, exported to static files
client/   the listener player — created with create-next-app, exported to /listen
native/   MetroS (reframing/transcoding) and MetroDB (SQLite), in Rust
api/      the Vercel function entry point
docs/     research notes, including Apple Music AutoMix
```

## Run it

One command, from a fresh clone:

```bash
./livy
```

It installs dependencies, builds **both** web apps into
`server/plugins/console/public` (console at `/`, listener at `/listen/`), and
starts the node on <http://localhost:2333>. Equivalent one-liner:

```bash
cd server && bun install && bun run build:web && bun start
```

Bun 1.1+. No ffmpeg, no Postgres, no build toolchain (a prebuilt MetroS and
MetroDB ship in `native/`; `bun run build:metro` / `build:db` rebuild them when
Rust is installed).

A fresh install has **no stations**. Open the URL and the console walks you
through the first one: owner key → name → sources → crossfade and beatmatching
→ on air. The owner key is generated on first boot and printed once.

```console
INFO  livy         | owner key generated: X7G82Ma6kUqpx1DxNWO59Q  (saved next to the database — keep it)
INFO  livy         | listening on http://0.0.0.0:2333  ·  0 station(s)
```

Then point anything at the stream, using the id your station got:

```bash
mpv http://localhost:2333/stream/night-drive-fm.mp3
```

Listen at <http://localhost:2333/listen/>, manage at
<http://localhost:2333/owner/>, and point any player at
`/stream/<id>.mp3` — the only stream address. Asked for anything else, the node
answers with a spoken 404 rather than silence.

The console is committed as static files, so a fresh clone needs no build. After
changing the UI:

```bash
bun run build:web
```

## Listening — `/listen`

The listener app is one screen: the record that is playing, a station switcher,
and a search field. It is built like a YouTube Music client rather than a radio
directory.

- **Now playing only.** Artwork drives the whole palette; title, artist, a live
  progress line, and the two things you can do: play/pause, or pick a song.
- **Search → play.** Type anything; results come from all 17 sources in
  parallel. Tapping one asks the node for a direct file (`/api/v1/track-url`)
  and plays it in the browser — scrubbable, no station interruption.
- **Fallback to the station.** If a provider has no direct file (metadata-only
  services, DRM, a live relay), the client asks the station to put the song on
  air next (`POST /api/v1/stations/:id/play`) and plays the live stream.
- **Per station.** The chosen station is remembered, each station has its own
  listener count and on-air state, and “Manage stations” goes to `/owner/`.
- **Mobile first.** The bottom player bar, safe-area padding and a single
  column on a phone are the primary layout, not an afterthought.

The app lives in `client/`, scaffolded with
`bunx create-next-app@latest client --js --app` and exported with
`basePath: '/listen'`. The owner console remains the place to create and
programme stations.

## The console

Everything a station needs is on one owner page, arranged like a control room:

| Area | What you can do |
|---|---|
| **On air** | start · stop · skip · shuffle · reload queue · clear queue · speak an announcement |
| **Vitals** | listeners, queue depth, buffer ahead, track progress, model accuracy, auto-train state |
| **Quick actions** | train a model, vacuum the store, backup, open the request line, drop a live relay |
| **Desk cards** | now playing, next up, requests and bans, programme metadata, recent seams |
| **Dock (10 views)** | stations · queue · requests · seams · models · automix · filters · plugins · ops · logs |

Owner pages are gated by the owner key and are *action-first*: every row has the
verb you would want next to it (play/pause, ban, push, activate, delete), rather
than a read-only table with a form somewhere else.

## Automix, models and training

Every seam is analysed before a sample is mixed: tempo and beat phase, key,
loudness, and vocal density at each end. Ten transitions are scored against that
pair — crossfade, bass-swap, filter, echo, sweep, spin-down, slam, wash, roll,
drop — and the best one wins. Blends run up to 30 s; the heavy DSP runs in Rust
off the event loop.

A **DJ model** is a tiny learned policy that re-ranks those ten choices. It is
optional, it can only choose from transitions the heuristic already allows, and
a missing or corrupt model falls back to the JS heuristic without stopping the
station.

Defaults are what a radio node actually wants:

| Setting | Default | Why |
|---|---|---|
| `models.autoTrain` | **on** | a new node starts learning from its first seams |
| `models.fast` | **on** | small nets, CPU, tens of milliseconds |
| `models.candidates` | **2** | multi-train: keep the loser, activate the winner |
| `models.pollMs` | `60_000` | check once a minute |
| `models.everySeams` | `60` | train once 60 new seams exist |
| `models.hf.private` | **true** | listener behaviour never lands in a public repo |

Training runs **while stations are on air**. Seams are written to MetroDB as
they happen (`dj_seams`); the trainer reads them in a transaction, yields
between epochs, writes every candidate to `data/models/`, and activates the
winner only if it beats the incumbent on a chronological held-out split. The
change is picked up at the next seam — no restart, no dropped frame.

```bash
bun run start                                   # training is already on
curl -X POST localhost:2333/api/v1/owner/models/train -H 'x-owner-key: …'
curl -X POST localhost:2333/api/v1/owner/models/push  -H 'x-owner-key: …'
```

The console exposes all of it: train (1 or 3 candidates), per-station
auto-train, fast mode, candidate list with activate/push/delete, and a Hugging
Face repo form.

### Private models on Hugging Face

Set a token and a repo; the node creates the repo **private** and refuses to
push to a public one:

```bash
export HF_TOKEN=hf_…            # or LIVY_HF_TOKEN
export LIVY_HF_REPO=you/livy-models
bun run start
```

The token stays in the node's environment. It is never returned by the API and
never written to the database. Inference is local: a dead network never
silences a station.

### Where the research is

`docs/automix-research.md` summarises Apple Music AutoMix (on by default,
beatmatch + time-stretch, and the criticism of over-aggressive stretching) and
the open-source field ([clawd139/automix](https://github.com/clawd139/automix),
[BeatBridge](https://github.com/WalterByte-afk/BeatBridge),
[mini-dj-automix](https://github.com/kingmitten/mini-dj-automix),
[redmix](https://github.com/vedantexists/redmix)) — and what Livy adopted versus
rejected.

## Persistence

**MetroDB is the store.** It is SQLite-compatible, embedded, written in Rust,
and speaks the same SQL a Postgres client would; there is no database server to
run and no network hop on the seam path. Stations, queues, seams, training runs,
models and settings all live there, so a backup is one file:

```bash
curl -X POST localhost:2333/api/v1/owner/store/backup -H 'x-owner-key: …'
```

An earlier note in the project said "migrate to PSQL". That would add a server
and a driver for no capability the node needs, so the store stayed embedded:
MetroDB first, `better-sqlite3` or `bun:sqlite` as fallbacks. Point
`LIVY_DATA_DIR` at a real volume to persist it.

## Deploy to Vercel

The repo is Vercel-ready: `vercel.json` installs `server/`, routes every
request to one function, and bundles the sources, plugins, native engine and
the prebuilt console with it.

```bash
bunx vercel            # preview
bunx vercel --prod     # production
```

No dashboard settings are required. **What a function can and cannot do:**

| | on Vercel |
|---|---|
| Web console, every REST endpoint | ✅ |
| Search, resolve, lyrics, filters, one-shot automix renders | ✅ |
| Station, queue and plugin management | ✅ per instance |
| Continuous ICY streaming | ❌ no long-lived connection |
| WebSocket events | ❌ `/api/v1/events` answers 501 and says why |
| Persistence | ⚠️ `/tmp`, per instance — treat it as ephemeral |

For a station that stays on air, run the node on a VM or container with
`server/data/` on a real volume.

| Variable | Default | |
|---|---|---|
| `LIVY_DATA_DIR` | `server/data`, or `/tmp/livy` on Vercel | where the SQLite file lives |
| `LIVY_MODEL_DIR` | `$LIVY_DATA_DIR/models` | where trained models live |
| `LIVY_HF_REPO` / `HF_TOKEN` | empty | private Hugging Face model storage |
| `PORT` | `2333` | listen port |
| `SERVER_PASSWORD` | empty | password for the stream/API surface |

## What is in the box

| | |
|---|---|
| **Stations** | many per process, each with its own queue, rotation, requests, automix and listeners |
| **Audio path** | MP3 in → MP3 out, byte for byte, no ffmpeg. Anything else is decoded and re-encoded by MetroS at 70–145× realtime |
| **Sources** | 17 providers — soundcloud · audius · bandcamp · ccmixter · **nhaccuatui** · archive.org · deezer · radio paradise (FLAC) · somafm · podcast/RSS · vimeo · youtube music · mirror · song.link · radio-browser · http/icecast/HLS · local, plus TTS for idents |
| **Automix** | loudness-matched, cue-trimmed, beatmatched seams; ten transitions chosen per seam; blends up to 30 s |
| **DJ** | optional voice-tracking over the seam with a real sidechain duck |
| **Console** | phone-first, shipped as a plugin — control room, stations, now playing with **word-synced lyrics**, a studio with a draggable queue, and a ten-view owner dock |
| **Lyrics** | fetched **by the node**, never by the listener's browser, rendered with `<am-lyrics>` |
| **Memory** | a station comes back mid-song after a restart, out of MetroDB |
| **Plugins** | drop-in `plugins/` folder — sources, transitions, routes and hooks, switchable per node or per station |

## Layout of the core

Large files were split so a reader can hold one idea at a time:

```
core/station.js              lifecycle, fields, getters (~300 lines)
core/station/queue.js        rotation, skips, seam logging
core/station/requests.js     the request line and votes
core/station/playback.js     reader, filters, track reader
core/station/relay.js        listeners and live relays
core/station/info.js         announcements and the public view
core/automix/                analysis, voice, effects, renderers, engine
core/models/                 format, train, registry, hub (HF), auto, settings
server/owner/                index, plugins, system, models routes
```

## Sources

`server/src/sources/` is a small registry. Each provider implements
`canResolve(query)`, `resolve(query)` and `stream(track)`; the registry adds
what one provider cannot know — parallel search and ranking, hi-res re-cloning,
and a fallback chain so a dead link never silences a station.

| Source | Notes |
|---|---|
| **soundcloud** (primary) | `client_id` scraped from its own bundle, auto-refreshed on 401/403. `progressive` MP3, 128 kbps |
| **audius** (hi-res) | Artist-owned catalogue, **320 kbps MP3**, no key. Discovery nodes rotated mid-request on failure |
| **archive** (hi-res) | Real MP3 files, frequently 192–320 kbps, biased away from talk |
| **bandcamp** | Full-length `mp3-128` from the page's `tralbum` blob; search via its autocomplete API |
| **ccmixter** (hi-res) | Creative Commons remixes, ~192 kbps VBR |
| **nhaccuatui** | Vietnam's largest catalogue: `graph.nct.vn/api/v1`, anonymous 128 kbps MP3. Stream URLs are resolved per play (they expire), search rows without a stream are completed from song detail, playlists resolve missing rows, and a 403 retries once with a fresh signature |
| **radioparadise** (lossless) | **FLAC** blocks with the running order attached |
| **deezer** / **mirror** / **songlink** | Metadata only — an unplayable link is matched to a source that *can* play it |

## Tests

```bash
bun test                    # from server/
bun run test                # from the repo root
bun run test:node           # node --test, for a Node-only host
```

283 tests. Sources are stubbed at the transport rather than at the module, so no
suite reaches the network, and the DSP is asserted against synthesised audio.
The model tests cover multi-train, the MetroDB registry, auto-train while on
air, and private Hugging Face push/pull with a fake `fetch`. Source tests cover
the NhacCuaTui detail/playlist/retry paths, and the API test drives a real
listener pick onto a live station.

## API

`GET /api/v1/info` · `GET /api/v1/stations` · `GET /api/v1/lyrics?station=…` ·
`GET /api/v1/search?q=…` · `POST /api/v1/stations/:id/request` ·
`POST /api/v1/track-url` (a direct file for the browser) ·
`POST /api/v1/stations/:id/play` (listener pick → on air) ·
`GET /api/v1/events` (WebSocket) · `GET /stream/<id>.mp3` (ICY) ·
`GET /health` · `/listen/` · `/owner/`

`/api/v1/info` is worth reading first: it reports version, sources, models,
auto-train state, and what this particular deployment can actually do —
streaming, sockets, persistence — so a client finds out before it builds on a
capability that is not there.

## Notes

Livy is a rebrand of Nodecast and adopts an existing install in place — it
looks for `nodecast.db` (then `radio.db`) next to `livy.db` and moves it over,
stations and settings included.

It is not affiliated with any of the services it reads from, ships no music,
and is meant for personal use against sources you are entitled to stream.
