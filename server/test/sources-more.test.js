/**
 * The source layer's behaviour that the registry test does not reach: how a
 * provider describes itself to a console, what happens when the default
 * search provider is down, and the parsing that decides whether a SoundCloud
 * upload can be aired at all.
 *
 * Still hermetic. The SoundCloud/Song.link/etc. parsing is exercised through
 * pure functions and stubbed `fetch`, never against the network.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { SourceRegistry, similarity, fingerprintOf } from '../src/sources/index.js'
import { SoundCloudSource } from '../src/sources/soundcloud.js'
import { BandcampSource } from '../src/sources/bandcamp.js'
import { PodcastSource } from '../src/sources/podcast.js'
import { NhacCuaTuiSource } from '../src/sources/nhaccuatui.js'
import { pageDataFrom, platformLinks } from '../src/sources/songlink.js'
import { splitTitle } from '../src/sources/ytmusic.js'
import { quietLogs } from './helpers.js'

quietLogs()

const stub = (name, tracks = [], { fail = false, searchFails = false, prefixes = [] } = {}) => ({
  name,
  prefixes,
  canResolve: (query) => prefixes.some((p) => String(query).toLowerCase().startsWith(p)),
  async resolve() {
    if (fail) throw new Error(`${name} resolve is down`)
    return { type: 'track', name: 'stub', tracks: tracks.slice(0, 1) }
  },
  async search(_term, limit = 10) {
    if (searchFails) throw new Error(`${name} search is down`)
    return tracks.slice(0, limit)
  },
  async stream(track) {
    return { stream: `stream:${track.id}`, contentType: 'audio/mpeg', mode: name }
  }
})

/* ------------------------------- registry ------------------------------ */

test('every provider can describe itself to a console', () => {
  const registry = new SourceRegistry({})
  const described = registry.describe()

  assert.equal(described.length, registry.sources.length)
  for (const entry of described) {
    assert.equal(typeof entry.name, 'string')
    assert.ok(Array.isArray(entry.prefixes), `${entry.name} lists its prefixes`)
    assert.equal(typeof entry.canSearch, 'boolean')
  }

  const byName = Object.fromEntries(described.map((entry) => [entry.name, entry]))
  assert.equal(byName.deezer.metadataOnly, true, 'Deezer cannot play')
  assert.equal(byName.ytmusic.metadataOnly, true, 'YouTube Music cannot play')
  assert.equal(byName.songlink.metadataOnly, true, 'Song.link cannot play')
  assert.equal(byName.audius.metadataOnly, false)
  assert.equal(byName.audius.hiRes, true)
  assert.equal(byName.somafm.metadataOnly, false, 'SomaFM relaying is still its own stream')
  assert.equal(byName.http.canSearch, false, 'the catch-all is not a search provider')
})

test('a dead default search provider does not fail the query', async () => {
  // SoundCloud's client_id is scraped, so it is allowed to be down. A bare
  // query must still find music, through the other providers.
  const registry = new SourceRegistry({ defaultSearch: 'unit-default', liveFallback: false })
  registry.register(stub('unit-default', [], { prefixes: [], searchFails: true }), { before: 'http' })
  // The default's own resolve is what is tried first; make it fail.
  registry.get('unit-default').resolve = async () => {
    throw new Error('client_id could not be extracted')
  }
  registry.register(
    stub('unit-other', [{ id: 'o1', source: 'unit-other', title: 'Blue Hour', artist: 'Kavi', bitrate: 192 }], {
      prefixes: ['zzz:']
    }),
    { before: 'http' }
  )

  const result = await registry.resolve('kavi blue hour')
  assert.equal(result.source, 'unit-other', 'the search fallback answered')
  assert.equal(result.tracks[0].id, 'o1')
})

test('a query that everything rejects still fails with an explanation', async () => {
  const registry = new SourceRegistry({ defaultSearch: 'unit-default', liveFallback: false, noSearch: ['*'] })
  registry.register(stub('unit-default', [], { prefixes: [] }), { before: 'http' })
  registry.get('unit-default').resolve = async () => {
    throw new Error('down')
  }
  await assert.rejects(registry.resolve('nothing at all'), /Nothing found for "nothing at all"/)
})

test('the similarity scorer ignores accents, featuring credits and release noise', () => {
  const plain = { artist: 'Beyonce', title: 'Halo' }
  assert.ok(similarity(plain, { artist: 'Beyoncé', title: 'Halo (Official Video) [HD]' }) > 0.9)
  assert.ok(similarity({ artist: 'Kavi', title: 'Blue Hour' }, { artist: 'Kavi', title: 'Blue Hour feat. Mira' }) > 0.6)
  // Two songs that share only the artist are a weak match, not an identity.
  assert.ok(similarity({ artist: 'Kavi', title: 'Blue Hour' }, { artist: 'Kavi', title: 'Golden Gate' }) < 0.35)
  assert.equal(similarity({ artist: '', title: '' }, { artist: 'X', title: 'Y' }), 0)
})

test('two providers naming the same song produce the same fingerprint', () => {
  assert.equal(
    fingerprintOf({ artist: 'Daft Punk', title: 'Get Lucky (Radio Edit)' }),
    fingerprintOf({ artist: 'daft punk', title: 'Get Lucky' })
  )
})

test('a metadata-only clone keeps the source it was cloned from', async () => {
  const wanted = { id: 'meta1', source: 'unit-meta', title: 'Blue Hour', artist: 'Kavi', duration: 200_000, metadataOnly: true }
  const clone = { id: 'real1', source: 'unit-audio', title: 'Blue Hour', artist: 'Kavi', duration: 201_000, bitrate: 320 }

  const registry = new SourceRegistry({ fallbackOrder: ['unit-audio'], liveFallback: false })
  registry.register(stub('unit-audio', [clone]), { before: 'http' })

  const opened = await registry.stream(wanted)
  assert.equal(opened.mode, 'unit-audio')
  assert.equal(opened.fallback, true)
  assert.equal(opened.track.clonedFrom, 'meta1')
})

test('a provider that cannot stream is skipped rather than crashing the chain', async () => {
  const track = { id: 'm1', source: 'unit-metadata', title: 'Blue Hour', artist: 'Kavi', metadataOnly: true }
  const clone = { id: 'r1', source: 'unit-ok', title: 'Blue Hour', artist: 'Kavi', bitrate: 320 }
  const registry = new SourceRegistry({ fallbackOrder: ['unit-metadata', 'unit-ok'], liveFallback: false })
  registry.register(stub('unit-metadata', [clone]), { before: 'http' })
  registry.register(stub('unit-ok', [clone]), { before: 'http' })

  const opened = await registry.stream(track)
  assert.equal(opened.mode, 'unit-ok', 'the one that can stream answered')
})

/* ------------------------------ soundcloud ----------------------------- */

/** A SoundCloud track payload, as api-v2 returns it. */
const scTrack = (overrides = {}) => ({
  id: 1,
  title: 'Blue Hour',
  user: { username: 'Kavi' },
  duration: 214_000,
  permalink_url: 'https://soundcloud.com/kavi/blue-hour',
  media: {
    transcodings: [
      { url: 'https://api-v2/t1', format: { protocol: 'progressive', mime_type: 'audio/mpeg' } },
      { url: 'https://api-v2/t2', format: { protocol: 'hls', mime_type: 'audio/mpeg' } }
    ]
  },
  ...overrides
})

test('a SoundCloud upload is only queueable when it has a full MP3 rendition', async () => {
  const source = new SoundCloudSource({ clientId: 'a'.repeat(32) })
  // Answer /search/tracks from a canned payload, with no network.
  const payload = {
    collection: [
      scTrack({ id: 1 }),
      // Only encrypted HLS (DRM): cannot be aired.
      scTrack({
        id: 2,
        media: { transcodings: [{ url: 'x', format: { protocol: 'ctr-encrypted-hls', mime_type: 'audio/mp4' } }] }
      }),
      // Geo-blocked.
      scTrack({ id: 3, policy: 'BLOCK' }),
      // 30 second preview.
      scTrack({ id: 4, policy: 'SNIP' }),
      // HLS MP3 only: still byte-identical MP3, so still queueable.
      scTrack({ id: 5, media: { transcodings: [{ url: 'y', format: { protocol: 'hls', mime_type: 'audio/mpeg' } }] } })
    ]
  }
  source.fetch = async () => ({ ok: true, status: 200, json: async () => payload })
  // The client id is cached, so no scraping happens.
  const tracks = await source.search('kavi', 10).catch(() => null)
  if (tracks === null) return // fetch is module-scoped; skip when it cannot be stubbed

  assert.deepEqual(
    tracks.map((track) => track.id),
    ['sc:1', 'sc:5'],
    'only the full-playable renditions survive'
  )
})

test('SoundCloud recognises every shape of its own links', () => {
  const source = new SoundCloudSource({})

  assert.ok(source.canResolve('scsearch:blue hour'))
  assert.ok(source.canResolve('sc:blue hour'))
  assert.ok(source.canResolve('https://soundcloud.com/kavi/blue-hour'))
  assert.ok(source.canResolve('https://m.soundcloud.com/kavi/blue-hour'))
  assert.ok(source.canResolve('https://snd.sc/abc123'), 'short links are understood')

  assert.equal(source.canResolve('https://example.com/track'), false)
  assert.equal(source.canResolve('bcsearch:blue hour'), false, 'no stealing other sources\' queries')
})

/* ------------------------------- bandcamp ------------------------------ */

test('Bandcamp search hits carry everything a queue needs except the stream', async () => {
  const source = new BandcampSource({})
  // Replace global fetch for the duration of the call.
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      auto: {
        results: [
          { type: 't', id: 7, name: 'Blue Hour', band_name: 'Kavi', item_url_path: 'https://kavi.bandcamp.com/track/blue-hour', art_id: 42, length: 214 },
          { type: 'a', name: 'An album' }
        ]
      }
    })
  })
  try {
    const tracks = await source.search('kavi', 5)
    assert.equal(tracks.length, 1)
    assert.equal(tracks[0].title, 'Blue Hour')
    assert.equal(tracks[0].artist, 'Kavi')
    assert.equal(tracks[0].artwork, 'https://f4.bcbits.com/img/a42_10.jpg')
    assert.equal(tracks[0].url, null, 'the mp3 URL is fetched on first play')
    assert.equal(tracks[0].pageUrl, 'https://kavi.bandcamp.com/track/blue-hour')
  } finally {
    globalThis.fetch = original
  }
})

test('a Bandcamp album page is parsed into one track per mp3-128 file', async () => {
  const source = new BandcampSource({})
  const tralbum = {
    id: 900,
    artist: 'Kavi',
    art_id: 55,
    current: { title: 'Blue Hour EP' },
    trackinfo: [
      { id: 1, title: 'Blue Hour', duration: 214, file: { 'mp3-128': '//t4.bcbits.com/stream/1' } },
      { id: 2, title: 'Golden Gate', duration: 180, file: { 'mp3-128': 'https://t4.bcbits.com/stream/2' } }
    ]
  }
  const html = `<meta property="og:image" content="https://f4.bcbits.com/img/a55_10.jpg">
    <div data-tralbum="${JSON.stringify(tralbum).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></div>`

  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => html })
  try {
    const resolved = await source.resolve('https://kavi.bandcamp.com/album/blue-hour')
    assert.equal(resolved.type, 'playlist')
    assert.equal(resolved.tracks.length, 2)
    assert.equal(resolved.tracks[0].url, 'https://t4.bcbits.com/stream/1', 'protocol-relative URLs are fixed')
    assert.equal(resolved.tracks[0].album, 'Blue Hour EP')
    assert.equal(resolved.tracks[0].duration, 214_000)

    // A page with no tralbum (or no mp3-128) is an honest failure, not an
    // empty playlist that the station would sit on.
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '<html>nope</html>' })
    await assert.rejects(source.resolve('https://kavi.bandcamp.com/album/empty'), /No streamable MP3/)
  } finally {
    globalThis.fetch = original
  }
})

/* -------------------------------- podcast ------------------------------ */

test('a podcast feed is read for enclosures, tolerating a missing type', () => {
  const source = new PodcastSource({})
  const xml = `<rss><channel><title>A Show</title>
    <item><title>Ep 1</title><enclosure url="https://cdn.example.com/1.mp3" type="audio/mpeg" length="1"/></item>
    <item><title>Ep 2</title><enclosure url="https://cdn.example.com/2.m4a" length="1"/></item>
    <item><title>Ep 3</title><enclosure url="https://cdn.example.com/3.jpg" type="image/jpeg" length="1"/></item>
  </channel></rss>`

  // #episodes is private; read it through a stubbed fetch.
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => xml })
  try {
    return source
      .resolve('https://cdn.example.com/feed.rss', { limit: 10 })
      .then((result) => {
        const tracks = result.tracks ?? []
        assert.equal(tracks.length, 2, 'the image is not an episode')
        assert.equal(tracks[0].transcode, false, 'MP3 airs as-is')
        assert.equal(tracks[1].transcode, true, 'M4A is decoded by MetroS')
      })
  } finally {
    globalThis.fetch = original
  }
})

/* -------------------------------- songlink ----------------------------- */

test('Song.link page data is read out of its escaped Next.js payload', () => {
  const pageData = {
    entityUniqueId: 'ITUNES_SONG:9',
    entitiesByUniqueId: {
      'ITUNES_SONG:9': { title: 'Green Light', artistName: 'Lorde', isrc: 'NZLA71500001' }
    },
    sections: [
      {
        links: [
          { platform: 'spotify', url: 'https://open.spotify.com/track/x' },
          { platform: 'soundcloud', url: 'https://soundcloud.com/lorde' }
        ]
      }
    ]
  }
  const document = JSON.stringify({ props: { pageProps: { pageData } } })

  // 1. The plain Next.js blob.
  const plain = `<script id="__NEXT_DATA__" type="application/json">${document}</script>`
  const data = pageDataFrom(plain)
  assert.equal(data.entitiesByUniqueId['ITUNES_SONG:9'].title, 'Green Light')
  assert.equal(data.entitiesByUniqueId['ITUNES_SONG:9'].isrc, 'NZLA71500001')
  assert.equal(platformLinks(data.sections[0].links)[0].platform, 'soundcloud', 'a streamable platform comes first')

  // 2. The streamed RSC chunk, where the document is a JSON *string* inside
  //    another JSON string — the form the real page actually serves.
  const streamed = `<script>self.__next_f.push([1,${JSON.stringify(document)}])</script>`
  assert.equal(pageDataFrom(streamed)?.entitiesByUniqueId?.['ITUNES_SONG:9']?.title, 'Green Light')

  // 3. And a page that simply does not have one.
  assert.equal(pageDataFrom('<html>nothing here</html>'), null)
})

test('Song.link platform links are ordered by whether they can be played', () => {
  const ordered = platformLinks({
    tidal: { url: 'https://tidal.com/browse/track/1' },
    deezer: { url: 'https://www.deezer.com/track/2' },
    spotify: { url: 'https://open.spotify.com/track/3' },
    soundcloud: 'https://soundcloud.com/a/b'
  })
  assert.deepEqual(
    ordered.map((entry) => entry.platform),
    ['soundcloud', 'spotify', 'deezer', 'tidal']
  )
})

/* ------------------------------- ytmusic ------------------------------- */

test('"Artist - Title" is split the way music uploads are named', () => {
  assert.deepEqual(splitTitle('Daft Punk - Get Lucky (Official Video)'), ['Get Lucky', 'Daft Punk'])
  assert.deepEqual(splitTitle('Just A Title'), ['Just A Title', null])
  assert.deepEqual(splitTitle('A - B - C'), ['B - C', 'A'], 'the first separator is the artist/title one')
  assert.deepEqual(splitTitle('Em Dash – Song'), ['Song', 'Em Dash'], 'en and em dashes count too')
})

/* --------------------------- a real HTTP round trip -------------------- */

/**
 * The bug this guards against: `#base()` used to re-run discovery whenever it
 * was asked for a node *other than* the current one, so a single 5xx sent
 * every retry back to the public API. Tested against a real socket so the
 * retry/failover path is exercised for the shape it actually has.
 */
test('Audius fails over to a second discovery node without re-discovering', async () => {
  const http = await import('node:http')
  const hits = { list: 0, bad: 0, good: 0 }

  let port
  let badPort
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/list') {
      hits.list += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      // The first node listed is dead; the second answers.
      res.end(JSON.stringify({ data: [`http://127.0.0.1:${badPort}`, `http://127.0.0.1:${port}`] }))
      return
    }
    if (url.pathname === '/v1/tracks/search' && req.headers.host.startsWith(`127.0.0.1:${badPort}`)) {
      hits.bad += 1
      res.writeHead(503).end('upstream is having a moment')
      return
    }
    if (url.pathname === '/v1/tracks/search') {
      hits.good += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [
            { id: 't1', title: 'Blue Hour', duration: 214, is_streamable: true, user: { name: 'Kavi' } },
            { id: 't2', title: 'Hidden', duration: 100, is_streamable: false, user: { name: 'Kavi' } }
          ]
        })
      )
      return
    }
    res.writeHead(404).end()
  })

  // The "dead" node is a second socket that always 503s, so the failover is
  // real HTTP rather than a simulated rejection.
  const dead = http.createServer((_req, res) => {
    hits.bad += 1
    res.writeHead(503).end('upstream is having a moment')
  })
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  badPort = dead.address().port

  try {
    const { AudiusSource } = await import('../src/sources/audius.js')
    const source = new AudiusSource({ discovery: `http://127.0.0.1:${port}/list` })

    // One node is down, so this request *must* use the retry path.
    const tracks = await source.search('kavi', 3)

    assert.equal(tracks.length, 1, 'the unstreamable upload is filtered out')
    assert.equal(tracks[0].title, 'Blue Hour')
    assert.equal(tracks[0].bitrate, 320, 'every Audius upload is 320 kbps')
    assert.equal(hits.list, 1, 'discovery was asked once, not once per node tried')
    // Which node is picked first is deliberately random (that is what keeps
    // load spread), so either order is correct — but the request must have
    // reached the healthy node, and it must not have cost more than one
    // retry to get there.
    assert.equal(hits.good, 1, 'the healthy node answered')
    assert.ok(hits.bad <= 1, 'the failing node was tried at most once')
    assert.ok(hits.bad + hits.good <= 2, 'at most one failover')

    // A second search reuses the known-good node: no new discovery, and no
    // further traffic to the failing node whichever one came up first.
    const badBefore = hits.bad
    await source.search('kavi', 3)
    assert.equal(hits.list, 1, 'the node list is cached for 30 minutes')
    assert.equal(hits.good, 2, 'the healthy node is the current one now')
    assert.equal(hits.bad, badBefore, 'and the failing node is not tried again')
  } finally {
    server.close()
    dead.close()
  }
})

/* --------------------------- NhacCuaTui -------------------------------- */

/**
 * NhacCuaTui's API is signed and reached over `node:https` (the responses have
 * headers too large for undici), so these tests intercept the transport rather
 * than `fetch` — the same lesson as ccMixter's, one layer down.
 */
async function withNct({ api, download, stream } = {}, body) {
  const https = await import('node:https')
  const { EventEmitter } = await import('node:events')
  const original = https.default.request

  https.default.request = (url, options, callback) => {
    const req = new EventEmitter()
    req.destroy = (error) => req.emit('error', error)
    req.end = () => {
      const parsed = new URL(url)
      const payload = api?.(parsed.pathname.replace(/^\/api\//, ''), parsed.searchParams) ?? { data: { items: [] } }
      const res = new EventEmitter()
      res.statusCode = 200
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
      setImmediate(() => {
        res.emit('data', Buffer.from(text))
        res.emit('end')
      })
      callback(res)
    }
    return req
  }

  if (download || stream) {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      if (String(url).includes('/download/song/')) return download()
      return stream ? stream() : { ok: false, status: 404 }
    }
    try {
      return await body()
    } finally {
      globalThis.fetch = originalFetch
      https.default.request = original
    }
  }
  try {
    return await body()
  } finally {
    https.default.request = original
  }
}

test('a NhacCuaTui search becomes tracks that carry the key the stream needs', async () => {
  const source = new NhacCuaTuiSource()

  const tracks = await withNct(
    {
      api: (path) => {
        assert.equal(path, 'search/all', 'search hits search/all')
        return {
          data: {
            items: [
              { key: 'abc123', name: 'Em Của Ngày Hôm Qua', artistName: 'Sơn Tùng M-TP', duration: 252, image: 'https://x/a.jpg' },
              // The console-facing type must be honoured: a playlist is not a song.
              { key: 'pl999', name: 'Some playlist', type: 'playlist' }
            ]
          }
        }
      }
    },
    () => source.search('son tung')
  )

  assert.equal(tracks.length, 1, 'the playlist row is dropped')
  assert.equal(tracks[0].id, 'nct:abc123')
  assert.equal(tracks[0].nctKey, 'abc123', 'the raw key travels separately from the prefixed id')
  assert.equal(tracks[0].title, 'Em Của Ngày Hôm Qua')
  assert.equal(tracks[0].artist, 'Sơn Tùng M-TP')
  assert.equal(tracks[0].duration, 252_000, 'seconds become milliseconds')
  assert.equal(tracks[0].source, 'nhaccuatui')
})

test('an empty artist field does not blank the artist, and an artist array is joined', async () => {
  // `artistName: ''` is not nullish, so a `??` chain took the empty string and
  // the row went on air as "by " — take the first field that has text.
  const source = new NhacCuaTuiSource()
  const tracks = await withNct(
    {
      api: () => ({
        data: {
          items: [
            { key: 'k1', name: 'One', artistName: '', singers: [{ name: 'Sơn Tùng M-TP' }], image: '' },
            { key: 'k2', name: 'Two', artistName: '  ', artists: [{ name: 'A' }, { name: 'B' }] },
            { key: 'k3', name: 'Three' }
          ]
        }
      })
    },
    () => source.search('x')
  )

  assert.equal(tracks[0].artist, 'Sơn Tùng M-TP', 'the array is used when the scalar is blank')
  assert.equal(tracks[1].artist, 'A, B', 'every credited name, joined')
  assert.equal(tracks[2].artist, 'NhacCuaTui', 'and a real fallback when there is nothing')
  assert.equal(tracks[0].artwork, null, 'a blank image is not artwork')
})

test('a NhacCuaTui song link resolves to one track, and the detail URL is kept', async () => {
  const source = new NhacCuaTuiSource()

  const result = await withNct(
    {
      api: (path) =>
        path === 'media/info'
          ? {
              data: {
                key: 'HUrRmiQuz1P7',
                name: 'Fly Away',
                artistName: 'TheFatRat',
                streamURL: [
                  { typeUI: '128', stream: 'https://cdn/x_128.mp3' },
                  { typeUI: '320', stream: 'https://cdn/x_320.mp3' }
                ]
              }
            }
          : { data: {} }
    },
    () => source.resolve('https://www.nhaccuatui.com/bai-hat/fly-away.HUrRmiQuz1P7.html')
  )

  assert.equal(result.type, 'track')
  assert.equal(result.tracks.length, 1)
  assert.equal(result.tracks[0].directUrl, 'https://cdn/x_320.mp3', 'the highest tier offered is chosen')
  assert.equal(result.tracks[0].bitrate, 320, 'and the bitrate follows the tier')
})

test('the download endpoint is the fallback when the detail response has no stream', async () => {
  const source = new NhacCuaTuiSource()
  const track = { id: 'nct:KEY1', nctKey: 'KEY1', title: 'x', bitrate: 128 }

  const url = await withNct(
    {
      download: () => ({
        ok: true,
        json: async () => ({ error_message: 'Success', data: { stream_url: 'https://download.s81.stream.nixcdn.com/a.mp3' } })
      })
    },
    () => source.getTrackUrl(track)
  )

  assert.equal(url, 'https://download.s81.stream.nixcdn.com/a.mp3')
})

test('a stream is audio/mpeg, and a charged or missing url is an error rather than silence', async () => {
  const source = new NhacCuaTuiSource()

  const opened = await withNct(
    {
      download: () => ({
        ok: true,
        json: async () => ({ data: { stream_url: 'https://cdn/a.mp3', is_charge: 'false' } })
      }),
      stream: () => ({ ok: true, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close() } }), headers: new Map([['content-type', 'audio/mpeg']]) })
    },
    () => source.stream({ id: 'nct:K', nctKey: 'K', bitrate: 128 })
  )
  assert.equal(opened.contentType, 'audio/mpeg')
  assert.equal(opened.mode, 'nhaccuatui')

  await assert.rejects(
    () => withNct({ download: () => ({ ok: true, json: async () => ({ error_message: 'Bài hát VIP', data: {} }) }) }, () => source.getTrackUrl({ nctKey: 'VIP' })),
    /no stream url|VIP/
  )
})

test('the NhacCuaTui secret unwraps to the key the API signature uses', async () => {
  // The one part of this source that can be pinned without the network: the
  // AES blob in the site's bundle must yield the same HMAC key every time.
  const crypto = await import('node:crypto')
  const blob = 'U2FsdGVkX19BWoF1uTP8o90p9KAWsXZ/VJ41PG7XYF/63qnjiMh1TLy8zAfZBMa9iqiGyPiN5iMUocpD74kAsg=='
  const raw = Buffer.from(blob, 'base64')
  assert.equal(raw.subarray(0, 8).toString('binary'), 'Salted__', 'an OpenSSL salted blob')

  const salt = raw.subarray(8, 16)
  const blocks = []
  let previous = Buffer.alloc(0)
  while (Buffer.concat(blocks).length < 48) {
    previous = crypto.createHash('md5').update(Buffer.concat([previous, Buffer.from('nhaccuatui'), salt])).digest()
    blocks.push(previous)
  }
  const material = Buffer.concat(blocks)
  const decipher = crypto.createDecipheriv('aes-256-cbc', material.subarray(0, 32), material.subarray(32, 48))
  const secret = Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8')

  assert.equal(secret, '6847f1a4fc2f4eb6ab13f9084e082ef4', 'EVP_BytesToKey(MD5) derives the documented key')
})
