/**
 * Regressions for:
 *  - Complete removal of Radio Paradise (built-in source + Radio Browser auto-fallback)
 *  - Auto source resolution/fallback not ignoring other sources
 *  - Stream errors: connect-only fetch timeout (no mid-song abort under backpressure),
 *    large ID3v2 tags in MetroTranscoder/sniff, Uint8Array chunks, HTTP .pls/.m3u
 *    unwrapping, ICY rest-byte ordering, HEAD JSON error responses, and instant burst lead-in.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { Readable } from 'node:stream'

import { SourceRegistry } from '../src/sources/index.ts'
import RadioBrowserSource, { isRadioParadiseStation } from '../src/sources/radiobrowser.ts'
import HttpSource from '../src/sources/http.ts'
import Station from '../src/core/station.ts'
import { createRadioServer } from '../src/index.ts'
import { fetchWithConnectTimeout, responseToNodeStream } from '../src/util/fetchStream.ts'
import { MetroTranscoder, sniff } from '../src/util/metro.ts'
import { buildSilence, parseFrameHeader, Mp3FrameSplitter } from '../src/util/mp3.ts'
import { connectStream, buildIcyMetadataBlock } from '../src/util/icyClient.ts'
import { quietLogs } from './helpers.ts'

quietLogs()

/* -------------------- Radio Paradise removed -------------------- */

test('Radio Paradise is completely removed from SourceRegistry', () => {
  const sources = new SourceRegistry({ hiRes: false, liveFallback: false })
  assert.equal(sources.get('radioparadise'), undefined)
  assert.ok(!sources.sources.some((s) => s.name === 'radioparadise'))
  assert.ok(!sources.describe().some((d) => d.name === 'radioparadise'))
  assert.ok(!sources.noSearch.has('radioparadise'))
  assert.equal(sources.sources.find((s) => s.canResolve('rp:mellow')), undefined)
  assert.equal(sources.sources.find((s) => s.canResolve('radioparadise:main')), undefined)
})

test('RadioBrowser filters out Radio Paradise stations', async () => {
  assert.equal(isRadioParadiseStation({ name: 'Radio Paradise (320k)', url: 'https://stream.radioparadise.com/mp3-320' }), true)
  assert.equal(isRadioParadiseStation({ name: 'SomaFM Groove Salad', url: 'https://ice1.somafm.com/groovesalad-128-mp3' }), false)

  const prevFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([
        {
          stationuuid: 'rp-1',
          name: 'Radio Paradise - Main Mix',
          url_resolved: 'https://stream.radioparadise.com/mp3-320',
          codec: 'MP3',
          bitrate: 320,
          country: 'US',
          tags: 'eclectic,rock'
        },
        {
          stationuuid: 'ok-1',
          name: 'Chill FM',
          url_resolved: 'https://stream.example.invalid/chill.mp3',
          codec: 'MP3',
          bitrate: 192,
          country: 'DE',
          tags: 'chillout'
        }
      ]),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )) as any

  try {
    const rb = new RadioBrowserSource()
    const hits = await rb.search('chillout', 5, { minBitrate: 128 })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].title, 'Chill FM')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('liveFallback skips Radio Paradise and tries subsequent live candidates when the first fails', async () => {
  const sources = new SourceRegistry({ hiRes: false, liveFallback: true, fallbackOrder: [] })
  sources.radiobrowser.search = async () => [
    { id: 'rb:rp', source: 'radiobrowser', title: 'Radio Paradise', url: 'https://stream.radioparadise.com/mp3-320', bitrate: 320, live: true },
    { id: 'rb:dead', source: 'radiobrowser', title: 'Dead Station', url: 'https://dead.invalid/stream.mp3', bitrate: 256, live: true },
    { id: 'rb:alive', source: 'radiobrowser', title: 'Working FM', url: 'https://alive.invalid/stream.mp3', bitrate: 192, live: true }
  ]

  const attempted: string[] = []
  sources.radiobrowser.stream = async (track) => {
    attempted.push(track.id)
    if (track.id === 'rb:dead') throw new Error('upstream 502')
    return { stream: Readable.from([Buffer.concat(buildSilence(100).frames)]), contentType: 'audio/mpeg', mode: 'icy' }
  }

  sources.register({
    name: 'unit-down',
    prefixes: ['down:'],
    canResolve: () => false,
    resolve: async () => ({ tracks: [] }),
    stream: async () => {
      throw new Error('primary down')
    }
  })

  const opened = await sources.stream({ id: 'd1', source: 'unit-down', title: 'Test Song', artist: 'Artist' })
  assert.deepEqual(attempted, ['rb:dead', 'rb:alive'], 'Radio Paradise skipped, dead candidate failed over to working one')
  assert.equal(opened.track.id, 'rb:alive')
  assert.equal(opened.live, true)
})

/* ---------------- Other sources never ignored ---------------- */

test('resolve falls through to other searchable sources when defaultSearch returns 0 tracks', async () => {
  const sources = new SourceRegistry({ defaultSearch: 'unit-empty', liveFallback: false, hiRes: false })
  sources.noSearch = new Set(sources.sources.map((s) => s.name))

  sources.register({
    name: 'unit-empty',
    prefixes: ['ue:'],
    canResolve: () => false,
    resolve: async () => ({ type: 'search', name: 'empty', tracks: [] }),
    search: async () => [],
    stream: async () => ({ stream: Readable.from([]), contentType: 'audio/mpeg', mode: 'unit-empty' })
  })
  sources.register({
    name: 'unit-other',
    prefixes: ['uo:'],
    canResolve: () => false,
    resolve: async () => ({ type: 'search', name: 'other', tracks: [] }),
    search: async () => [{ id: 'uo:1', source: 'unit-other', title: 'Midnight', artist: 'Linh', bitrate: 320, streamable: true }],
    stream: async () => ({ stream: Readable.from([]), contentType: 'audio/mpeg', mode: 'unit-other' })
  })
  sources.noSearch.delete('unit-other')

  const result = await sources.resolve('linh midnight')
  assert.equal(result.source, 'unit-other')
  assert.equal(result.tracks.length, 1)
  assert.equal(result.tracks[0].id, 'uo:1')
})

test('default fallbackOrder includes nhaccuatui and alternatives() times out slow providers without ignoring fast ones', async () => {
  const defaults = new SourceRegistry({ liveFallback: false })
  assert.ok(defaults.fallbackOrder.includes('nhaccuatui'), 'nhaccuatui is part of default fallbackOrder')

  const sources = new SourceRegistry({ liveFallback: false, hiRes: false, searchTimeoutMs: 80 })
  sources.noSearch = new Set(sources.sources.map((s) => s.name))

  sources.register({
    name: 'unit-slow',
    prefixes: [],
    canResolve: () => false,
    resolve: async () => ({ tracks: [] }),
    search: async () => {
      await new Promise((r) => setTimeout(r, 3000))
      return [{ id: 'slow:1', source: 'unit-slow', title: 'Blue Hour', artist: 'Kavi', duration: 180_000 }]
    },
    stream: async () => ({ stream: Readable.from([]), contentType: 'audio/mpeg', mode: 'slow' })
  })
  sources.register({
    name: 'unit-fast',
    prefixes: [],
    canResolve: () => false,
    resolve: async () => ({ tracks: [] }),
    search: async () => [{ id: 'fast:1', source: 'unit-fast', title: 'Blue Hour', artist: 'Kavi', duration: 180_000, bitrate: 320 }],
    stream: async () => ({ stream: Readable.from([]), contentType: 'audio/mpeg', mode: 'fast' })
  })
  sources.noSearch.delete('unit-slow')
  sources.noSearch.delete('unit-fast')

  const started = Date.now()
  const alts = await sources.alternatives({ id: 'orig:1', source: 'soundcloud', title: 'Blue Hour', artist: 'Kavi', duration: 180_000 })
  const elapsed = Date.now() - started

  assert.ok(elapsed < 1000, `alternatives returned in ${elapsed}ms without waiting for hung source`)
  assert.equal(alts.length, 1)
  assert.equal(alts[0].source, 'unit-fast')
})

test('stream() rehydrates a track missing its private streaming handle before falling back', async () => {
  const sources = new SourceRegistry({ hiRes: false, liveFallback: false, fallbackOrder: [] })
  let streamCalls = 0
  sources.register({
    name: 'unit-sc',
    prefixes: ['usc:'],
    canResolve: (q) => String(q).startsWith('https://unit-sc.invalid/'),
    resolve: async () => ({
      type: 'track',
      name: 'Hydrated',
      tracks: [{ id: 'usc:1', source: 'unit-sc', title: 'Hydrated', artist: 'Kavi', url: 'https://cdn.invalid/song.mp3' }]
    }),
    stream: async (track) => {
      streamCalls += 1
      if (!track.url) throw new Error('missing stream url')
      return { stream: Readable.from([Buffer.concat(buildSilence(100).frames)]), contentType: 'audio/mpeg', mode: 'unit-sc' }
    }
  })

  const opened = await sources.stream({
    id: 'usc:1',
    source: 'unit-sc',
    title: 'Hydrated',
    artist: 'Kavi',
    link: 'https://unit-sc.invalid/track/1'
  })
  assert.equal(streamCalls, 2)
  assert.equal(opened.mode, 'unit-sc')
  assert.equal(opened.track.url, 'https://cdn.invalid/song.mp3')
})

/* ---------------------- Stream error fixes ---------------------- */

test('fetchWithConnectTimeout allows slow streams longer than connectTimeoutMs and still enforces connect timeout & external abort', async (t) => {
  const payload = Buffer.concat(buildSilence(300).frames)
  const server = http.createServer((req, res) => {
    if (req.url === '/slow-body') {
      res.writeHead(200, { 'content-type': 'audio/mpeg' })
      let offset = 0
      const step = Math.ceil(payload.length / 5)
      const timer = setInterval(() => {
        if (offset >= payload.length) {
          clearInterval(timer)
          res.end()
          return
        }
        res.write(payload.subarray(offset, offset + step))
        offset += step
      }, 80) // ~400ms total body duration (> 120ms connectTimeoutMs!)
      res.on('close', () => clearInterval(timer))
      return
    }
    if (req.url === '/hung-headers') {
      // Never write headers; connect timeout must abort.
      return
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as any).port}`

  // 1. Slow body completes cleanly past connectTimeoutMs!
  const res = await fetchWithConnectTimeout(`${base}/slow-body`, { connectTimeoutMs: 120 })
  const stream = responseToNodeStream(res)
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  assert.deepEqual(Buffer.concat(chunks), payload, 'full audio stream survives past connect timeout')

  // 2. Hung headers still time out promptly.
  await assert.rejects(
    fetchWithConnectTimeout(`${base}/hung-headers`, { connectTimeoutMs: 100 }),
    /timed out/i
  )

  // 3. External abort signal cancels an active body stream mid-flight.
  const abort = new AbortController()
  const res2 = await fetchWithConnectTimeout(`${base}/slow-body`, { connectTimeoutMs: 500, signal: abort.signal })
  const stream2 = responseToNodeStream(res2, { signal: abort.signal })
  let received = 0
  await assert.rejects(async () => {
    for await (const chunk of stream2) {
      received += chunk.length
      abort.abort(new Error('skipped'))
    }
  })
  assert.ok(received > 0 && received < payload.length, 'stream aborted cleanly after first chunk')
})

test('MetroTranscoder and Mp3FrameSplitter handle large ID3v2 tags (>4KB) with embedded sync-like bytes and Uint8Array chunks', () => {
  const audio = Buffer.concat(buildSilence(500).frames)

  // Build a 12 KB ID3v2.3 tag containing fake 0xFF 0xF0 bytes (like JPEG cover art).
  const bodySize = 12_288
  const tagHeader = Buffer.from([
    0x49, 0x44, 0x33, // "ID3"
    0x03, 0x00, 0x00, // v2.3, no flags
    (bodySize >> 21) & 0x7f,
    (bodySize >> 14) & 0x7f,
    (bodySize >> 7) & 0x7f,
    bodySize & 0x7f
  ])
  const tagBody = Buffer.alloc(bodySize, 0x33)
  // Plant false ADTS sync bytes inside the ID3 artwork payload.
  tagBody[100] = 0xff
  tagBody[101] = 0xf1
  tagBody[2000] = 0xff
  tagBody[2001] = 0xf0
  const mp3WithCoverArt = Buffer.concat([tagHeader, tagBody, audio])

  // Sniffing a partial ID3v2 chunk must return 'unknown', NOT 'aac'.
  assert.equal(sniff(mp3WithCoverArt.subarray(0, 4096)), 'unknown')
  assert.equal(sniff(mp3WithCoverArt), 'mp3')

  // Pushing in 2 KB Uint8Array chunks through MetroTranscoder must succeed and output the exact MP3 audio.
  const transcoder = new MetroTranscoder({ bitrate: 128 })
  const out: Buffer[] = []
  for (let at = 0; at < mp3WithCoverArt.length; at += 2048) {
    const view = new Uint8Array(mp3WithCoverArt.subarray(at, at + 2048))
    const chunk = transcoder.push(view)
    if (chunk.length) out.push(chunk)
  }
  const tail = transcoder.flush()
  if (tail.length) out.push(tail)

  assert.equal(transcoder.kind, 'mp3')
  assert.deepEqual(Buffer.concat(out), audio)

  // Mp3FrameSplitter also handles plain Uint8Array chunks.
  const splitter = new Mp3FrameSplitter()
  const split = splitter.push(new Uint8Array(audio))
  assert.ok(split.frames.length > 10)
})

test('HttpSource.stream() unwraps .pls playlist URLs and streams underlying MP3 audio', async (t) => {
  const audio = Buffer.concat(buildSilence(300).frames)
  const server = http.createServer((req, res) => {
    if (req.url === '/radio.pls') {
      res.writeHead(200, { 'content-type': 'audio/x-scpls' })
      return res.end(`[playlist]\nNumberOfEntries=1\nFile1=http://127.0.0.1:${(server.address() as any).port}/live.mp3\n`)
    }
    res.writeHead(200, { 'content-type': 'audio/mpeg' })
    res.end(audio)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  t.after(() => server.close())

  const base = `http://127.0.0.1:${(server.address() as any).port}`
  const httpSource = new HttpSource()
  const opened = await httpSource.stream({ url: `${base}/radio.pls` })
  const chunks: Buffer[] = []
  for await (const c of opened.stream) chunks.push(c)
  assert.deepEqual(Buffer.concat(chunks), audio)
})

test('connectStream delivers initial body bytes in strict order before subsequent socket packets', async (t) => {
  const metaint = 32
  const part1 = Buffer.alloc(metaint, 0xaa)
  const meta = buildIcyMetadataBlock('DJ - First Track')
  const part2 = Buffer.alloc(metaint, 0xbb)

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'icy-metaint': String(metaint) })
    // Send part1 + meta immediately with headers, then part2 shortly after.
    res.write(Buffer.concat([part1, meta]))
    setTimeout(() => res.end(part2), 20)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  t.after(() => server.close())

  const res = await connectStream(`http://127.0.0.1:${(server.address() as any).port}/stream`, { metadata: true })
  const chunks: Buffer[] = []
  for await (const c of res.body) chunks.push(c)
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([part1, meta, part2]))
})

test('HEAD /stream/:id.mp3 with Accept: application/json returns empty body on error, and silence lead-in is stereo MP3', async (t) => {
  // buildSilence generates Joint Stereo MP3 frames matching typical music streams.
  const { frames } = buildSilence(100)
  const header = parseFrameHeader(frames[0], 0)
  assert.equal(header.channels, 2, 'silence frames are stereo so decoders never hit a mono→stereo channel switch')

  // Station.subscribe immediately writes valid MP3 lead-in when running with empty burst.
  const sources = new SourceRegistry({ hiRes: false, liveFallback: false, noSearch: ['*'] })
  const station = new Station({ id: 'lead-in', name: 'Lead In', playlists: [], autoStart: false }, sources)
  station._running = true
  t.after(() => station.destroy())
  const sub = station.subscribe({ label: 'instant', burst: true })
  const firstChunk = await new Promise<Buffer>((resolve) => sub.once('data', resolve))
  assert.ok(firstChunk.length >= 417, 'subscriber receives immediate valid MP3 lead-in frame')
  assert.equal(sniff(firstChunk), 'mp3')
  sub.destroy()

  // HEAD request to off-air stream with Accept: application/json must not send a response body.
  const server = await createRadioServer({
    server: { host: '127.0.0.1', port: 0 },
    logging: { level: 'silent' },
    plugins: { enabled: false },
    web: { enabled: false },
    store: { enabled: false },
    tts: { enabled: false },
    cache: { enabled: false },
    sources: { noSearch: ['*'] },
    stations: [{ id: 'stopped-fm', name: 'Stopped FM', playlists: [], autoStart: false }]
  })
  t.after(() => server.close())

  const headErr = await fetch(`http://127.0.0.1:${server.port}/stream/stopped-fm.mp3`, {
    method: 'HEAD',
    headers: { accept: 'application/json' }
  })
  assert.equal(headErr.status, 503)
  assert.equal(headErr.headers.get('x-livy-error'), 'off_air')
  assert.equal(await headErr.text(), '', 'HEAD error response has empty body')
})
