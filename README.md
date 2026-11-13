# Livy

**A radio station that fits in one process.**

Livy pulls music from seventeen sources, mixes the seams like a DJ — real
beatmatching, not a fade — and streams each station as one continuous MP3 with
ICY metadata. Its web console is a *plugin of the node, not a second service*,
served from the same port. Switch the plugin off and you have a headless
broadcast API.

Node.js. No ffmpeg. No database server. One command, one process, one URL.

```
server/   the node — sources, automix, filters, REST + ICY
web/      the console — Next.js, exported to static files
native/   MetroS (transcoding) and MetroDB (SQLite), in Rust
api/      the Vercel function entry point
```

## Run it

```bash
cd server
npm install
npm start          # → http://localhost:2333
```

Node 18.17+. No ffmpeg, no Postgres, no build step for the console.

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

`/stream/<id>.mp3` is the only stream address — not `/stream/<id>`, not `.m3u`.
Asked for anything else, the node answers with a spoken 404 rather than silence,
so a mistyped id in a player tells you what is wrong.

The console is committed as static files, so a fresh clone needs no build. You
only need one after changing the UI:

```bash
cd server && npm run build:web
```

## Deploy to Vercel

The repo is Vercel-ready: `vercel.json` installs `server/`, routes every
request to one function, and bundles the sources, plugins, native engine and
the prebuilt console with it.

```bash
npm i -g vercel
vercel            # preview
vercel --prod     # production
```

No dashboard settings are required — no root directory, no framework preset,
no output directory. The console is already committed at
`server/plugins/console/public`, so there is no build step and nothing to
configure.

**What a function can and cannot do.** A Vercel function has no long-lived
socket, so a deployment is a *control plane*, not a station on air:

| | on Vercel |
|---|---|
| Web console, every REST endpoint | ✅ |
| Search, resolve, lyrics, filters, one-shot automix renders | ✅ |
| Station, queue and plugin management | ✅ per instance |
| Continuous ICY streaming | ❌ no long-lived connection |
| WebSocket events | ❌ `/api/v1/events` answers 501 and says why |
| Persistence | ⚠️ `/tmp`, per instance — treat it as ephemeral |

For a station that actually stays on air, run the node on a VM or a container
instead — `npm start` in `server/`, with `server/data/` on a real volume.

One environment switch matters in either case:

| Variable | Default | |
|---|---|---|
| `LIVY_DATA_DIR` | `server/data`, or `/tmp/livy` on Vercel | where the SQLite file lives — on Vercel, point it at a mounted volume to persist |
| `PORT` | `2333` | listen port |

## What is in the box

| | |
|---|---|
| **Stations** | many per process, each with its own queue, rotation, requests, automix and listeners |
| **Audio path** | MP3 in → MP3 out, byte for byte, no ffmpeg. Anything else is decoded and re-encoded by MetroS at 70–145× realtime |
| **Sources** | 17 providers — soundcloud · audius · bandcamp · ccmixter · **nhaccuatui** · archive.org · deezer · radio paradise (FLAC) · somafm · podcast/RSS · vimeo · youtube music · mirror · song.link · radio-browser · http/icecast/HLS · local, plus TTS for idents |
| **Automix** | loudness-matched, cue-trimmed, beatmatched seams; ten transitions chosen per seam; blends up to 30 s |
| **DJ** | optional voice-tracking over the seam with a real sidechain duck |
| **Console** | phone-first, shipped as a plugin — stations, now playing with **word-synced lyrics** over a Kawarp-warped cover, and a studio with a draggable queue |
| **Lyrics** | fetched **by the node**, never by the listener's browser, rendered with `<am-lyrics>` |
| **Memory** | a station comes back mid-song after a restart, out of SQLite |
| **Plugins** | drop-in `plugins/` folder — sources, transitions, routes and hooks, switchable per node or per station |

## Sources

`server/src/sources/` is a small registry. Each provider implements
`canResolve(query)`, `resolve(query)` and `stream(track)`; the registry adds
what one provider cannot know — parallel search and ranking, hi-res re-cloning,
and a fallback chain so a dead link never silences a station.

```
scsearch:  adsearch:  bcsearch:  ccsearch:  nctsearch:  iasearch:  dzsearch:
```

| Source | Notes |
|---|---|
| **soundcloud** (primary) | `client_id` scraped from its own bundle, auto-refreshed on 401/403. `progressive` MP3, 128 kbps |
| **audius** (hi-res) | Artist-owned catalogue, **320 kbps MP3**, no key. Discovery nodes rotated mid-request on failure |
| **archive** (hi-res) | Real MP3 files, frequently 192–320 kbps, biased away from talk |
| **bandcamp** | Full-length `mp3-128` from the page's `tralbum` blob; search via its autocomplete API |
| **ccmixter** (hi-res) | Creative Commons remixes, ~192 kbps VBR |
| **nhaccuatui** | Vietnam's largest catalogue: `graph.nct.vn/api/v1`, anonymous 128 kbps MP3, resolved per play because the CDN links expire |
| **radioparadise** (lossless) | **FLAC** blocks with the running order attached |
| **deezer** / **mirror** / **songlink** | Metadata only — an unplayable link is matched to a source that *can* play it |

## How the mixing works

Every seam is analysed before a sample is mixed: tempo and beat phase, key,
loudness, and the vocal density at each end. Ten transitions are scored against
that pair — crossfade, bass-swap, filter, echo, sweep, spin-down, slam, wash,
roll, drop — and the best one wins. Blends run up to 30 s, and the heavy DSP runs in Rust off the
event loop.

Before the seam, the outgoing track is trimmed to a beat and the incoming one
trimmed into its first beat, so the blend lands on the grid rather than
wherever the previous song happened to end.

## Tests

```bash
cd server
npm test             # node
bun test             # bun
```

268 tests. Sources are stubbed at the transport rather than at the module, so no
suite reaches the network, and the DSP is asserted against synthesised audio.

## API

`GET /api/v1/info` · `GET /api/v1/stations` · `GET /api/v1/lyrics?station=…` ·
`GET /api/v1/search?q=…` · `POST /api/v1/stations/:id/request` ·
`GET /api/v1/events` (WebSocket) · `GET /stream/<id>.mp3` (ICY) ·
`GET /health`

`/api/v1/info` is worth reading first: it reports version, sources, and what
this particular deployment can actually do — streaming, sockets, persistence —
so a client finds out before it builds on a capability that is not there.
The console is the reference for everything else.

## Notes

Livy is a rebrand of Nodecast and adopts an existing install in place — it
looks for `nodecast.db` (then `radio.db`) next to `livy.db` and moves it over,
stations and settings included.

It is not affiliated with any of the services it reads from, ships no music,
and is meant for personal use against sources you are entitled to stream.
