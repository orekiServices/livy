# Nodecast plugins

Everything in this folder is loaded at boot. A plugin can add a **music source**, a **transition**, an
**HTTP endpoint**, or simply react to what the stations are doing — without touching the node's source.

```
plugins/
  now-playing/          folder plugin
    plugin.json         metadata (name, version, main, enabled, settings)
    index.js
  backspin.js           single-file plugin
```

## Shape

```js
export const manifest = { name: 'My Plugin', version: '1.0.0', description: 'what it does' }

export default function setup(ctx) {
  ctx.log.info('hello from a plugin')

  ctx.on('track', ({ station, data }) => {
    ctx.log.info(`${station.id} is playing ${data.track.title}`)
  })

  return () => {
    /* optional teardown — called on disable/reload */
  }
}
```

`setup` may be async and may return a teardown function. If it throws, the plugin is marked `error` and
the node carries on broadcasting.

## Context

| | |
|---|---|
| `ctx.id` `ctx.name` `ctx.version` `ctx.dir` | identity and the plugin's own folder |
| `ctx.log` | scoped logger (`plugin:<id>`), obeys `logging.debug.plugins` |
| `ctx.settings` / `ctx.saveSettings({…})` | per-plugin settings, persisted in SQLite |
| `ctx.config` | safe view of the node config — no keys, no passwords, no paths |
| `ctx.stations.list() / .get(id) / .all()` | read state, or drive a station directly — **scoped**: only the stations this plugin applies to |
| `ctx.stations.every()` | every station on the node, scope ignored (use sparingly) |
| `ctx.stations.applies(id)` | is this plugin on for that station? |
| `ctx.stations.settings(id)` | plugin settings with that station's overrides layered on top |
| `ctx.stations.onScopeChange(fn)` | you were just switched on/off for a station |
| `ctx.store` | the SQLite store (plays, requests, settings…) |
| `ctx.resolve(q)` / `ctx.search(q, limit, provider)` | the full source registry |
| `ctx.on(event, fn)` | `state · track · queue · listeners · requests · voteskip · announcement · automix · added · removed · updated` |
| `ctx.every(ms, fn)` | interval that is cleared automatically on unload |
| `ctx.relay(stationId, input, options)` | put a live MP3 feed on air through **MetroS** — see below |
| `ctx.registerSource(provider)` | `{ name, prefixes, canResolve, resolve, search?, stream? }` |
| `ctx.registerEffect(name, renderer)` | a new automix transition |
| `ctx.registerRoute(method, path, handler)` | served at `/api/v1/x/<plugin-id><path>`; supports `:params` and a trailing `*` |
| `ctx.registerStatic(dir, { mount, spa, index, optional, fallback })` | serve a folder on the node's own port — this is how a plugin ships a web app. Returns a handle: `setDir()`, `serving()`, `remove()` |
| `ctx.isOwner(req, url)` | is this request carrying the owner key? Guard every write with it |

A route handler is called with one object:

```js
ctx.registerRoute('GET', '/channel/:id', ({ res, send, fail, params, owner, sendFile }) =>
  owner ? send(res, 200, detail(params.id)) : fail(res, 401, 'Owner key required')
)
```

Static mounts are consulted **before** the node's own static handler and are longest-prefix first, so a
plugin can take `/` (the console does) or a corner of it. `spa: true` answers extension-less paths with
the mount's `index.html`, so client-side routes survive a hard refresh while a missing asset still 404s.

Everything registered through the context is removed again when the plugin is disabled or reloaded —
including static mounts, which is what makes the UI genuinely optional.

## Scope: node-wide or per station

A plugin is loaded once per process, but it does not have to apply to every station. Say which in the
manifest:

```json
{ "name": "Hourly ident", "scope": "stations" }   /* default — switchable per station */
{ "name": "Web console",  "scope": "global"   }   /* node-wide; per-station toggles are refused */
```

The owner then switches it per station from the console or the API, and the **host enforces it**: a
station you are switched off for is missing from `ctx.stations`, and its events never reach your
handlers. You do not have to write a single `if`.

```js
export const manifest = { name: 'Shoutout', version: '1.0.0', scope: 'stations' }

export default function setup(ctx) {
  // Only ever fires for stations this plugin is on for.
  ctx.on('track', ({ station, track }) => {
    const { greeting } = ctx.stations.settings(station.id) // per-station settings win
    station.say(`${greeting ?? 'Now playing'}: ${track.title}`)
  })

  ctx.stations.onScopeChange(({ station, enabled }) => ctx.log.info(`${station}: ${enabled ? 'on' : 'off'}`))
}
```

```bash
curl -H "x-owner-key: $KEY" localhost:2333/api/v1/owner/stations/talk/plugins
curl -X POST -H "x-owner-key: $KEY" localhost:2333/api/v1/owner/stations/talk/plugins/hourly-ident/disable
curl -X POST -H "x-owner-key: $KEY" localhost:2333/api/v1/owner/stations/talk/plugins/hourly-ident/reset
```

Choices live in the `station_plugins` table, survive restarts, and are forgotten when the station is
deleted. A station with no row simply follows the plugin's node-wide state.

## Relaying a live stream

`ctx.relay()` is the fast path for "play this feed right now". `input` is a URL — including an HLS
playlist — or anything that yields bytes: an HTTP body, a socket, a child process's stdout, an async
generator.

```js
const relay = ctx.relay('lofi', 'https://stream.example/live.m3u8', { title: 'City FM breakfast' })

relay.stats()          // { codec, passthrough, engine, frames, bytes, dropped, durationMs, … }
await relay.done       // resolves when the feed ends (or stop() is called)
relay.stop('enough')   // hand the station back to its rotation
```

**MetroS** decides what the bytes cost. An MP3 feed is re-framed and forwarded byte for byte — no
decode, no re-encode, so the price per listener is a socket write. AAC, HLS/MPEG-TS, Ogg, FLAC and MP4
are decoded and re-encoded on the way past (which needs the native `libmetro` engine; without it a
non-MP3 relay fails with a clear message rather than airing silence).

The relay takes over the transmitter while it runs (the rotation waits, the automix stands down) and the
station resumes normal programming when the feed ends. Relays are revoked when the plugin unloads, and
a station the plugin is switched off for refuses: `no station "x" for this plugin`.

## Describing your settings

A plugin can declare what its settings *are*, and the node does the rest:
defaults, validation, coercion, per-station overrides, and a form the console
renders without knowing anything about your plugin.

```js
// plugin.json (or `export const manifest` in index.js)
{
  "settings": { "everyMinutes": 30 },
  "settingsSchema": [
    { "key": "everyMinutes", "type": "integer", "default": 30, "min": 5, "max": 240,
      "unit": "min", "label": "A bulletin every",
      "help": "Bulletins land on the grid from the start time." },
    { "key": "feeds", "type": "list", "of": "url", "max": 24, "label": "RSS feeds" },
    { "key": "timezone", "type": "timezone", "default": "Asia/Ho_Chi_Minh" },
    { "key": "worker", "type": "boolean", "default": true, "perStation": false, "advanced": true }
  ]
}
```

| Type | Accepts | Rendered as |
|---|---|---|
| `string` · `text` | text (`maxLength`, `placeholder`) | input · textarea |
| `integer` · `number` | numbers (`min`, `max`, `step`, `unit`) | slider when bounded, box otherwise |
| `boolean` | `true`/`false`, `"true"`, `1` | switch |
| `select` | one of `options` | menu |
| `list` | an array, or one per line (`of`, `max`) | textarea |
| `time` | `17:00` (normalised from `9:05`) | time picker |
| `url` | http(s) only | input |
| `language` | BCP-47 (`vi`, `pt-BR`) | input |
| `timezone` | IANA, checked against the runtime | input |

Field flags: `label`, `help`, `unit`, `advanced` (folded away by default),
`secret` (never sent back to the browser), `perStation: false` (node-wide —
the API refuses to set it for one station).

What you get for declaring it:

* `ctx.settings` is already coerced — no `Number(settings.x) || 30` dances,
  and a value that no longer validates falls back to its default with a
  warning instead of reaching your code;
* `PATCH /api/v1/owner/plugins/:id` answers `400` with *which field and why*
  (`A bulletin every: must be at most 240`) and saves nothing;
* `GET /api/v1/owner/plugins/:id/schema[?station=lofi]` returns the form and
  the values that apply there;
* the console's **Plugins** panel renders it — sliders with units, time
  pickers, one-per-line lists — for a plugin you wrote this morning.

No schema? Everything still works exactly as before, and the console falls
back to a JSON box.

## Managing them

From the owner console (**Plugins** panel) or the API:

```bash
curl -H "x-owner-key: $KEY" localhost:2333/api/v1/owner/plugins
curl -X POST -H "x-owner-key: $KEY" localhost:2333/api/v1/owner/plugins/now-playing/disable
curl -X POST -H "x-owner-key: $KEY" localhost:2333/api/v1/owner/plugins/backspin/reload
curl -X POST -H "x-owner-key: $KEY" localhost:2333/api/v1/owner/plugins/rescan     # pick up new folders
curl -X PATCH -H "x-owner-key: $KEY" -H 'content-type: application/json' \
     -d '{"settings":{"webhook":"https://example.com/hook"}}' \
     localhost:2333/api/v1/owner/plugins/now-playing
```

Enabled/disabled state and settings live in the `plugins` table, so they survive restarts and upgrades.
A plugin that ships with `"enabled": false` in its manifest stays off until someone turns it on.

## Shipped examples

| Plugin | Shows off |
|---|---|
| `console` | `registerStatic` — the whole Next.js console, mounted at `/`; `scope: global`, boots even with no build and mounts one the moment it appears |
| `now-playing` | events, settings, a public route, writing a file for OBS / a website |
| `backspin` | `registerEffect` — a real DJ backspin transition built on the mix context |
| `hourly-ident` | `every()` + speaking on air; ships **disabled** |
| `live-relay` | `ctx.relay()` — a live feed on air through MetroS, with reconnect, owner-gated routes and a scope-aware stop; ships **disabled** |
| `vnnews` | a scheduled, multilingual, RSS-driven news slot: Vietnamese bulletins 17:00–19:00 Hanoi time (or every N songs) from VnExpress and friends, voiced in a worker thread over a ducked music bed; ships **disabled** |
