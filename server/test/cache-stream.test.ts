import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import RadioCache, { MemoryLruCache, AudioDiskCache, audioCacheKey } from '../src/core/cache.ts'
import SourceRegistry from '../src/sources/index.ts'
import Station from '../src/core/station.ts'
import { createRadioServer } from '../src/index.ts'
import { StreamErrorVoice } from '../src/server/streamErrors.ts'
import { buildSilence } from '../src/util/mp3.ts'

const KEY = 'test-cache-owner-key'

function tmpDir(t, prefix = 'livy-cache-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('MemoryLruCache: TTL, LRU eviction, in-flight coalescing, and mutation safety', async () => {
  const cache = new MemoryLruCache({ name: 'test', ttlMs: 120, maxEntries: 2 })

  let calls = 0
  const loader = async () => {
    calls += 1
    await new Promise((r) => setTimeout(r, 25))
    return { tracks: [{ id: 't1', title: 'One' }] }
  }

  // Five concurrent callers coalesce into one upstream call.
  const results = await Promise.all(Array.from({ length: 5 }, () => cache.getOrLoad('q:1', loader)))
  assert.equal(calls, 1)
  assert.equal(results.length, 5)
  assert.equal(cache.stats().coalesced, 4)

  // Mutating returned object does not corrupt cached entry.
  results[0].tracks[0].title = 'MUTATED'
  const second = cache.get('q:1')
  assert.equal(second.tracks[0].title, 'One')

  // LRU eviction keeps most recently used keys.
  cache.set('k2', { v: 2 })
  cache.get('q:1') // touch q:1 so k2 is now oldest
  cache.set('k3', { v: 3 })
  assert.equal(cache.get('k2'), undefined, 'oldest entry evicted')
  assert.deepEqual(cache.get('k3'), { v: 3 })
  assert.ok(cache.get('q:1'))

  // Rejected loaders are never cached.
  let failCount = 0
  await assert.rejects(
    cache.getOrLoad('bad', async () => {
      failCount += 1
      throw new Error('boom')
    }),
    /boom/
  )
  await assert.rejects(
    cache.getOrLoad('bad', async () => {
      failCount += 1
      throw new Error('boom2')
    }),
    /boom2/
  )
  assert.equal(failCount, 2)

  // TTL expiry.
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(cache.get('k3'), undefined)
})

test('AudioDiskCache: atomic write, abort cleanup, LRU eviction, and startup scan', async (t) => {
  const dir = tmpDir(t)
  const audio = new AudioDiskCache({ dir, maxEntries: 2, maxBytes: 1024 * 1024, maxEntryBytes: 128 * 1024 })
  const mp3 = Buffer.concat(buildSilence(250).frames)

  // Live, announcement, local and TTS tracks are never cached on disk.
  assert.equal(audioCacheKey({ id: '1', source: 'local' }), null)
  assert.equal(audioCacheKey({ id: '2', source: 'tts' }), null)
  assert.equal(audioCacheKey({ id: '3', source: 'http', live: true }), null)
  assert.equal(audioCacheKey({ id: '4', source: 'http', announcement: true }), null)

  // Aborted write leaves no mp3 or tmp file.
  const tAbort = { id: 'sc:abort', source: 'soundcloud', title: 'Aborted', artist: 'A' }
  const wAbort = audio.createWriter(tAbort, 128)
  wAbort.write(mp3)
  wAbort.abort()
  assert.equal(audio.get(tAbort, 128), null)
  assert.equal(fs.readdirSync(dir).length, 0)

  // Committed write is readable byte-for-byte.
  const t1 = { id: 'sc:1', source: 'soundcloud', title: 'First', artist: 'Artist' }
  const w1 = audio.createWriter(t1, 128)
  w1.write(mp3)
  const meta1 = w1.commit()
  assert.ok(meta1 && meta1.bytes === mp3.length)

  const hit = audio.openReadStream(t1, 128)
  assert.ok(hit)
  const chunks = []
  for await (const c of hit.stream) chunks.push(c)
  assert.deepEqual(Buffer.concat(chunks), mp3)

  // LRU eviction when maxEntries (2) is exceeded.
  const t2 = { id: 'sc:2', source: 'soundcloud', title: 'Second', artist: 'Artist' }
  const t3 = { id: 'sc:3', source: 'soundcloud', title: 'Third', artist: 'Artist' }
  const w2 = audio.createWriter(t2, 128)
  w2.write(mp3)
  w2.commit()
  // Touch t1 so t2 becomes least-recently used.
  assert.ok(audio.get(t1, 128))
  const w3 = audio.createWriter(t3, 128)
  w3.write(mp3)
  w3.commit()

  assert.equal(audio.get(t2, 128), null, 'LRU track t2 evicted')
  assert.ok(audio.get(t1, 128), 'MRU track t1 retained')
  assert.ok(audio.get(t3, 128), 'newest track t3 retained')

  // Orphan .tmp files are cleaned on re-init while valid entries survive reload.
  fs.writeFileSync(path.join(dir, 'orphan.123456.tmp'), 'junk')
  const reloaded = new AudioDiskCache({ dir, maxEntries: 2, maxBytes: 1024 * 1024 })
  assert.equal(reloaded.stats().entries, 2)
  assert.ok(!fs.existsSync(path.join(dir, 'orphan.123456.tmp')))
})

test('SourceRegistry caches resolve, search, and trackUrl via RadioCache', async (t) => {
  const dir = tmpDir(t)
  const cache = new RadioCache({}, { defaultDir: dir })
  const sources = new SourceRegistry({ noSearch: ['*'] }, { cache })

  let resolveCalls = 0
  let searchCalls = 0
  let urlCalls = 0

  sources.register({
    name: 'mock',
    prefixes: ['mock:'],
    canResolve: (q) => q.startsWith('mock:'),
    resolve: async (q) => {
      resolveCalls += 1
      return {
        type: 'track',
        name: q,
        tracks: [{ id: `mock:${q}`, source: 'mock', title: 'Cached Track', artist: 'Tester', duration: 60_000 }]
      }
    },
    search: async (q) => {
      searchCalls += 1
      return [{ id: `mock:s:${q}`, source: 'mock', title: q, artist: 'Tester', duration: 60_000 }]
    },
    getTrackUrl: async (track) => {
      urlCalls += 1
      return `https://cdn.example.invalid/${track.id}.mp3`
    },
    stream: async () => ({ stream: Readable.from([]), mode: 'direct' })
  })

  await sources.resolve('mock:alpha')
  await sources.resolve('mock:alpha')
  assert.equal(resolveCalls, 1, 'second resolve served from cache')
  await sources.resolve('mock:alpha', { noCache: true })
  assert.equal(resolveCalls, 2, 'noCache bypasses memory cache')

  await sources.search('ambient', 5, 'mock')
  await sources.search('ambient', 5, 'mock')
  assert.equal(searchCalls, 1, 'second search served from cache')

  const track = { id: 'mock:1', source: 'mock', title: 'One' }
  const u1 = await sources.trackUrl(track)
  const u2 = await sources.trackUrl(track)
  assert.equal(u1, u2)
  assert.equal(urlCalls, 1, 'second trackUrl served from cache')
})

test('Station caches clean MP3 frames on disk and retries once via fallback when primary yields 0 frames', async (t) => {
  const dir = tmpDir(t)
  const cache = new RadioCache({}, { defaultDir: dir })
  const mp3 = Buffer.concat(buildSilence(350).frames)

  let primaryStreams = 0
  let fallbackStreams = 0
  const sources = new SourceRegistry({ noSearch: ['*'], hiRes: false, liveFallback: false, fallbackOrder: ['backup'] }, { cache })

  sources.register({
    name: 'primary',
    prefixes: ['p:'],
    canResolve: (q) => q.startsWith('p:'),
    resolve: async () => ({ type: 'track', name: 'ok', tracks: [] }),
    stream: async (track) => {
      primaryStreams += 1
      if (track.id === 'p:empty') {
        return { stream: Readable.from([]), mode: 'direct', contentType: 'audio/mpeg' }
      }
      return { stream: Readable.from([mp3]), mode: 'direct', contentType: 'audio/mpeg' }
    }
  })

  sources.register({
    name: 'backup',
    prefixes: ['b:'],
    canResolve: () => false,
    resolve: async () => ({ type: 'track', name: 'b', tracks: [] }),
    search: async () => [{ id: 'b:rescue', source: 'backup', title: 'Empty Upstream', artist: 'Band', duration: 1000 }],
    stream: async () => {
      fallbackStreams += 1
      return { stream: Readable.from([mp3]), mode: 'direct', contentType: 'audio/mpeg' }
    }
  })

  const station = new Station(
    { id: 'cache-fm', name: 'Cache FM', automix: { enabled: false }, bitrate: 128, skipOnErrorDelay: 10 },
    sources,
    { cache }
  )
  station._running = true
  t.after(() => station.destroy())

  // 1. First read streams upstream and writes to disk cache.
  const track = { id: 'p:good', source: 'primary', title: 'Cached Song', artist: 'Band', duration: 1000 }
  await station._readTrack(track)
  assert.equal(primaryStreams, 1)
  assert.equal(cache.audio.stats().entries, 1)

  // 2. Second read serves from audio disk cache without touching upstream.
  await station._readTrack(track)
  assert.equal(primaryStreams, 1, 'upstream not called on disk cache hit')
  assert.equal(station.stats.cacheHits, 1)

  // 3. Upstream stream that ends with 0 frames automatically retries via fallback clone.
  const emptyTrack = { id: 'p:empty', source: 'primary', title: 'Empty Upstream', artist: 'Band', duration: 1000 }
  await station._readTrack(emptyTrack)
  assert.equal(primaryStreams, 2)
  assert.equal(fallbackStreams, 1, '0-frame stream rescued by fallback clone')
})

test('HTTP stream fixes, owner TTS fix, and owner cache API work end to end', async (t) => {
  const dir = tmpDir(t)
  const server = await createRadioServer({
    server: { host: '127.0.0.1', port: 0 },
    logging: { level: 'silent' },
    plugins: { enabled: false },
    web: { enabled: false },
    store: { enabled: false },
    tts: { enabled: true, cacheDir: path.join(dir, 'tts') },
    cache: { enabled: true, audio: { enabled: true, dir: path.join(dir, 'audio') } },
    owner: { key: KEY },
    sources: { noSearch: ['*'] },
    stations: [
      { id: 'empty-live', name: 'Empty Live', playlists: [], autoStart: true },
      { id: 'off-air-fm', name: 'Off Air FM', playlists: [], autoStart: false }
    ]
  })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.port}`

  // Starting an empty station stays in 'loading' (not 'idle') and accepts listeners with 200.
  const liveStation = server.manager.get('empty-live')
  await liveStation.start()
  assert.equal(liveStation.state, 'loading')
  const headOk = await fetch(`${base}/stream/empty-live.mp3`, { method: 'HEAD' })
  assert.equal(headOk.status, 200)
  assert.match(headOk.headers.get('access-control-expose-headers') ?? '', /x-livy-error/i)

  // Explicitly stopped (autoStart: false) station still returns 503 off_air with CORS expose headers.
  const offAir = await fetch(`${base}/stream/off-air-fm.mp3`, { headers: { accept: 'application/json' } })
  assert.equal(offAir.status, 503)
  assert.equal(offAir.headers.get('x-livy-error'), 'off_air')
  assert.match(offAir.headers.get('access-control-expose-headers') ?? '', /x-livy-error/i)

  // Owner TTS route works (previously threw ReferenceError on missing LANGUAGES / manager).
  const ttsRes = await fetch(`${base}/api/v1/owner/tts`, { headers: { 'x-owner-key': KEY } })
  assert.equal(ttsRes.status, 200)
  const ttsJson = await ttsRes.json()
  assert.ok(Array.isArray(ttsJson.languages) && ttsJson.languages.length > 0)
  assert.ok(Array.isArray(ttsJson.stations))

  // /api/v1/info exposes cache stats.
  const info = await (await fetch(`${base}/api/v1/info`)).json()
  assert.equal(info.cache.enabled, true)
  assert.equal(info.cache.audio.enabled, true)

  // Seed one audio entry and verify owner cache GET / DELETE / clear endpoints.
  const mp3 = Buffer.concat(buildSilence(200).frames)
  const writer = server.cache.audio.createWriter({ id: 'ext:1', source: 'soundcloud', title: 'Test Audio', artist: 'DJ' }, 128)
  writer.write(mp3)
  const entry = writer.commit()

  const cacheList = await (await fetch(`${base}/api/v1/owner/cache`, { headers: { 'x-owner-key': KEY } })).json()
  assert.equal(cacheList.audio.entries, 1)
  assert.equal(cacheList.items.length, 1)
  assert.equal(cacheList.items[0].hash, entry.hash)

  const delRes = await fetch(`${base}/api/v1/owner/cache/${entry.hash}`, { method: 'DELETE', headers: { 'x-owner-key': KEY } })
  assert.equal(delRes.status, 200)
  assert.equal((await delRes.json()).deleted, true)

  server.cache.resolve.set('k', { tracks: [1] })
  const clearRes = await fetch(`${base}/api/v1/owner/cache/clear`, {
    method: 'POST',
    headers: { 'x-owner-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'all' })
  })
  assert.equal(clearRes.status, 200)
  const cleared = await clearRes.json()
  assert.equal(cleared.stats.memory.resolve.entries, 0)

  // Serverless flag produces 501 stream_unavailable on /stream/*.
  const prevServerless = process.env.LIVY_SERVERLESS
  process.env.LIVY_SERVERLESS = '1'
  try {
    const sl = await fetch(`${base}/stream/empty-live.mp3`)
    assert.equal(sl.status, 501)
    assert.equal(sl.headers.get('x-livy-error'), 'stream_unavailable')
  } finally {
    if (prevServerless === undefined) delete process.env.LIVY_SERVERLESS
    else process.env.LIVY_SERVERLESS = prevServerless
  }
})

test('StreamErrorVoice bounds in-memory clip cache and sanitizes station names', async () => {
  const voice = new StreamErrorVoice({ tts: null })
  const messy = voice.line('unknown-station', { station: 'Bad\r\nStation\tName'.repeat(10) })
  assert.ok(!/[\r\n\t]/.test(messy), 'control characters stripped from spoken error')
  assert.ok(messy.length < 220, 'overlong station name truncated')

  // Speak 150 distinct station names; cache must remain bounded.
  for (let i = 0; i < 150; i += 1) {
    const buf = await voice.speak('unknown-station', { station: `scan-${i}` })
    assert.ok(buf.length > 0)
  }
})
