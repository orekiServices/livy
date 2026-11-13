/**
 * The HTTP surface, driven the way a browser and a radio player drive it:
 * a real node on a real socket, real fetches, a real ICY stream.
 *
 * Two rules are load-bearing here and are asserted everywhere: the owner key
 * gates every owner route, and nothing a listener can read may contain a
 * filesystem path, an upstream URL, an env var or the key itself.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { parseIcyMetadata } from '../src/util/icyClient.js'
import { probeMp3 } from '../src/util/mp3.js'
import { quietLogs, tmpdir, makeMedia, boot, api, waitFor } from './helpers.js'

quietLogs()

const KEY = 'test-owner-key'

/** Boot a node with a media folder and (optionally) a station already on air. */
async function node(t, { stations = [], owner = KEY, ...overrides } = {}) {
  const dir = tmpdir('api-')
  const mediaDir = path.join(dir, 'media')
  makeMedia(mediaDir, { count: 2, ms: 4000 })

  const server = await boot({
    _dir: dir,
    owner: { key: owner, name: 'tester' },
    sources: { mediaDir },
    // Tests are read in real time, so two things decide how long this file
    // takes: the ICY metadata interval (4 KB is a quarter second of audio)
    // and the automix, which holds a crossfade's worth of audio back before
    // it airs anything. The automix has its own test file; here it is off.
    relay: { metaint: 4000 },
    stationDefaults: { automix: { enabled: false } },
    // `stations` may be a function so a test can point a playlist at the
    // media folder this node just created.
    stations: typeof stations === 'function' ? stations(mediaDir) : stations,
    ...overrides
  })
  t.after(() => server.close())
  return { ...server, base: `http://127.0.0.1:${server.port}`, dir, mediaDir }
}

const leaks = (payload, { dir, key }) => {
  const text = JSON.stringify(payload)
  return [dir && text.includes(dir) ? 'filesystem path' : null, key && text.includes(key) ? 'owner key' : null].filter(Boolean)
}

test('a fresh node is healthy, empty and asks to be set up', async (t) => {
  const { base, dir } = await node(t)

  const health = await api(base, '/health')
  assert.equal(health._status, 200)
  assert.equal(health.status, 'ok')
  assert.equal(health.stations, 0)

  const info = await api(base, '/api/v1/info')
  assert.equal(info.name, 'livy')
  assert.match(info.version, /^\d+\.\d+\.\d+$/)
  assert.equal(info.stations, 0)
  assert.deepEqual(info.setup, { needed: true, protected: true }, 'a fresh install starts with no stations')
  assert.ok(info.sources.includes('soundcloud'), 'SoundCloud is there…')
  assert.ok(info.sources.includes('songlink'), '…and the Song.link resolver joins it')
  assert.equal(info.defaultSearch, 'local', '…and the default search provider is configurable')
  assert.deepEqual(info.legacyNames, ['nodecast'], 'an upgraded console can still recognise this node')
  assert.ok(info.transitions.includes('crossfade'))

  const setup = await api(base, '/api/v1/setup')
  assert.equal(setup.configured, false)
  assert.equal(setup.owner, false, 'without a key you are not the owner')

  // Every provider describes itself, so a console can render the list without
  // knowing anything about how a source is built.
  const described = await api(base, '/api/v1/sources')
  const soundcloud = described.sources.find((source) => source.name === 'soundcloud')
  assert.ok(soundcloud, 'SoundCloud is described')
  assert.equal(soundcloud.metadataOnly, false)
  assert.equal(soundcloud.canSearch, true)
  assert.deepEqual(described.sources.find((source) => source.name === 'deezer').metadataOnly, true)
  assert.deepEqual(leaks({ health, info, setup }, { dir, key: KEY }), [], 'public payloads leak nothing')
  assert.equal(JSON.stringify({ info, setup }).includes('/home/'), false, 'and no absolute paths at all')
})

test('the owner key gates the control plane, by header, bearer or query', async (t) => {
  const { base } = await node(t)

  const anonymous = await api(base, '/api/v1/owner')
  assert.equal(anonymous._status, 401)
  assert.match(anonymous.message, /Owner key required/)

  assert.equal((await api(base, '/api/v1/owner/whoami', { key: KEY })).owner, true)
  assert.equal((await api(base, '/api/v1/owner/whoami', { key: 'wrong' }))._status, 401)

  const bearer = await fetch(`${base}/api/v1/owner/whoami`, { headers: { authorization: `Bearer ${KEY}` } })
  assert.equal(bearer.status, 200)
  assert.equal((await api(base, `/api/v1/owner/whoami?key=${KEY}`))._status, 200)

  // Writing to a station is owner-only too.
  assert.equal((await api(base, '/api/v1/owner/stations', { method: 'POST', body: { id: 'x' } }))._status, 401)
})

test('the first-run flow: create a station, and the node stops asking', async (t) => {
  const { base, mediaDir, dir } = await node(t)

  const created = await api(base, '/api/v1/owner/stations', {
    method: 'POST',
    key: KEY,
    body: { name: 'Lo-Fi Nights', genre: 'lofi', playlists: [`local:${mediaDir}`], allowRequests: true }
  })
  assert.equal(created._status, 201)
  assert.equal(created.id, 'lo-fi-nights')
  assert.equal(created.stream, '/stream/lo-fi-nights.mp3', 'the advertised stream URL ends in .mp3')

  assert.equal((await api(base, '/api/v1/info')).setup.needed, false)

  const list = await api(base, '/api/v1/stations')
  assert.equal(list.stations.length, 1)
  assert.equal(list.stations[0].name, 'Lo-Fi Nights')
  assert.deepEqual(leaks(list, { dir, key: KEY }), [], 'the station list keeps the media folder to itself')

  const patched = await api(base, '/api/v1/owner/stations/lo-fi-nights', { method: 'PATCH', key: KEY, body: { name: 'Lo-Fi Late' } })
  assert.equal(patched.name, 'Lo-Fi Late')

  assert.equal((await api(base, '/api/v1/owner/stations/lo-fi-nights', { method: 'DELETE', key: KEY })).removed, 'lo-fi-nights')
  assert.equal((await api(base, '/api/v1/stations')).stations.length, 0)
  assert.equal((await api(base, '/api/v1/stations/lo-fi-nights'))._status, 404)
})

test('a player gets MP3 audio with ICY metadata end to end', async (t) => {
  const { base, mediaDir } = await node(t, {
    stations: (media) => [{ id: 'lofi', name: 'Lo-Fi Nights', playlists: [`local:${media}`], autoStart: true }]
  })
  await waitFor(async () => (await api(base, '/api/v1/stations/lofi')).state === 'playing', { label: 'on air' })

  const res = await fetch(`${base}/stream/lofi.mp3`, { headers: { 'icy-metadata': '1' } })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'audio/mpeg')
  assert.equal(res.headers.get('icy-name'), 'Lo-Fi Nights')
  const metaint = Number(res.headers.get('icy-metaint'))
  assert.ok(metaint > 0, 'the player is told how to find the metadata')
  assert.equal(res.headers.get('accept-ranges'), 'none', 'a live stream is not seekable')

  // Read enough for at least one metadata block, then de-interleave by hand.
  const reader = res.body.getReader()
  const chunks = []
  let read = 0
  while (read < metaint * 2 + 1024) {
    const { value, done } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value))
    read += value.length
  }
  await reader.cancel()
  const body = Buffer.concat(chunks)

  const audio = [body.subarray(0, metaint)]
  let at = metaint
  let title = null
  while (at < body.length) {
    const blocks = body[at]
    const meta = body.subarray(at + 1, at + 1 + blocks * 16)
    if (blocks > 0 && title === null) title = parseIcyMetadata(meta).StreamTitle ?? null
    at += 1 + blocks * 16
    audio.push(body.subarray(at, at + metaint))
    at += metaint
  }

  assert.ok(title, 'the stream announces what is playing')
  assert.match(title, / - /)
  const probe = probeMp3(Buffer.concat(audio))
  assert.ok(probe.frames > 8, `real MP3 frames between the metadata blocks (${probe.frames})`)
  assert.equal(probe.bitrate, 128)

  // A player that does not ask for metadata gets none.
  const plain = await fetch(`${base}/stream/lofi.mp3`)
  assert.equal(plain.headers.get('icy-metaint'), null)
  assert.match(plain.headers.get('content-disposition') ?? '', /filename="lofi\.mp3"/)
  await plain.body.cancel()

  assert.equal((await fetch(`${base}/stream/nope.mp3`)).status, 404)
})

test('/stream/<id>.mp3 is the only stream address, and the rest are spoken 404s', async (t) => {
  const { base } = await node(t, {
    stations: (media) => [{ id: 'lofi', name: 'Lo-Fi Nights', playlists: [`local:${media}`], autoStart: true }]
  })

  // HEAD is how players and link checkers ask "is this really audio?".
  const head = await fetch(`${base}/stream/lofi.mp3`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-type'), 'audio/mpeg')

  // Anything else under /stream is not a stream — including the shapes that
  // used to work, so there is exactly one address to cache, log and support.
  for (const path of ['/stream/lofi', '/stream/lofi.m3u', '/stream/lofi.pls', '/stream/lofi.mp3/extra', '/stream/']) {
    const res = await fetch(`${base}${path}`, { redirect: 'manual' })
    assert.equal(res.status, 404, `${path} is not a stream`)
    assert.equal(res.headers.get('x-livy-error'), 'not_a_stream', `${path} says why`)
    await res.body?.cancel()
  }

  // A player gets the reason as audio it can actually play…
  const missing = await fetch(`${base}/stream/nope.mp3`)
  assert.equal(missing.status, 404)
  assert.equal(missing.headers.get('content-type'), 'audio/mpeg')
  assert.equal(missing.headers.get('x-livy-error'), 'unknown_station')
  const spoken = Buffer.from(await missing.arrayBuffer())
  assert.ok(probeMp3(spoken).frames > 0, 'the 404 body is real, playable MP3')

  // …while anything that asked for JSON still gets JSON.
  const asJson = await fetch(`${base}/stream/nope.mp3`, { headers: { accept: 'application/json' } })
  assert.equal(asJson.status, 404)
  const body = await asJson.json()
  assert.equal(body.code, 'unknown_station')
  assert.equal(body.station, 'nope')
})

test('the owner writes what a failed stream says, and can hear it', async (t) => {
  const { base } = await node(t, {
    stations: (media) => [{ id: 'lofi', name: 'Lo-Fi Nights', playlists: [`local:${media}`], autoStart: false }]
  })

  const defaults = await api(base, '/api/v1/owner/stream-errors', { key: KEY })
  assert.equal(defaults.enabled, true)
  assert.ok(defaults.reasons.includes('unknown-station'))
  assert.ok(defaults.lines['off-air'].length > 10, 'every reason has a line')
  assert.equal(defaults.status['off-air'], 503)
  assert.ok(defaults.languages.includes('vi'), 'the node ships more than English')

  // Owner-only, like every other control.
  assert.equal((await api(base, '/api/v1/owner/stream-errors'))._status, 401)

  const updated = await api(base, '/api/v1/owner/stream-errors', {
    method: 'PATCH',
    key: KEY,
    body: { messages: { 'unknown-station': 'No such station: {station}. Try again.' }, repeat: 2 }
  })
  assert.equal(updated.repeat, 2)
  assert.equal(updated.messages.en['unknown-station'], 'No such station: {station}. Try again.')

  const after = await api(base, '/api/v1/owner/stream-errors', { key: KEY })
  assert.equal(after.lines['unknown-station'], 'No such station: {station}. Try again.', 'the editor gets the template back')
  assert.match(after.example, /Example FM|station/, 'and a rendered example to preview')
  assert.equal(after.lines['off-air'], defaults.lines['off-air'], 'the other lines are untouched')

  // The owner can listen to a line before a listener ever hears it.
  const preview = await fetch(`${base}/api/v1/owner/stream-errors/preview?reason=unknown-station&station=Test%20FM`, {
    headers: { 'x-owner-key': KEY }
  })
  assert.equal(preview.status, 200)
  assert.equal(preview.headers.get('content-type'), 'audio/mpeg')
  assert.ok(probeMp3(Buffer.from(await preview.arrayBuffer())).frames > 0, 'a real clip')

  // A station that exists but has never gone on air says so, out loud,
  // instead of holding the socket open and playing nothing.
  const offAir = await fetch(`${base}/stream/lofi.mp3`)
  assert.equal(offAir.status, 503)
  assert.equal(offAir.headers.get('x-livy-error'), 'off_air')
  assert.equal(offAir.headers.get('content-type'), 'audio/mpeg')
  await offAir.arrayBuffer()

  // Switched off, every failure is an ordinary JSON error again.
  await api(base, '/api/v1/owner/stream-errors', { method: 'PATCH', key: KEY, body: { enabled: false } })
  const silent = await fetch(`${base}/stream/nope.mp3`)
  assert.equal(silent.status, 404)
  assert.match(silent.headers.get('content-type') ?? '', /application\/json/)
  await silent.arrayBuffer()
})

test('a listener is answered in their own language', async (t) => {
  const { base } = await node(t, {
    stations: (media) => [{ id: 'lofi', name: 'Lo-Fi Nights', playlists: [`local:${media}`], autoStart: true }]
  })

  // What the node can say, without needing the owner key.
  const voices = await api(base, '/api/v1/tts')
  assert.equal(voices.language, 'en')
  assert.ok(voices.languages.length > 10, 'a real list of languages')
  assert.ok(voices.errorLanguages.includes('ja'), 'including ones nobody configured')

  // Accept-Language decides which translation is spoken.
  const vietnamese = await fetch(`${base}/stream/nope.mp3`, { headers: { 'accept-language': 'vi-VN,vi;q=0.9,en;q=0.5' } })
  assert.equal(vietnamese.status, 404)
  assert.equal(vietnamese.headers.get('content-language'), 'vi')
  await vietnamese.arrayBuffer()

  const japanese = await fetch(`${base}/stream/nope.mp3`, { headers: { 'accept-language': 'ja' } })
  assert.equal(japanese.headers.get('content-language'), 'ja')
  await japanese.arrayBuffer()

  // A language nobody translated falls back to the node's own.
  const icelandic = await fetch(`${base}/stream/nope.mp3`, { headers: { 'accept-language': 'is-IS' } })
  assert.equal(icelandic.headers.get('content-language'), 'en')
  await icelandic.arrayBuffer()

  // The owner writes a line in one language without touching the others.
  await api(base, '/api/v1/owner/stream-errors', {
    method: 'PATCH',
    key: KEY,
    body: { language: 'vi', messages: { 'unknown-station': 'Không có kênh {station} ở đây.' } }
  })
  const edited = await api(base, '/api/v1/owner/stream-errors?language=vi', { key: KEY })
  assert.equal(edited.editing, 'vi')
  assert.equal(edited.lines['unknown-station'], 'Không có kênh {station} ở đây.')
  assert.match(edited.lines['off-air'], /không phát sóng/, 'the shipped Vietnamese lines are still there')

  const english = await api(base, '/api/v1/owner/stream-errors?language=en', { key: KEY })
  assert.match(english.lines['unknown-station'], /no station called/i, 'English is untouched')

  // And the default language can be moved for the whole node.
  const moved = await api(base, '/api/v1/owner/stream-errors', { method: 'PATCH', key: KEY, body: { language: 'vi' } })
  assert.equal(moved.language, 'vi')
  const noHeader = await fetch(`${base}/stream/nope.mp3`)
  assert.equal(noHeader.headers.get('content-language'), 'vi', 'a player that asks for nothing gets the default')
  await noHeader.arrayBuffer()

  // Following the listener can be switched off entirely.
  await api(base, '/api/v1/owner/stream-errors', { method: 'PATCH', key: KEY, body: { followListener: false } })
  const forced = await fetch(`${base}/stream/nope.mp3`, { headers: { 'accept-language': 'ja' } })
  assert.equal(forced.headers.get('content-language'), 'vi', 'the owner overrules the player')
  await forced.arrayBuffer()
})

test('listeners can request, vote and vote-skip over HTTP', async (t) => {
  const { base, mediaDir, dir } = await node(t, {
    stations: (media) => [
      { id: 'lofi', name: 'Lo-Fi', playlists: [`local:${media}`], allowRequests: true, requestCooldownMs: 0, autoStart: true }
    ]
  })
  await waitFor(async () => (await api(base, '/api/v1/stations/lofi')).state === 'playing', { label: 'on air' })

  const queue = await api(base, '/api/v1/stations/lofi/queue')
  assert.ok(queue.queue.length >= 1)
  assert.equal(queue.queue[0].url, undefined, 'the public queue has no media URLs')

  const file = path.join(mediaDir, 'Test Artist - Track 2.mp3')
  const made = await api(base, '/api/v1/stations/lofi/request', { method: 'POST', body: { query: `local:${file}`, by: 'ana' } })
  assert.equal(made._status, 200)
  assert.equal(made.request.by, 'ana')
  assert.equal(made.position, 1)
  assert.deepEqual(leaks(made, { dir, key: KEY }), [], 'not even the request that named a file echoes the path back')

  const line = await api(base, '/api/v1/stations/lofi/requests')
  assert.equal(line.requests.length, 1)

  const vote = await api(base, `/api/v1/stations/lofi/requests/${made.request.id}/vote`, { method: 'POST', body: { by: 'ben' } })
  assert.equal(vote._status, 200)
  assert.equal(vote.request.votes, 2)

  const skip = await api(base, '/api/v1/stations/lofi/voteskip', { method: 'POST', body: { by: 'ana' } })
  assert.equal(skip._status, 200)
  assert.equal(typeof skip.needed, 'number')

  // Deleting someone's request is an owner action.
  assert.equal((await api(base, `/api/v1/stations/lofi/requests/${made.request.id}`, { method: 'DELETE' }))._status, 401)
  assert.equal((await api(base, `/api/v1/stations/lofi/requests/${made.request.id}`, { method: 'DELETE', key: KEY }))._status, 200)
})

test('owner controls drive a live station', async (t) => {
  const { base } = await node(t, {
    stations: (media) => [{ id: 'lofi', name: 'Lo-Fi', playlists: [`local:${media}`], autoStart: true }]
  })
  await waitFor(async () => (await api(base, '/api/v1/stations/lofi')).state === 'playing', { label: 'on air' })

  assert.equal((await api(base, '/api/v1/stations/lofi/skip', { method: 'POST', key: KEY })).skipped, true)
  assert.ok((await api(base, '/api/v1/stations/lofi/shuffle', { method: 'POST', key: KEY })).shuffled >= 0)
  assert.equal((await api(base, '/api/v1/stations/lofi/stop', { method: 'POST', key: KEY })).state, 'stopped')
  assert.equal((await api(base, '/api/v1/stations/lofi/start', { method: 'POST', key: KEY }))._status, 200)

  // The automix can be re-styled while the station is live.
  const automix = await api(base, '/api/v1/owner/stations/lofi/automix', {
    method: 'POST',
    key: KEY,
    body: { enabled: true, effect: 'filter', crossfadeMs: 4000 }
  })
  assert.equal(automix.effect, 'filter')
  assert.equal(automix.crossfadeMs, 4000)

  const bad = await api(base, '/api/v1/owner/stations/lofi/automix', { method: 'POST', key: KEY, body: { effect: 'nope' } })
  assert.equal(bad._status, 400)
  assert.match(bad.message, /Unknown transition/)
  assert.equal((await api(base, '/api/v1/owner/stations/lofi/automix', { key: KEY })).effect, 'filter', 'the bad change was not applied')
})

test('errors are useful to the caller and silent about the inside', async (t) => {
  const { base, dir } = await node(t)

  const unknownRoute = await api(base, '/api/v1/nope')
  assert.equal(unknownRoute._status, 404)
  assert.equal(unknownRoute.message, 'Unknown API route')

  const unknownStation = await api(base, '/api/v1/stations/ghost')
  assert.equal(unknownStation._status, 404)

  const emptySearch = await api(base, '/api/v1/search')
  assert.equal(emptySearch._status, 400)

  const badJson = await fetch(`${base}/api/v1/owner/stations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-owner-key': KEY },
    body: '{not json'
  })
  assert.ok(badJson.status >= 400 && badJson.status < 500, `a broken body is the caller's fault (${badJson.status})`)
  const text = await badJson.text()
  assert.ok(!text.includes(dir) && !text.includes('at Object.'), 'no stack traces, no paths')

  // CORS preflight is answered without handing out anything.
  const preflight = await fetch(`${base}/api/v1/info`, { method: 'OPTIONS' })
  assert.equal(preflight.status, 204)
  assert.ok(preflight.headers.get('access-control-allow-methods').includes('PATCH'))
})

test('the plugin, log and store control planes are wired to the real thing', async (t) => {
  const dir = tmpdir('api-full-')
  const mediaDir = path.join(dir, 'media')
  makeMedia(mediaDir, { count: 1, ms: 2000 })

  const server = await boot({
    _dir: dir,
    owner: { key: KEY },
    sources: { mediaDir },
    store: { enabled: true, file: path.join(dir, 'livy.db'), migrate: true },
    plugins: { enabled: true, dir: path.join(process.cwd(), 'plugins') },
    logging: { level: 'info', color: false, buffer: 200, file: { enabled: false } }
  })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.port}`

  const plugins = await api(base, '/api/v1/owner/plugins', { key: KEY })
  assert.equal(plugins.dir, 'plugins/', 'the owner sees the folder name, not the server path')
  assert.ok(plugins.plugins.length >= 3, 'the bundled plugins were discovered')
  const ident = plugins.plugins.find((p) => p.id === 'hourly-ident')
  assert.equal(ident.status, 'disabled', 'a plugin can ship switched off')

  const enabled = await api(base, '/api/v1/owner/plugins/hourly-ident/enable', { method: 'POST', key: KEY })
  assert.equal(enabled._status, 200)
  assert.equal((await api(base, '/api/v1/owner/plugins', { key: KEY })).plugins.find((p) => p.id === 'hourly-ident').status, 'ready')
  await api(base, '/api/v1/owner/plugins/hourly-ident/disable', { method: 'POST', key: KEY })

  // A plugin route is served under /api/v1/x/ and is not owner-gated.
  const nowPlaying = await api(base, '/api/v1/x/now-playing/')
  assert.equal(nowPlaying._status, 200)

  const logs = await api(base, '/api/v1/owner/logs?limit=20', { key: KEY })
  assert.equal(logs._status, 200)
  assert.equal(logs.logging.level, 'info')
  assert.ok(Array.isArray(logs.lines) && logs.lines.length > 0, 'the ring buffer is readable from the console')
  assert.ok(logs.lines.every((line) => typeof line.scope === 'string' && typeof line.level === 'string'))
  assert.ok(!JSON.stringify(logs).includes(KEY), 'the owner key is redacted out of the log')

  const store = await api(base, '/api/v1/owner/store', { key: KEY })
  assert.match(store.driver, /sqlite/, 'the node is on SQLite, whichever binding it found')
  assert.equal(store.file, 'livy.db', 'only the basename is exposed')
  assert.ok(store.schema >= 1, 'the schema version is reported')
  assert.ok(Array.isArray(store.migrations) && store.migrations.length >= 1, 'so is the migration history')
  assert.ok(store.tables.includes('stations') && store.tables.includes('plugins'))

  const backup = await api(base, '/api/v1/owner/store/backup', { method: 'POST', key: KEY })
  assert.match(backup.backup, /^livy\.db\.backup-/, 'a dated copy, named after the database')
  assert.equal((await api(base, '/api/v1/owner/store/vacuum', { method: 'POST', key: KEY }))._status, 200)

  // All of it is owner-only.
  for (const route of ['/api/v1/owner/plugins', '/api/v1/owner/logs', '/api/v1/owner/store']) {
    assert.equal((await api(base, route))._status, 401, `${route} must be gated`)
  }
})
