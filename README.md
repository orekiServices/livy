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
native/   MetroS (reframing/transcoding), MetroDB (SQLite), MetroFX (DSP), in Rust
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

Bun 1.1+ (on a phone, see [Termux](#on-a-phone-termux--android)). No
ffmpeg, no Postgres, no build toolchain (a prebuilt MetroS and MetroDB ship in
`native/`; `bun run build:metro` / `build:db` rebuild them when Rust is
installed; MetroFX, the optional native filter kernels, builds in CI and falls
back to JavaScript on hosts that have no binary).

A fresh install has **no stations**. Open the URL and the console walks you
through the first one: choose an owner password → name → sources → crossfade
and beatmatching → on air. The password is hashed with scrypt next to the
database; it is what you type to sign in later.

A node that has no password still works the old way: it generates a key on
first boot, prints it once, and that key is valid until a password is set. If
you want the credential to come from the server instead, set
`OWNER_PASSWORD`; an explicit `OWNER_KEY` is also honoured and remains a
recovery key after a password exists. A fresh, unclaimed node can be claimed by
whoever reaches it first, so set a password (or `OWNER_KEY`) before exposing one
to the internet.

The password is written as a scrypt hash to `owner.auth.json` (mode 0600) next
to the database. Forgot it? Set `OWNER_PASSWORD` and restart, or remove that
file while the node is stopped to fall back to the generated key.

```console
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

### On a phone (Termux / Android)

Livy runs on an Android device through Termux, and the trainer is tuned for it:
Bun's built-in SQLite replaces the Rust addon, the DSP falls back to
JavaScript, and the model shrinks to a 12-unit hidden layer trained 26 epochs
on at most 1,200 recent seams. Training still runs while the station is on air,
just with a smaller budget.

```bash
pkg install git curl unzip glibc-repo && pkg install glibc-runner
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/orekiServices/livy && cd livy
bash livy-termux        # one command: installs JS deps, starts on :2333
```

`./livy` detects Termux and runs the same path. No compiler, no Python, no
root: dependencies are pure JavaScript and the console/listener are already
built into the repo. Data lives in `~/.livy` (override with `LIVY_DATA_DIR`).
Livy runs on **Bun** everywhere; Android's libc is not one Bun is built for,
so on Termux it runs under glibc-runner (`pkg install glibc-repo && pkg
install glibc-runner`, then install Bun) and the script wraps it for you.

What changes on a phone:

| | Server | Termux/Android |
|---|---|---|
| SQLite | MetroDB (Rust) | `bun:sqlite` (built in) |
| DSP | libmetro / MetroFX native | JavaScript fallback (`LIVY_DISABLE_FX=1`) |
| Policies | 2 candidates × up to 120 epochs | 1 candidate × 26 epochs |
| Network | 24→16 | 12 |
| Seams used | 20,000 | 1,200 most recent |
| Poll interval | 60 s | 120 s |
| GPU probe | yes | skipped |

A saved setting still wins: if you set `models.candidates` to 2, the phone
honours it. `GET /api/v1/info` reports the chosen `device` profile.

### Building the UI

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

Owner pages are gated by the owner password (or an explicit owner key); change
it under **Ops → Owner password**. Every row is *action-first*: it has the verb
you would want next to it (play/pause, ban, push, activate, delete), rather than
a read-only table with a form somewhere else.

## Automix, models and training

Every seam is analysed before a sample is mixed: tempo and beat phase, key,
loudness, and vocal density at each end. Ten transitions are scored against that
pair — crossfade, bass-swap, filter, echo, sweep, spin-down, slam, wash, roll,
drop — and the best one wins. Blends run up to 30 s; the heavy DSP runs in Rust
off the event loop.

Three rules were added to make the seam sound intentional rather than
random:

- **Vocals decide the length, not just the curve.** Both ends singing at the
  seam is a clash: the blend contracts to ~70 % so the lines hand over instead
  of overlapping, and a masking transition (filter/echo) outranks a bass-swap
  that would leave both voices exposed.
- **A trick that needs the grid does not run without it.** Roll and drop are
  refused when the tempos did not fold together (5 and 7 BPM of drift), while
  a folded match with a wider raw gap is still allowed — the grid already met.
- **A folded match counts as a match.** Bass-swap is no longer rejected merely
  because the two files' BPM tags differ after a successful ±4 % fold.

A **DJ model** is a tiny learned policy that re-ranks those ten choices. It is
optional, it can only choose from transitions the heuristic already allows, and
a missing or corrupt model falls back to the JS heuristic without stopping the
station.

Defaults are what a radio node actually wants:

| Setting | Default | Why |
|---|---|---|
| `models.autoTrain` | **on** | a new node starts learning from its first seams |
| `models.fast` | **on** | short runs, CPU, tens of milliseconds |
| `models.preset` | `auto` | which architecture to train; `auto` follows the device |
| `models.candidates` | **2** | multi-train: keep the loser, activate the winner |
| `models.pollMs` | `60_000` | check once a minute |
| `models.minSeams` | `40` | first model once there are 40 labelled seams |
| `models.everySeams` | `60` | train once 60 new seams exist |
| `models.hf.private` | **true** | listener behaviour never lands in a public repo |

A rendered transition is noted immediately and written to `dj_seams` (and
`dj-seams.jsonl`) when the incoming track plays out or is skipped. On a node
with no model yet, the first poll trains from the seams already on disk once
`minSeams` is reached — a restart does not throw that history away. With a
model loaded, only `everySeams` **new** seams trigger another run. A custom
`models.saveDir` (`LIVY_MODEL_DIR`) is the first directory the host searches,
so a model trained there is the one automix picks.

### Model presets

The transition set and the model's feature/action columns stay fixed; a preset
only chooses the **architecture and training budget**. Every preset trains the
same policy, so a `wide` model and a `fast` model are interchangeable at a seam
— the registry activates whichever scored better on the same held-out split.

| Preset | Hidden layers | Epochs (fast) | Best for |
|---|---|---|---|
| `auto` | device profile | 26–120 | the default; follows the host |
| `fast` | 12 · 16→12 · 20→14 | 40 | a busy node, a phone, a quick experiment |
| `balanced` | 24→16 · 28→18 · 24→20 | 60 | the server sweet spot |
| `wide` | 48→24 · 64→32 · 48→32 | 70 | broad taste, still cheap per seam |
| `deep` | 32→24→16 · 40→28→16 · 32→24→24→12 | 90 | a node with plenty of seams and CPU |

`auto` is still the phone default: a Termux node keeps its one-candidate,
1,200-seam budget. A named preset may widen the net on a phone, but never the
batch size, the data cap, or the GPU probe. Choose a preset in the console
(**Models → Architecture**), with `PATCH /api/v1/owner/models/settings`, or for
a single run:

```bash
curl -X POST localhost:2333/api/v1/owner/models/train \
  -H 'x-owner-key: …' -H 'content-type: application/json' \
  -d '{"preset":"wide","count":3}'
```

Training runs **while stations are on air**. Seams are written to MetroDB as
they happen (`dj_seams`); the trainer reads them in a transaction, yields
between epochs, writes every candidate to `data/models/`, and activates the
winner only if it beats the incumbent on a chronological held-out split. The
change is picked up at the next seam — no restart, no dropped frame. The run
report says which preset and host produced it (`profile`, `preset`, `host`).

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

### Seams, RL and Forever

Every song a station reads is also heard by a **scout** (`core/seams/`): it
decodes a second at a time off the hot path, tracks the beats, and lets six
detectors say where a seam belongs — the *ending*, a change of *energy*, a
change of section (*novelty*, a Foote checkerboard over timbre and chroma),
the 4- and 8-bar *phrase* grid, the end of a *vocal* line, and a *loop* (a beat
that sounds like an earlier one). Their opinions are fused (agreement outranks
a lone voice) and announced as `seam` events while the song is still
streaming.

**RL** (`core/models/rl.ts`) is one small model for the track change. It sorts
every beat into a kind — `silence`, `sparse`, `groove`, `build`, `drop`,
`break`, `vocal`, `fade` — with centroids fitted to what the station has aired,
and keeps, for each *(kind left, kind entered, transition)*, how often the
listener stayed. Sparse cells back off to what is known more generally, and
untried ones get an exploration bonus, so it is useful from a dozen seams,
where the network needs hundreds. It is refitted on every training run from
the same log (`data/rl-model.json`), and it overrules the other choosers only
with evidence, a clear edge, and a transition the seam can carry.

**Forever** is the [Infinite Jukebox](https://musicmachinery.com/2012/11/12/the-infinite-jukebox/)
as a radio mode: the scout builds the jukebox graph (which beats sound like
which, same position in the bar, the original's weights and threshold sweep),
and when the song has been read the station takes back what has not aired yet
and lets the graph decide what plays. A jump is a real MP3 seam — the song's
own frames up to it, a handful re-encoded across a short cross-fade, the
song's own frames again on the other side — so listeners stay connected. It
ends when the owner turns it off, somebody skips or requests a song, or an
announcement is due; the song then plays out into the automix as usual.

```bash
cd server && curl -s -X POST localhost:2333/api/v1/owner/stations/main/forever -H "x-owner-key: $LIVY_KEY" -H 'content-type: application/json' -d '{"enabled":true}'
cd server && curl -s localhost:2333/api/v1/owner/stations/main/seams -H "x-owner-key: $LIVY_KEY"
```

The all-pairs beat comparison is the one quadratic step; `native/libmetro/src/jukebox.rs`
implements it for a libmetro built from this tree, and the TypeScript kernel
in `core/seams/jukebox.ts` is the reference and the fallback.

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
MetroDB first, `bun:sqlite` as the fallback. Point
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
| `SERVER_PASSWORD` | empty | legacy password for the stream/API surface |
| `OWNER_KEY` | empty | explicit owner credential; survives alongside a password |
| `OWNER_PASSWORD` | empty | owner password, hashed at boot; set it in the environment instead of the console |

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
core/station/seams.js        the scout, RL's advice, Forever mode
core/automix/                analysis, voice, effects, renderers, engine
core/seams/                  features, beats, detectors, categories, jukebox, forever, scout
util/splice.ts               joining re-encoded MP3 to untouched frames (reservoir, delay)
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
cd server && bun test test/seams.test.js   # one file at a time
cd server && LIVY_DISABLE_METRO=1 bun test # the JavaScript engines only
```

344 tests (three transcoder tests skip without a libmetro binary, and three
more run only there).
Sources are stubbed at the transport rather than at the module, so no
suite reaches the network, and the DSP is asserted against synthesised audio.
The model tests cover multi-train, the MetroDB registry, auto-train while on
air, the Android training budget, model presets, and private Hugging Face
push/pull with a fake `fetch`. Source tests cover the NhacCuaTui
detail/playlist/retry paths, and the API test drives a real listener pick onto
a live station.

## Filters

The chain is a fixed order of small DSP objects (`server/src/core/filters/`),
each with the same four-method contract, so a station can stack EQ, compression,
reverb, distortion and the modulation effects without special cases.

| | What it does |
|---|---|
| **Biquad** | transposed direct-form II, RBJ peaking/low/high-pass; 15-band EQ runs one section per band |
| **Moving delay** | Catmull-Rom interpolation, not linear: vibrato, chorus and flanger stay in tune across the fractional samples where their heads actually live |
| **Compressor** | 6 dB soft knee, per-sample attack/release; input `gain` is real drive, `makeupGain` sits after the detector |
| **Distortion** | 4× oversampled waveshaper with a 0.45·fs anti-image low-pass before decimation, so harmonics fold back far less |
| **Reverb** | Freeverb: 8 damped combs + 4 all-passes per channel, stereo spread |

The four per-sample kernels also exist in Rust as **MetroFX**
(`native/metrofx/`, napi-rs). It is optional by design: `server/src/util/fx.js`
loads a binary when one matches the host and otherwise keeps the JavaScript
implementation, so a clone with no toolchain, a phone, or an unsupported libc
still boots. `GET /api/v1/info` reports `fx.engine` — `native` or
`javascript` — and the boot banner says which is running. `LIVY_DISABLE_FX=1`
forces the reference path; the test suite passes both ways.

## API

`GET /api/v1/info` · `GET /api/v1/stations` · `GET /api/v1/lyrics?station=…` ·
`GET /api/v1/search?q=…` · `POST /api/v1/stations/:id/request` ·
`POST /api/v1/track-url` (a direct file for the browser) ·
`POST /api/v1/stations/:id/play` (listener pick → on air) ·
`POST /api/v1/setup/password` (first-run claim) ·
`POST /api/v1/owner/password` (change, owner-gated) ·
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
