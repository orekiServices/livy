# Nodecast 📻

**NodeJS + ICEcast.** A single small Node process that runs as many radio stations as you like, pulls
music from fifteen sources (SoundCloud first), mixes the seams like a DJ — real beatmatching, not a
fade — and streams each station as one continuous MP3 with ICY metadata. Feeds that are not MP3 —
AAC, HLS, Ogg, FLAC — are transcoded on the way in by **MetroS**, its Rust engine.

The web console is a **plugin of the node, not a second service**: it is exported to static files, owned
by `plugins/console/` and served from the same port. Switch that plugin off and you have a headless
broadcast API. One command, one process, one URL.

```bash
cd server
npm install
npm run build:web     # builds the console into server/plugins/console/public (once, or after UI changes)
npm start             # → http://localhost:2333
```

A fresh install has **no stations**. Open the URL and the console walks you through creating the first
one: owner key → name → sources → crossfade, transition and beatmatching → on air. The owner key is
generated on first boot and printed in the log:

```
INFO  [nodecast] owner key generated: Nznc9u54VY2YWYjDPNXoww  (saved next to the database — keep it)
INFO  [nodecast] listening on http://0.0.0.0:2333  ·  0 station(s)
INFO  [nodecast] first run: open http://0.0.0.0:2333/ and create your first station
```

Then point anything at the stream:

```bash
mpv http://localhost:2333/stream/night-drive-fm.mp3
curl -s -H 'Icy-MetaData: 1' -D - http://localhost:2333/stream/night-drive-fm.mp3 -o /dev/null | grep -i icy
```

## What is in the box

| | |
|---|---|
| **Stations** | many per process, each with its own queue, rotation, requests, automix and listeners |
| **Audio path** | MP3 in → MP3 out, byte for byte, no ffmpeg. Anything else is decoded and re-encoded by MetroS at 70–150x realtime. |
| **Sources** | soundcloud · audius · bandcamp · ccmixter · archive.org · deezer · radio paradise (FLAC) · somafm · podcast/RSS · vimeo · **youtube music** · mirror (Spotify/Apple/YouTube links) · radio-browser · http/icecast/HLS · local (mp3 · flac · m4a · ogg · wav…) · tts |
| **Automix** | loudness-matched, cue-trimmed, **beatmatched** seams, **ten transitions chosen per seam**, blends up to 30 s, and the heavy DSP in Rust off the event loop |
| **DJ** | optional voice-tracking over the seam with a real sidechain duck |
| **Request line** | request, upvote, vote-skip, per-listener limits, bans — all persisted in SQLite |
| **Console** | a phone-first Next.js app, shipped as the `console` plugin and served by the node itself — stations, now playing with **word-synced lyrics**, and a studio with a draggable queue |
| **Lyrics** | Apple-Music-style word-synced lyrics, fetched **by the node** (never by the listener's browser) and rendered with `<am-lyrics>` |
| **Voice** | two speech services — Google Translate and [Flowery](https://flowery.pw) (2,000 voices, 254 languages) — sharing one language and pace |
| **Memory** | a station comes back mid-song after a restart, with its queue, out of the same SQLite file |
| **Smart queue** | autoplay that follows what the station has been playing, so the rotation never simply stops |
| **MetroS** | the relay engine: frame scanning, live re-framing, **decoding and transcoding** — AAC, HLS/MPEG-TS, Ogg, FLAC, MP4 → MP3 — as an optional Rust addon (`libmetro`) with a JavaScript fallback for the MP3 path |
| **Plugins** | drop-in `plugins/` folder — sources, transitions, routes and event hooks, switchable at runtime **per node or per station**, with **self-describing settings** the console renders as a form |
| **Storage** | one migrated SQLite file for everything; `npm run db` for info, backups and vacuum |
| **Logging** | levelled, scoped, colourised, redacted, ring-buffered and readable from the console |
| **Dependencies** | `ws`, `@breezystack/lamejs`, `mpg123-decoder` — plus two optional Rust addons of our own: **libmetro** (audio) and **MetroDB** (SQLite, replacing `better-sqlite3`) |

## Why it's fast

| Decision | Effect |
|---|---|
| **MP3 passthrough** | SoundCloud's `progressive` transcoding *is* a 128 kbps MP3. We parse 4-byte frame headers and forward the original bytes — no decode, no encode, no ffmpeg process. |
| **One pacer per station** | A 40 ms timer emits frames whose playback time has arrived. CPU per station is roughly constant; listeners only cost a `write()`. |
| **Reader runs ~15 s ahead** | Network jitter and track changes are absorbed by the buffer, so switching tracks is gapless. |
| **Burst on join** | New listeners get the last ~4 s of frames instantly, so players start immediately instead of buffering. |
| **Slow-consumer eviction** | A stalled listener is dropped at 1.5 MB of backlog and can never stall the station. |
| **Static console** | The UI is HTML and JS on disk. No Next.js runtime, no SSR, no second process, no proxy hop. |
| **MetroS** | The re-framer is native (Rust, napi-rs) when a `libmetro` binary is present: relays hand the pacer contiguous blocks instead of ~2,300 objects a minute, and the one decode there is runs off the event loop. Missing binary → same behaviour in JavaScript, a little slower. |

## First run

`/api/v1/setup` is what the console asks before it renders anything:

```jsonc
{
  "configured": false,          // no stations exist yet
  "stations": 0,
  "protected": true,            // an owner key is required
  "owner": false,               // this caller has not proved it yet
  "sources": [ { "name": "soundcloud", "prefixes": ["scsearch:", "sc:"] }, … ],
  "defaults": { "crossfadeMs": 6000, "effect": "crossfade", "beatmatch": true, "dj": true }
}
```

The wizard posts one request when you finish:

```bash
curl -X POST localhost:2333/api/v1/owner/stations \
  -H "x-owner-key: $(cat server/data/owner.key)" -H 'content-type: application/json' -d '{
    "name": "Night Drive FM", "genre": "Chill & Lofi",
    "playlists": ["scsearch:lofi house mix"],
    "allowRequests": true,
    "automix": { "crossfadeMs": 6000, "effect": "bass-swap", "beatmatch": true, "maxStretchPercent": 12,
                 "dj": { "enabled": true, "name": "Ava", "every": 3 } }
  }'
```

Stations created this way live in SQLite and come back after a restart. Prefer files? Copy
`config.example.json` to `config.json` and fill in `stations: []` yourself — both work, and the wizard
is available later from the owner console as **Guided setup**.

## Sources

`server/src/sources/` is a tiny registry; each provider implements `canResolve(query)`, `resolve(query)`
and `stream(track)`. Written from scratch — NodeLink's *architecture* was the inspiration, none of its
code. A provider may hand back a stream, a URL or an HLS playlist, and say whether it needs decoding;
the station and MetroS take it from there.

| Source | Accepts | Notes |
|---|---|---|
| **soundcloud** (primary) | `scsearch:<terms>`, `sc:`, any soundcloud.com track/set/user URL, bare text | `client_id` scraped from SoundCloud's own asset bundle, auto-refreshed on 401/403. Prefers the `progressive` MP3; falls back to concatenating HLS MP3 segments. 128 kbps. |
| **audius** (hi-res) | `adsearch:<terms>`, `audius:trending:<genre>`, audius.co URLs | Artist-owned catalogue, **320 kbps MP3**, no key. Only `is_streamable` tracks. |
| **archive** (hi-res) | `iasearch:<terms>`, `ia:<identifier>`, archive.org URLs | Real MP3 files, frequently 192–320 kbps VBR. Filtered to `.mp3` and biased away from talk/audiobook collections. |
| **bandcamp** | `bcsearch:<terms>`, `<artist>.bandcamp.com/track|album/…` | Full-length `mp3-128` streams from the page's `data-tralbum` blob. |
| **ccmixter** (hi-res) | `ccsearch:<terms>`, ccmixter.org file URLs | Creative Commons remixes, mostly VBR ~192 kbps — a good clone target. |
| **somafm** | `soma:groovesalad`, `somafm:<channel>`, somafm.com URLs | 24/7 curated channels; the highest-quality MP3 playlist is parsed out of the `.pls`. |
| **podcast** | `pcsearch:<terms>`, `podcast:darknet diaries`, `rss:<feed url>` | iTunes search → RSS → MP3 enclosures. Spoken-word episodes bypass the automix. |
| **radioparadise** (lossless) | `rp:mellow`, `rp:0`…`rp:4`, radioparadise.com URLs | Listener-supported radio served as **FLAC blocks** with the running order attached, so the station announces the right song at the right moment. Transcoded by MetroS as it downloads. |
| **vimeo** | `vimeo:76979871`, vimeo.com / player.vimeo.com URLs | The audio of a Vimeo video: progressive MP4 when the uploader allowed it, otherwise the HLS rendition. AAC either way, so MetroS decodes it. |
| **mirror** | `https://open.spotify.com/track/…`, Apple Music, YouTube, `mirror:<artist – title>` | Metadata only. A link that cannot legally stream is **matched to a source that can**, and the original artwork/title stays on air (`mirroredFrom`). |
| **deezer** (metadata) | `dzsearch:<terms>`, deezer.com URLs | Exact title/artist/artwork/ISRC, then cloned to a playable provider. |
| **radiobrowser** | `radio:<name or tag>`, `rbsearch:<terms>` | 50k community-indexed live MP3 stations. ICY `StreamTitle` becomes now-playing, and it is the last-resort "never go silent" source. |
| **http** | `https://host/track.mp3`, Icecast/Shoutcast, `.pls` / `.m3u`, **HLS `.m3u8`**, `.aac` / `.m4a` / `.ogg` / `.flac` | Direct files and live relays. An HLS playlist is followed segment by segment; anything that is not MP3 is transcoded. |
| **local** | `local:folder`, `local:/path/file.flac` | Files under `server/media` — jingles, idents, offline fallback, or a whole library. MP3 is aired byte for byte; FLAC, M4A, Ogg, WAV and friends are transcoded on the way out (needs libmetro). |
| **tts** | `tts:<text>`, `say:`, `announce:` | Speech as a track: idents, owner announcements, DJ links. |

Adding a provider is ~40 lines: drop a class in `src/sources/`, register it in `src/sources/index.js`.
The station core never learns provider specifics.

### Hi-res re-clone

SoundCloud tops out at 128 kbps. Before a track goes on air the registry asks: *does a better copy of this
exact recording exist elsewhere?* It searches the hi-res providers for `artist title`, scores candidates
(Jaccard token similarity with decoration like *(Official Audio)* stripped, blended with duration
proximity), and if the best clears `hiResMinScore` (0.62) **and** `hiResMinKbps` (192) it plays that copy
and records `upgradedFrom`, so the UI can show `128k → 320k`.

### Fallback chain

`SourceRegistry.stream()` never lets one dead link silence a station: the chosen track → its clones on
other providers (≥0.45) → after **two consecutive** station failures, a themed live stream matching the
genre → otherwise throw with every provider's error attached and skip. A rotation track earns its place
back only by *actually playing*, so a dead link is dropped instead of cycling forever at the head of the
queue. Counters land in `/api/v1/stats` as `upgrades` and `fallbacks`.

## Automix 🎚

Track changes are **mixed, not butt-spliced**. The reader runs one crossfade behind itself: the last
seconds of the outgoing song are held back instead of aired, and when the next song starts arriving both
ends are decoded, mixed and re-encoded into a single seamless MP3 segment that airs in place of the seam.

```
reader ─► [ automix: hold tail ─► decode A-tail + B-head ─► analyse ─► beatmatch ─► mix + DJ ─► re-encode ] ─► pacer
```

All in process: **mpg123 (wasm)** decodes, **lamejs** re-encodes, `src/core/dsp.js` does the signal
processing, and the encoder yields to the event loop every ~0.5 s so other stations keep their pacing.
`ffmpeg` is never spawned; if the decoder is missing the automix degrades to pass-through and the station
keeps broadcasting.

### Beatmatching (the Apple-AutoMix part)

Aligning the downbeat is not enough — if the songs are at different tempos the blend drifts apart within a
bar. So Nodecast does what a DJ does and **changes the tempo of the outgoing song to meet the incoming one**:

1. **Detect** both grids — spectral-flux onset envelope → autocorrelation over 60–200 BPM with a
   log-Gaussian prior at 120 BPM (parabolic interpolation on the ACF peak) → pulse-train phase.
2. **Fold** the incoming tempo into the outgoing one's octave (`foldTempo`), so 84 vs 168 BPM is a
   half-time relationship, not a 100 % stretch.
3. **Decide**: the required ratio must be worth doing (> 0.3 %) and within `maxStretchPercent` (12 % by
   default — beyond that the ear notices). Otherwise the seam falls back to plain phase alignment.
4. **Stretch** the outgoing tail with **WSOLA** (waveform-similarity overlap-add, ±8 ms search) —
   duration changes, **pitch does not**. The ramp eases in over two beats so the tempo bends instead of
   jumping, and the warp keeps an invertible input↔output map.
5. **Phase-lock** the incoming song by rotating it onto the warped beat grid, and **quantise** the blend
   length down to a whole number of warped beats — a four-beat phrase when one fits.

The seam report tells you exactly what happened:

```jsonc
"beat": { "aligned": true, "matched": true, "bpm": 124, "incomingBpm": 132.1,
          "playedAtBpm": 132.1, "stretchPercent": -6.07, "shiftMs": 148,
          "beatsInBlend": 12, "confidence": 1 }
```

It is verified in `test/automix.test.js`: two synthetic loops at 120 and 128 BPM are mixed, the rendered
seam is decoded again and re-measured, and the measured tempo has to be the *incoming* one.

### Before a single sample is mixed

| Step | What it does | How |
|---|---|---|
| **Loudness** | the incoming song is level-matched to the outgoing one, then eased back to its own level over the last 1.5 s | ITU-R BS.1770 / EBU R128 gated loudness (K-weighting, 400 ms blocks, −70 LUFS absolute + −10 LU relative gate), clamped to ±6 dB |
| **Cue points** | the blend happens over audio, never over the silence at the head or tail, and a long fade-out is not chopped in half | 50 ms RMS windows: cue-in/out at −42 LU below programme, overlay at −8 LU |
| **Correlation** | the fade law is chosen from the material instead of being assumed | zero-lag cross-correlation `r` → `aˣ + bˣ = 1` with `x = 2 − r` |
| **Beat grid** | see above | onset envelope → ACF → phase → WSOLA |
| **Peak guard** | the rendered seam never clips | sample-peak ceiling at −1 dBFS |

The loudness meter is checked against the BS.1770 identity and `pyloudnorm` reference values in
`test/dsp.test.js` (agrees to 0.01 LU).

### Transitions

| Effect | What the listener hears | How it is built |
|---|---|---|
| `crossfade` | a clean blend with no dip and no level jump — default | correlation-adaptive fade law |
| `bass-swap` | the club standard: the new song enters with its lows cut, then the bass changes hands in one move on a beat | Linkwitz-Riley 4th-order crossover at 200 Hz, one-beat swap at ~62 % of the blend |
| `filter` | the outgoing song closes into a low-pass while the incoming one opens up from behind a high-pass | resonant biquads (Q 0.9) swept 18 kHz → 320 Hz / 700 Hz → 25 Hz, recomputed every 64 samples |
| `echo` | the outgoing song is cut into a beat-synced delay that rings out over the new one | ½-beat feedback delay (fb 0.5, damped at 5 kHz), dry fader pulled over one beat |
| `sweep` | a filtered noise riser peaking exactly on the handover | band-passed deterministic noise, centre 300 Hz → 7 kHz, sin² envelope |
| `spindown` | tape stop: the outgoing song decelerates to a standstill, a breath of silence, then the drop | falling playback rate with interpolation, 5 ms de-click, 50 ms gap |
| `slam` | full level to the last beat, then the new song, nothing in between | cut quantised to the beat grid with 5 ms ramps |

### The DJ 🎙

Every *N*th transition the DJ voice-tracks over the seam. The voice is high-passed, compressed and
normalised to −14 LUFS, and the music underneath is ducked by a **real sidechain compressor keyed off the
voice** (threshold −32 dB, 12:1, 80 ms attack, 600 ms release, floor −9 dB) with a 180 Hz high-pass on the
bed while the line runs:

```
"That was Blue Hour by Kavi. Coming up next, Second Sun by Tone Test. You're listening to Night Drive FM."
"That one goes out to Mai, thanks for calling it in. Here's Second Sun."
```

Lines are written by `src/core/dj.js` from the two tracks, the station name, the time of day and the
listener count; scraped-title noise (`(Official Video)`, `[Out Now]`) is stripped before it is spoken and
**requests always get a shout-out** by name. Speech resolution order: owner file → bundled MP3 → sha1 disk
cache → Google `translate_tts` (chunked, no key) → a tone bed, so it works offline too.

Short items are left alone: anything under `minTrackMs` (20 s), idents and live relays bypass the automix
entirely, which is also why a station's first seconds are instant.

### Control

Per station (or under `stationDefaults` in `config.json`):

```jsonc
"automix": {
  "enabled": true,
  "crossfadeMs": 6000,
  "curve": "auto",             // auto | equal-power | equal-gain
  "effect": "crossfade",       // crossfade | bass-swap | filter | echo | sweep | spindown | slam
  "minTrackMs": 20000,
  "beatAlign": true,           // land the new song on a beat
  "beatmatch": true,           // …and stretch the old one onto its tempo
  "maxStretchPercent": 12,     // refuse to stretch further than this
  "trimSilence": true,
  "targetLufs": -16,
  "maxGainDb": 6,
  "ceilingDb": -1,
  "crossoverHz": 200,
  "dj": { "enabled": true, "name": "Ava", "every": 3, "duckDb": -9, "leadInMs": 700, "tailMs": 900 }
}
```

Live, from the console's **Automix & DJ** panel or the API:

```bash
curl -X POST localhost:2333/api/v1/owner/stations/night-drive-fm/automix \
  -H "x-owner-key: $KEY" -H 'content-type: application/json' \
  -d '{"effect":"bass-swap","crossfadeMs":8000,"beatmatch":true,"maxStretchPercent":8}'
```

Each station's `info().automix` carries the live state and a `last` record for the seam that was rendered:
`from`, `to`, `effect`, `curve`, `correlation`, `blendMs`, the measured `loudness` of both songs, the
`cues` it trimmed, the `beat` block above, `peakDb`, `renderMs` and the spoken line. The console prints it
under the station — *beatmatched 124→132 BPM (−6.07 %, 12 beats)* — and mixed frames are tagged, so the
station page shows a **MIXING** badge while a blend is on air.

## The console

Static Next.js export in `web/`, built into `server/plugins/console/public` by `npm run build:web` and
mounted by the **`console` plugin** on the node's own port. Disable the plugin and the node keeps
broadcasting with no HTML attached; enable it and the UI is back, same origin, same process.

Boot is forgiving: a clone that has never been built still starts, and `/` answers `503` with a page
that says which command to run (the API and the streams are unaffected). Run `npm run build:web` and the
node **picks the build up within a few seconds, without a restart**.

The console is **phone first**, in the shape YouTube Music taught everybody
to expect — because the point of copying a familiar layout is that nobody
has to learn it:

* **Home** — a greeting, filter chips, an "on air now" shelf of square
  cards, then flat rows for everything else.
* **Search** — one field across every source (below), source chips to
  narrow it, and a sheet to send a result to any station.
* **Playing** — big square artwork, scrub line, transport, then tabs for
  **lyrics** and what is up next.
* **Studio** — owner-gated: transport, a draggable queue, announcements,
  the **DJ booth**, plugins and the node's voice.

Three deliberate choices:

* **Near-black everywhere, colour only from artwork.** `#030303`, one
  accent, and the covers do the rest.
* **[Kawarp](https://github.com/better-lyrics/kawarp) on Now Playing, and
  nowhere else.** The cover is Kawase-blurred and pushed around by
  simplex-noise domain warping on the GPU — the Apple Music album-art
  effect — dialled *hard* (16 blur passes, 0.95 warp, 1.9 saturation)
  because it should read as weather in the record's colours, not as a
  picture of the sleeve. It pauses when the tab is hidden and degrades to
  a flat background without WebGL.
* **[Solar](https://www.figma.com/community/file/1166831539721848736) icons,
  one family, one weight.** Bold when a tab is selected, Linear when it is
  not — the trick YT Music uses to show where you are. Every glyph is
  re-exported from `components/icons.js`, so swapping one is a single line.

It reports OS media metadata too, so the lock screen shows the station and
the hardware play/pause buttons work.

Working on the UI? `cd web && npm run dev` runs it on :3000 against the node
— `lib/api.js` probes the usual ports (or takes `?node=http://host:2333`). In
production none of that matters: everything is same-origin and relative.

## Smart Automix

Three things changed here, and they are related: the mix decides **how long**
a blend should be, it can now hold a blend for half a minute without the
node stuttering, and you can **hear a transition before you use it**.

### The blend length follows the pair

A fixed crossfade is a compromise between two songs that never meet. What a
DJ does is hold a blend for as long as it keeps working, so that is what
`smart: true` (the default) does:

| The pair | What happens |
|---|---|
| tempos locked (< 1 BPM apart) | up to **2.2×** longer — that is the pleasure of a mix |
| tempos far apart (> 12 BPM) | 0.55× — get it over with |
| they correlate (similar key/texture) | 1.3× — they sit together |
| they fight (negative correlation) | 0.6× |
| hot entry | 0.75× · gentle entry 1.25× |

…then rounded to whole **bars**, clamped to `minCrossfadeMs`/`maxCrossfadeMs`
(2 s–30 s by default), and never longer than the audio actually held. The
report says what it chose and why:

```
INFO automix:lofi | roll 16875ms (9 bars) equal-power beatmatched 124→126bpm:
     "Night Drive" → "Neon"  [why: tempos locked, they sit together]
```

### Longer blends, and no stutter

The two expensive stages are beat detection (an STFT plus an autocorrelation
over every plausible lag) and the WSOLA time stretch. Both were JavaScript
on the same thread that releases an MP3 frame every 26 ms. At six seconds
nobody noticed; at thirty it was audible. They are now Rust, in `libmetro`,
and they run **on the thread pool**:

| 60 s window | JavaScript | libmetro |
|---|---|---|
| beat detection | 673 ms | **52 ms** (12.9×) |
| WSOLA stretch | 723 ms | **360 ms** (2.0×) |
| event loop during both | blocked | **keeps ticking** |

Same algorithm, same numbers — the Rust is a faithful port of
`core/dsp.js`, and a test asserts the two agree on tempo to within 0.5 BPM
and on confidence to within 0.05, so the JavaScript remains the readable
reference implementation.

### Hear it first

```bash
curl -X POST -H "x-owner-key: $KEY" -H 'content-type: application/json' \
     -d '{"effect":"roll","crossfadeMs":8000,"station":"lofi"}' \
     localhost:2333/api/v1/owner/automix/preview -o roll.mp3
```

The node renders that exact seam — same beatmatcher, same ducker, same
encoder — between the last thing the station played and the next thing in
its queue (falling back to the shipped demo, then to synthesised loops).
About 160 ms per audition. The **DJ booth** in the console is this endpoint
with a waveform: pick a transition, hear it, watch where the handover lands,
then save it.

## One song is not a playlist

Hand a station a single track and it used to play that track forever. Now,
when the rotation runs down and `autoplay` is on, the finished song is
retired instead of re-queued and the [smart queue](#smart-queue-autoplay-that-follows-the-station)
finds something new. One song means *the next song*.

## Transitions that choose themselves

A station that always does the same trick stops sounding like a DJ after ten
minutes, and a trick that does not fit the music sounds worse than no trick.
So the default transition is **`auto`**: every seam is scored from what the
two songs are actually doing, and the node picks.

| Transition | What it does | Wants |
|---|---|---|
| `crossfade` | level-matched blend | anything |
| `wash` | dissolves into a reverb tail | two songs that share nothing |
| `filter` | one sweeps out, the other opens up | anything |
| `echo` | cut into a beat-synced delay tail | a beat, ideally |
| `bass-swap` | basslines change hands in one move | matched tempos |
| `sweep` | filtered-noise riser under the blend | energy |
| `roll` | beat-repeat halving into the handover | a tempo grid |
| `drop` | filtered away, a breath of silence, downbeat | a tempo grid |
| `spindown` | tape stop, then the new song lands | anything |
| `slam` | no overlap at all, cut on a beat | anything |

The picker weighs tempo agreement, how strongly the two songs correlate, how
hard the incoming one enters, how long the blend is, and whether the DJ is
talking over it — then refuses to repeat the last transition when anything
else is nearly as good, and picks at random among the near-best so two
similar seams do not always resolve the same way. Name a transition instead
of `auto` and it is used every time; give it an `effectPool` and it chooses
only from those.

```jsonc
"automix": { "effect": "auto", "effectPool": ["crossfade", "bass-swap", "roll"], "varyEffects": true }
```

**Every seam is made joinable.** A rendered transition is spliced between
audio nobody rendered, and each effect leaves its own mess at the edges — a
DC step from a filter, half a sample of a brake, an abrupt loop end. Before
it goes out, the seam gets a DC blocker and a 2 ms raised-cosine ramp at
each boundary, which is the difference between *a mix* and *a series of
edits*. The report says what happened, and whether the node chose it:

```
INFO automix:lofi | roll 4980ms equal-power beatmatched 122→124bpm (+1.6%):
     "Night Drive" → "Neon" [match +0.4 dB, peak -1.2 dBFS, chosen, 812ms]
```

## Lyrics, in time, without the browser phoning home

The now-playing screen shows word-synced lyrics in the style of Apple Music,
rendered by [`<am-lyrics>`](https://github.com/uimaxbai/apple-music-web-components)
— a Lit web component that handles the scroll, the per-word sweep and the
interpolation between beats.

It can fetch lyrics itself. Nodecast does not let it: the **node** looks them
up on [LRCLIB](https://lrclib.net), converts the line-synced LRC into the
word-level TTML the component renders, and hands that over finished. So no
listener's browser talks to a lyrics service, a node on a LAN fetches each
song once for everybody, and the result is cached with the track.

```bash
curl 'localhost:2333/api/v1/lyrics?station=lofi'
{ "found": true, "synced": true, "lines": [ { "at": 23180, "text": "Love I get so lost sometimes" }, … ],
  "ttml": "<tt …>", "positionMs": 8882, "serverTime": 1790… }
```

Word timings are interpolated across each line in proportion to word length —
LRCLIB gives timings per line, not per word — which is honest about what it
is and looks right. A stream has no `currentTime`, so the client anchors on
`positionMs`, adds the time since, and the listener can nudge the result
(every player buffers a different amount).

## VNNews — bản tin 17:00–19:00

Vietnamese radio has a rush-hour news slot, so Nodecast ships one. Between
**17:00 and 19:00 Hanoi time** the `vnnews` plugin interrupts the music every
half hour, reads the headlines from VnExpress, Tuổi Trẻ, Thanh Niên, Dân Trí
and VOV, and hands the music back. Outside the window it does nothing.

```bash
curl -X POST -H "x-owner-key: $KEY" localhost:2333/api/v1/owner/plugins/vnnews/enable
curl -X PATCH -H "x-owner-key: $KEY" -H 'content-type: application/json' \
     -d '{"settings":{"everyMinutes":30,"headlines":6,"start":"17:00","end":"19:00"}}' \
     localhost:2333/api/v1/owner/plugins/vnnews

curl 'localhost:2333/api/v1/x/vnnews/'                    # window, next bulletin, per station
curl 'localhost:2333/api/v1/x/vnnews/headlines?station=vn' # what it would read
curl 'localhost:2333/api/v1/x/vnnews/script?station=vn'    # the exact words
curl -X POST -H "x-owner-key: $KEY" localhost:2333/api/v1/x/vnnews/read/vn   # read one now
```

It is only ever text and speech — nothing is downloaded, decoded or
transcoded. A bulletin is a few kilobytes of RSS and one MP3 the node voices
itself, which is why it runs on a Raspberry Pi:

```
Xin chào quý vị và các bạn. Đài Thử Nghiệm xin gửi tới quý vị bản tin lúc
năm giờ rưỡi chiều. Sau đây là 6 tin chính. Tin thứ 1. …  Theo VnExpress.
… Bản tin đến đây là kết thúc. Cảm ơn quý vị đã lắng nghe.
```

What makes it sound like a newsroom rather than a script:

* **Voiced in a worker thread.** A bulletin is a dozen HTTP requests to a
  speech provider; doing that on the thread that releases an MP3 frame every
  26 ms is how a station starts to stutter. So the speech is rendered in a
  worker *before* the bulletin goes on air (measured: 1,100 characters in
  **626 ms**), and the station then finds it already in the cache. The worker
  is bounded — one task at a time, a hard timeout, a capped queue, text
  limits — and **every failure path ends inline**: no worker, a stuck
  provider, a killed thread, and the listener still hears the news. `worker:
  false` turns the thread off entirely.
* **No outlet takes the whole bulletin.** Stories are interleaved
  round-robin across the feeds, so six stories are six newsrooms.
* **Timestamps are not trusted.** Vietnamese feeds disagree about time zones
  — one stamps local time as UTC and lands seven hours in the future, another
  leaves a year-old date on a live story — so future dates are clamped and
  stale ones sink to the back.
* **Entities are decoded.** Some outlets publish `đ&agrave;o tạo`; reading
  "đ ampersand agrave" out loud is not acceptable.
* **Nothing is read twice**, the window can wrap past midnight for a late
  edition, a slot only fires once however often the timer ticks, and one dead
  feed never silences the bulletin.
* **Music under the voice.** Point `bed` at free music — `ccsearch:ambient`
  is Creative Commons by construction, or use your own file — and the
  bulletin is mixed over it with the same sidechain ducker the DJ uses: the
  bed fades in before the first word, ducks while anybody is speaking, and
  carries the silence at the end back into the music. Resampled to match the
  voice, held under −1 dBFS, cached as one MP3.
* **Or every N songs.** `everySongs: 5` runs the headlines between records as
  well as on the clock, whichever comes first; `anytime: true` frees it from
  the window entirely.

The clock is per station and per zone (`timezone` defaults to
`Asia/Ho_Chi_Minh`), so a node can carry a Hanoi news slot and a London one
at the same time.

## Two voices, one set of settings

Nodecast speaks through either of two free services, and the split between
their settings is the point:

| | Google Translate | [Flowery](https://flowery.pw/docs) |
|---|---|---|
| voices | one per language | **2,055** across 14 engines (Azure, Polly, Speechify, Cartesia…) |
| languages | ~100 | **254** |
| pace | 0.1–1× | 0.25–4× |
| speed | ~0.3 s per bulletin chunk | ~8 s per 600 characters (they are neural) |
| terms | — | free, **non-commercial** |

```bash
curl -H "x-owner-key: $KEY" 'localhost:2333/api/v1/owner/tts?provider=flowery&language=vi'
#  shared:    { language: "vi", speed: 1, fallback: true }
#  providers: google {}, flowery { voice: … }
#  voices:    Hoai/Azure, Nam/Azure, Linh/Speechify, …   (12 for Vietnamese)

curl -X PATCH -H "x-owner-key: $KEY" -d '{"provider":"flowery","providers":{"flowery":{"voice":"42bc…"}}}' …/owner/tts
```

**Language and pace are shared**, because they belong to the station — a
node should not change character because somebody switched API. **Voices are
per service**, because a voice id means nothing to the other one. Both are
remembered in SQLite, and a clip's cache name includes the service, the
voice, the language and the pace, so two renderings never collide.

If the chosen service fails, the other one is tried before the node gives up
(`fallback: false` to disable). The studio's **Voice** panel is this screen:
service, language, pace, voice, preview.

## Memory: a restart in the middle of a song

A station is a process that should never stop, on hardware that certainly
will. Each one keeps a memory in the same SQLite file — the track on air and
how far into it, plus the queue behind it — written at most once every five
seconds and read once at boot:

```
INFO station:lofi | resuming "Night Drive" at 138s (and 23 queued track(s))
```

The seek costs nothing clever: the reader drops whole MP3 frames until it
reaches the offset, so it works identically for a local file, a SoundCloud
stream and an archive.org download, and lands within one frame (26 ms) of
where the node stopped. Idents, live relays, anything barely started and
anything nearly finished are not resumed — those are better restarted or
skipped.

It is also where the RAM went. History used to be an array that grew for the
life of the process; now the last twenty entries stay in memory and the rest
is a table — which is what makes the next feature possible.

## Smart queue: autoplay that follows the station

When the queue runs low, Nodecast looks at what this station has actually
been playing, asks every source for more of it, and keeps going:

```
INFO smartqueue | lofi: autoplay added 5 track(s) — Bonobo — Kerala, Tycho — Awake, …
```

Three rules keep it listenable: seeds come from a **window** of recent plays
rather than the last track; anything played recently or already queued is
filtered out **by id and by artist+title** (the same song has a different id
on every source); and at most **one track per artist** joins each refill.
Per station: `"autoplay": true`, and `smartQueue: { minQueue, batch, lookback, perArtist }`
on the node. A search that fails or returns nothing is not an outage — the
station falls back to its rotation.

## MetroDB — SQLite in Rust, instead of node-gyp

`better-sqlite3` is an excellent library and a C++ addon that node-gyp
compiles at install time. On a Raspberry Pi, in a slim container, or on any
machine without a compiler and Python, that compile is the single most
likely thing to fail — *after* somebody has decided to try the project.

`metrodb/` is the same database with none of that: SQLite compiled into a
Rust addon, prebuilt for every platform by the same universal build as
libmetro, with **better-sqlite3's API**:

```js
const db = new Database('nodecast.db')
db.exec('CREATE TABLE plays (id INTEGER PRIMARY KEY, title TEXT)')
db.prepare('INSERT INTO plays (title) VALUES (?)').run('Get Lucky')   // { changes, lastInsertRowid }
db.prepare('SELECT * FROM plays WHERE id = ?').get(1)                  // row, or undefined
db.prepare('SELECT * FROM plays').all()
db.transaction(() => { … })()          // rolls back if it throws, nests via savepoints
db.pragma('journal_mode = WAL')
```

The store tries three drivers in order — **MetroDB**, `bun:sqlite`,
`better-sqlite3` — and nothing above it knows which answered:

```
INFO store | persistence: metrodb (rust, sqlite 3.46.0) · schema v7
```

`NODECAST_DISABLE_METRODB=1` forces the old path, and the store's own test
suite runs identically on whichever driver is present. Build it like
libmetro:

```sh
cd metrodb && cargo build --release && node scripts/link-local.js
./scripts/build-linux-universal.sh     # x64/arm64 · gnu/musl · armv7
```

## One search, every source

`GET /api/v1/search?q=…` asks every provider that can search, in parallel,
and returns **one ranked list**. The ranking is the interesting part,
because the old one sorted by bitrate — which put a 320 kbps field
recording of rain above the song you actually typed:

| Term | Weight |
|---|---|
| title + artist similarity to your query | ×2 — by far the largest |
| your words appearing verbatim in the result | +0.5 |
| **cannot actually be played** (catalogue-only hits) | −0.8 |
| bitrate above 128 kbps | +0.2 at most — a tie-breaker, not a ranking |
| per-provider preference (`local`, the default source…) | ±0.25 |

Then the same recording from three providers is collapsed into one row by
artist+title fingerprint, keeping the best copy. Providers that would answer
*every* query — TTS, the HTTP catch-all, the mirror resolver, the
50,000-station radio directory — sit out of "search everywhere" but can
still be asked by name (`?provider=radiobrowser`).

```
$ curl 'localhost:2333/api/v1/search?q=tycho+awake&limit=4'
  2.65  soundcloud  Tycho   Awake
  2.15  soundcloud  Tycho   Tycho - Awake (Com Truise Remix)
 1.483  soundcloud  niko+   Tycho - Awake (Clans Vocal Remix)
 0.667  bandcamp    Tycho   Dye
```

### YouTube Music, as a card index

NodeLink resolves Spotify and YouTube Music links by finding the recording
somewhere playable, and `ytmusic` does the same here. YouTube Music knows
what every song is called, who is on it and how long it runs; what it will
not do is hand a radio station the audio. So this provider resolves
**metadata** — through the same public InnerTube search the web player uses,
no key — and hands it to a source that genuinely streams:

```bash
curl 'localhost:2333/api/v1/search?q=tycho+awake&provider=ytmusic'
#  ytmusic | Tycho — Awake | streamable: false      ← the card index

# and as a playlist entry it becomes something playable:
#  ytm:tycho awake  →  Tycho — Awake  (plays from soundcloud, mirroredFrom: ytmusic)
```

The title, artist and artwork stay YouTube Music's, so the station announces
the right thing; the bytes come from somewhere that is happy to be played.

## Nothing leaks to the browser

* The page is static HTML — there is **no server runtime, no `.env`, no config** behind it to leak, and
  browser source maps are off.
* Every API payload is an explicit whitelist (`publicTrack` in `src/core/station.js`): id, title, artist,
  album, duration, artwork, source, bitrate, flags, and a `link` to the provider page. Stream URLs,
  resolved file paths, `client_id`s, headers and internal errors never reach a response.
* A station's ident is reported publicly as `{ tts, audio: true }` — never the file path on disk.
* 500s answer `{"message":"Request failed"}` when the real error mentions a path; the full stack goes to
  the log only.
* The owner key travels in the `x-owner-key` header, is kept in `localStorage`, and is never put in a URL.

## Persistence (SQLite)

Every node keeps **all** of its state in one SQLite file — `server/data/nodecast.db` by default. There is
no JSON fallback: a node that cannot open its database says so instead of quietly forgetting things.

The schema is versioned and migrated on boot (`server/src/store/migrations.js`), so upgrading Nodecast is
just starting the new version:

```
INFO  [store] migrated nodecast.db  v2 → v5  (plugins, play_index, drop_dialer, requests_status)
```

| Table | Holds |
|---|---|
| `stations` | owner-created stations, so they come back after a restart |
| `requests` · `votes` | the request line; `UNIQUE(request_id, voter)` is what enforces one vote per listener |
| `skip_votes` | vote-skip tallies, `UNIQUE(station, track, voter)` |
| `plays` | play history per station (what aired, when, at which bitrate, who asked for it) |
| `bans` | restricted listener ids |
| `plugins` | per-plugin enabled flag and settings |
| `settings` | node-level key/value state |
| `schema_migrations` | which migrations ran, and when |

A legacy `radio.db` or an old `config.json`-era JSON store found next to it is adopted and imported once,
then left alone as a `.bak`.

```bash
cd server
npm run db info                 # driver, schema version, table counts, file size, migration history
npm run db migrate              # apply pending migrations (also happens on boot)
npm run db backup               # timestamped copy next to the database
npm run db export dump.json     # everything as JSON
npm run db plugins | stations   # quick looks
npm run db vacuum               # reclaim space (safe while broadcasting)
```

The same maintenance is one click away in the console, and available over the API:
`GET /api/v1/owner/store`, `POST /api/v1/owner/store/{backup,vacuum,checkpoint}`.

Configure with `store.enabled`, `store.file`, `store.migrate` in `config.json`, or `STORE_FILE=…`.

## Plugins (`server/plugins/`)

Anything in the folder is discovered at boot — a single `.js` file, or a folder with a `plugin.json` and
an entry point. A plugin gets a context and hands back an optional teardown:

```js
export const manifest = { name: 'Now playing', version: '1.0.0', description: 'writes now-playing.json' }

export default function setup(ctx) {
  ctx.on('track', ({ station, data }) => ctx.log.info(`${station.id}: ${data.track.title}`))
  ctx.registerRoute('GET', '/', (req, res, { send }) => send(res, 200, ctx.stations.list()))
  return () => ctx.log.info('bye')
}
```

`ctx` gives a plugin the station manager, the source registry, the store, its own persisted settings, a
scoped logger, a redacted view of the config (no keys, no paths), `every(ms, fn)` timers, and three
registration hooks: `registerSource`, `registerEffect` (a new automix transition) and `registerRoute`
(served under `/api/v1/x/<plugin-id>/…`). **Everything registered is revoked again** when the plugin is
disabled or reloaded — sources leave the registry, transitions leave the effect list, routes stop
answering, listeners and timers are cleared. A plugin that throws is marked `error`; the node keeps
broadcasting.

Plugins can also serve files: `ctx.registerStatic(dir, { mount, spa })` mounts a directory on the node's
own port (consulted before the core static handler, revoked the moment the plugin is switched off), and
routes may use `:params` and a trailing `*`. That is how the console ships. `ctx.relay(station, stream)`
puts a live feed on air through MetroS (above).

Shipped: `console/` (the whole web UI — switch it off for a headless node), `now-playing/` (events +
settings + a public route + a file for OBS), `backspin.js` (a real DJ backspin transition),
`hourly-ident/` (timers and speaking on air — ships switched off), `live-relay/` (a live feed on
air through MetroS — also switched off until you want it) and `vnnews/` (Vietnamese news bulletins on
a clock — see below). Full authoring notes:
[`server/plugins/README.md`](server/plugins/README.md).

### Settings that describe themselves

A plugin declares its settings — types, ranges, units, help text — and the
node validates everything against that declaration and hands the console a
form to render:

```jsonc
"settingsSchema": [
  { "key": "everyMinutes", "type": "integer", "default": 30, "min": 5, "max": 240, "unit": "min" },
  { "key": "feeds",    "type": "list",     "of": "url", "max": 24 },
  { "key": "timezone", "type": "timezone", "default": "Asia/Ho_Chi_Minh" },
  { "key": "worker",   "type": "boolean",  "default": true, "perStation": false, "advanced": true }
]
```

```bash
$ curl -X PATCH … -d '{"settings":{"everyMinutes":500}}' …/owner/plugins/vnnews
{ "status": 400, "message": "A bulletin every: must be at most 240" }
```

Eleven field types (`string` `text` `number` `integer` `boolean` `select`
`list` `time` `url` `language` `timezone`), `secret` fields that never come
back to the browser, `perStation: false` for node-wide ones, and `advanced`
for the ones a console should fold away. `GET …/plugins/:id/schema` returns
the form; the **Plugins** panel in the studio renders sliders, time pickers
and one-per-line lists from it without knowing what the plugin does. A plugin
with no schema keeps working, with a JSON box. Authoring notes:
[`server/plugins/README.md`](server/plugins/README.md).

### Per station, not just per node

A plugin is loaded once for the process, but it does not have to apply to every station: the hourly
ident belongs on the talk channel, the relay belongs on one music channel. Each plugin declares a scope in its
manifest — `"scope": "stations"` (the default) or `"global"` (the console) — and the owner can then
switch it on or off **per station**, live, with nothing reloading:

```bash
curl -H "x-owner-key: $KEY" localhost:2333/api/v1/owner/stations/talk/plugins
curl -X POST -H "x-owner-key: $KEY" localhost:2333/api/v1/owner/stations/talk/plugins/hourly-ident/disable
curl -X POST -H "x-owner-key: $KEY" localhost:2333/api/v1/owner/stations/talk/plugins/hourly-ident/reset  # follow the node again
curl -X PATCH -H "x-owner-key: $KEY" -H 'content-type: application/json' \
     -d '{"stations":{"talk":false,"lofi":true}}' localhost:2333/api/v1/owner/plugins/now-playing
```

Or click the station chips under each plugin in the console's **Plugins** panel (shift-click a pinned
one to go back to following the node).

The scope is enforced by the host, not by the plugin behaving itself:

* `ctx.stations.list() / .get(id) / .all()` only ever show stations the plugin applies to — a station it
  is off for is simply not there, and `get()` returns `undefined`;
* station events (`track`, `state`, `listeners`, …) for that station are never delivered;
* `ctx.stations.settings(id)` layers per-station settings over the plugin's own, so one station can have
  its own ident rate or relay URL;
* `ctx.stations.onScopeChange(fn)` tells a running plugin it was just switched on or off somewhere;
* `ctx.stations.every()` is the escape hatch for the rare plugin that genuinely needs the whole node.

Decisions live in the `station_plugins` table (schema v6), so they survive restarts — and deleting a
station forgets them, so a new station reusing the id starts clean.

Manage them from the **Plugins** panel in the console, or:

```bash
curl -H "x-owner-key: $KEY" localhost:2333/api/v1/owner/plugins
curl -X POST -H "x-owner-key: $KEY" localhost:2333/api/v1/owner/plugins/backspin/disable
curl -X POST -H "x-owner-key: $KEY" localhost:2333/api/v1/owner/plugins/rescan
```

Enabled state and settings live in SQLite, so they survive restarts. `PLUGINS=off` disables the whole
subsystem; `PLUGINS_DIR=…` points it elsewhere.

## Logging

One line per event, and the line tells you where it came from:

```
20:14:02 INFO  station:lofi  | ▶ Kavi — Blue Hour                       bitrate=320 source=archive
20:14:02 DEBUG automix:lofi  | seam rendered                            effect=bass-swap blend=5538ms bpm=124→128
20:14:09 WARN  sources       | primary stream failed (soundcloud) — 403
```

* **Levels** `trace debug info warn error fatal silent` (`LOG_LEVEL`, or `logging.level`).
* **Scopes** every subsystem logs under its own name (`station:lofi`, `automix:lofi`, `plugin:backspin`,
  `store`, `sources`, `owner`…), and each can be turned up on its own:
  `DEBUG=automix,plugin:backspin` or `logging.debug: { automix: 'trace' }`.
* **Structured fields** — the trailing `key=value` pairs are real data, written as JSON to the file sink.
* **Redaction** — owner keys, tokens, `client_id`s and `Authorization` values are replaced with `***`
  in messages *and* in field values, so a log can be pasted into an issue.
* **Ring buffer** — the last few hundred lines are kept in memory and served to the console's **Logs**
  panel (`GET /api/v1/owner/logs?limit=&level=&scope=`), with a live tail, level filter and scope filter.
* **File sink** — `LOG_FILE=/var/log/nodecast.log` (or `logging.file.enabled`) writes JSON lines with
  size-based rotation (`maxMb`, `keep`).

## HTTP API (default `:2333`)

```
GET    /health
GET    /api/v1/info | /stats | /setup | /sources
GET    /api/v1/search?q=&limit=&source=          all | soundcloud | audius | archive | … (hi-res first)
GET    /api/v1/resolve?q=                        any source → tracks
GET    /api/v1/stations[?queue=1]
POST   /api/v1/stations                          { id, name, genre, playlists:[…] }
GET    /api/v1/stations/:id · PATCH · DELETE
GET    /api/v1/stations/:id/nowplaying | /queue | /history | /requests
POST   /api/v1/stations/:id/queue                { query | track | tracks, next }
DELETE /api/v1/stations/:id/queue/:index
POST   /api/v1/stations/:id/skip | shuffle | start | stop | reload
POST   /api/v1/stations/:id/request              { query | track, by }
POST   /api/v1/stations/:id/requests/:rid/vote · POST /api/v1/stations/:id/voteskip
GET    /stream/<id>.mp3                          continuous MP3 (+ICY with `Icy-MetaData: 1`)
                                                 …anything else under /stream is a spoken 404
GET    /api/v1/tts                               languages this node speaks
GET    /api/v1/lyrics?station=<id>                word-synced lyrics + the position to sync them to
GET    /api/v1/lyrics?artist=&title=&duration=    …or for any track at all
WS     /ws                                       ready · state · track · progress · queue · requests · voteskip · listeners · stats · station{Added,Updated,Removed}
GET    /                                         the console (and any other non-API path)
```

Owner routes, with `x-owner-key: <key>` (also `Authorization: Bearer <key>` or `?key=`):

```
GET    /api/v1/owner                             overview: stations, defaults, bans, store stats
GET    /api/v1/owner/whoami                      key check used by the wizard
POST   /api/v1/owner/stations                    create (persisted, survives restart)
PATCH  /api/v1/owner/stations/:id · DELETE
POST   /api/v1/owner/stations/:id/intro          { tts | file }  station ident
POST   /api/v1/owner/stations/:id/queue          { query, top }
GET/POST /api/v1/owner/stations/:id/automix      automix + DJ + beatmatch
POST   /api/v1/owner/stations/:id/skip | start | stop | shuffle | reload
DELETE /api/v1/owner/stations/:id/requests[/:rid]
GET    /api/v1/owner/stations/:id/plays
GET/POST/DELETE /api/v1/owner/bans[/:voter]
GET    /api/v1/owner/plugins                     what is in plugins/, and what each one contributed
POST   /api/v1/owner/plugins/rescan              pick up folders added since boot
GET    /api/v1/owner/plugins/:id · PATCH { settings, stations }
POST   /api/v1/owner/plugins/:id/enable | disable | reload
GET    /api/v1/owner/stations/:id/plugins        which plugins apply to this station
POST   /api/v1/owner/stations/:id/plugins/:pid/enable | disable | reset
PATCH  /api/v1/owner/stations/:id/plugins/:pid   { enabled, settings }
PATCH  /api/v1/owner/stations/:id/queue         { order:[ids] } | { from, to } | { next }
GET    /api/v1/owner/stations/:id/say           the canned announcement lines
POST   /api/v1/owner/stations/:id/say           { text | preset, language, when, preview }
GET    /api/v1/owner/stream-errors[?language=vi] what a failed stream says, per language
PATCH  /api/v1/owner/stream-errors               { enabled, strictStatus, followListener, language, messages }
GET    /api/v1/owner/stream-errors/preview?reason=&language=   hear a line
GET    /api/v1/owner/tts · PATCH { language }    the node's voice
POST   /api/v1/owner/tts/preview { text, language }
GET    /api/v1/owner/logs?limit=&level=&scope=   the ring buffer, redacted
GET    /api/v1/owner/store                       schema version, counts, migrations, size
POST   /api/v1/owner/store/backup | vacuum | checkpoint
```

Plugin routes live under `/api/v1/x/<plugin-id>/…` so they can never collide with a core route — the
shipped ones are `/api/v1/x/console/` and `/api/v1/x/now-playing[/text]`.

With no key configured the node runs in open mode — fine on a laptop, not on the internet.

## Station config (`server/config.json`)

```jsonc
{
  "id": "lofi",
  "name": "Lofi Lounge",
  "genre": "Lofi / Chillhop",
  "playlists": [                        // any source query
    "scsearch:lofi hip hop chill beats",
    "adsearch:chillhop",
    "iasearch:subject:(chillout) AND collection:(netlabels)"
  ],
  "shuffle": true,          // shuffle on load
  "loop": true,             // endless rotation: finished tracks go back to the tail
  "trackLimit": 40,         // max tracks pulled per playlist entry
  "quality": "high",        // "high" = hi-res re-clone, "normal" = play as resolved
  "allowRequests": true,
  "maxRequests": 40,
  "maxPendingPerUser": 3,
  "requestCooldownMs": 20000,
  "voteSkipRatio": 0.5,
  "bufferAheadMs": 15000,
  "burstMs": 4000,
  "intro": { "tts": "You are listening to Lofi Lounge." },
  "automix": { "crossfadeMs": 6000, "effect": "bass-swap", "beatmatch": true }
}
```

## Environment

| Variable | Meaning |
|---|---|
| `PORT`, `HOST` | where the node (and therefore the console) listens |
| `OWNER_KEY` | owner key; otherwise one is generated into `data/owner.key` on first boot |
| `WEB`, `WEB_DIR` | `0`/`off` serves API only; `WEB_DIR` points at another console build |
| `STORE_FILE` | path of the SQLite database (migrated on boot) |
| `LOG_LEVEL`, `LOG_FILE`, `DEBUG` | level, JSON file sink, and per-scope debug switches (`DEBUG=automix,store`) |
| `PLUGINS`, `PLUGINS_DIR` | `0`/`off` disables the plugin host; `PLUGINS_DIR` points at another folder |
| `TTS_PROVIDER` | `google` (default) or `off` (tone bed only, fully offline) |
| `AUTOMIX`, `AUTOMIX_CROSSFADE_MS`, `AUTOMIX_EFFECT` | default mix behaviour |
| `BEATMATCH` | `0`/`off` keeps the crossfades but stops time-stretching |
| `DJ`, `DJ_NAME`, `DJ_EVERY` | mute the DJ, name it, set how often it talks |
| `SOUNDCLOUD_CLIENT_ID` | pin a client id instead of scraping one |

## Tests

```bash
cd server && npm test        # node --test test/ — 96 tests, ~45 s, no network
```

Everything runs offline against generated audio and temporary folders; `test/helpers.js` boots whole
nodes on port 0, makes MP3 files, and synthesises tones and beat loops so tempo and loudness assertions
have a known right answer.

| File | What it pins down |
|---|---|
| `logger.test.js` | levels, scopes, per-category switches, structured fields, **redaction**, ring buffer, file sink + rotation |
| `store.test.js` | fresh migrate, upgrade from a v2 database, legacy adoption + one-time JSON import, one-vote-per-listener, plugin state, backup/vacuum |
| `plugins.test.js` | discovery of file and folder plugins, error isolation, registration **and revocation** of sources/effects/routes, settings precedence, enable/disable persisted across a reload |
| `audio.test.js` | MP3 frame parsing, ICY round-trip, BS.1770 against the reference sine, cue detection, fade law, filters, ducking, tempo + WSOLA stretch |
| `automix.test.js` | pass-through rules, held audio, **beatmatched seams re-measured after rendering**, loudness clamp, every transition, plugin effects, continuity |
| `sources.test.js` | which provider claims a query, matching, hi-res re-clone, the fallback chain, metadata-only clones |
| `station.test.js` | playlist load, real-time pacing, burst on join, skip, the request line, vote-skip, announcements, the manager |
| `api.test.js` | health/info/setup, the owner key on every door, first-run station creation, a real ICY stream, requests over HTTP, error shapes, plugins/logs/store routes |
| `console.test.js` | the UI as a plugin: same-origin mount, client routes surviving a refresh, missing assets still 404, the API never shadowed, headless when switched off, **and a node that boots with no build at all and picks one up live** |
| `station-plugins.test.js` | per-station scope: inheritance, enforcement at the bus and in `ctx.stations`, layered settings, global plugins refusing to be scoped, persistence across a restart, cleanup on delete |
| `metro.test.js` | the relay engine: native and JavaScript producing identical bytes at every chunk size, handed-out frames staying valid, resync through tags and junk, block mode, a real decode round trip, and a live plugin relay reaching listeners |
| `language.test.js` | speaking in more than one language: tag tidying, `Accept-Language` matching, per-phrase and per-station languages, every shipped translation present, owner edits that touch one language only, and an error voice that still produces audio when the TTS engine throws |
| `sources.test.js` | which provider claims a query, matching, hi-res re-clone, the fallback chain, metadata-only clones, **ranking by relevance rather than bitrate**, one row per recording across providers, and YouTube Music naming a song that another source then plays |
| `smartmix.test.js` | the Rust DSP agreeing with the JavaScript reference on tempo and confidence, a stretch that moves the tempo and keeps the beat, the event loop surviving both, blend lengths that follow the pair and stay inside their bounds, every transition auditioning over HTTP, and MetroDB behaving like better-sqlite3 down to `undefined` → NULL and a transaction that rolls back |
| `memory.test.js` | what survives a restart: a remembered track staying small, resuming only when it is worth it, a station really coming back 18 s into a song, plus the smart queue's seeds, no-repeat rules and refusal to invent music when the sources are useless |
| `plugin-settings.test.js` | self-describing settings: every field type coerced and bounded, good fields surviving a bad one, `null` meaning "default", secrets never leaving the node, node-wide fields refused per station, and every shipped plugin's schema checked for a real type and a readable label |
| `vnnews.test.js` | the news slot: feeds parsed with half-escaped Vietnamese entities, the 17:00–19:00 window in Hanoi time from a server in any zone (including one that wraps past midnight), one bulletin per slot, a script a newsreader could read, outlets interleaved, a dead feed surviving, owner-only "read it now", and the voice worker — chunking, writing into the cache the engine reads, and surviving a hung provider, a failing provider, no engine at all and oversized text without ever silencing the bulletin |
| `studio.test.js` | what the console drives: a drag becomes one atomic reorder that cannot lose a track, announcements by preset and by hand in any language, LRC → TTML with word spans that tile each line, and lyrics that are fetched once, cached, and never break a station |
| `transcode.test.js` | anything → MP3: sniffing, MP3 passed through untouched, AAC and MPEG-TS transcoded identically one-shot and chunk-by-chunk, playlist parsing, a live HLS server followed without repeats, and the encoder round trip |

Writing them found four real bugs, which are fixed: request payloads echoed the media URL back to
listeners, protected routes fell open when an owner key was set but the legacy password was not, invalid
JSON bodies answered `500`, and the tempo estimator could lock onto a spurious autocorrelation peak.

## Notes

* Respect the terms of every provider and the rights of uploaders — rebroadcasting third-party audio
  publicly, and taking listener requests for it, may require licences. This project is the plumbing, not
  a licence.
* Requests are public by design. Behind a real domain, put a rate limiter or captcha in front of
  `POST …/request`.
* MP3 in, MP3 out: sources that aren't MP3 (e.g. AAC-only uploads) are skipped rather than transcoded,
  which is what keeps the node this small.
* The only place audio is decoded is the automix seam — a few seconds per track change.

MIT licensed. Written from scratch; inspired by, not copied from, Lavalink/NodeLink's source-manager
architecture.
