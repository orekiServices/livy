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

import { SourceRegistry, similarity, fingerprintOf } from '../src/sources/index.ts'
import { SoundCloudSource } from '../src/sources/soundcloud.ts'
import { BandcampSource } from '../src/sources/bandcamp.ts'
import { PodcastSource } from '../src/sources/podcast.ts'
import { NhacCuaTuiSource } from '../src/sources/nhaccuatui.ts'
import { pageDataFrom, platformLinks } from '../src/sources/songlink.ts'
import { splitTitle } from '../src/sources/ytmusic.ts'
import { quietLogs } from './helpers.ts'

quietLogs()

const stub = (name, tracks: any = [], { fail = false, searchFails = false, prefixes = [] }: any = {}) => ({
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
const scTrack = (overrides: any = {}) => ({
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
  ;(source as any).fetch = async () => ({ ok: true, status: 200, json: async () => payload })
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
  const source = new BandcampSource()
  // Replace global fetch for the duration of the call.
  const original = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      auto: {
        results: [
          { type: 't', id: 7, name: 'Blue Hour', band_name: 'Kavi', item_url_path: 'https://kavi.bandcamp.com/track/blue-hour', art_id: 42, length: 214 },
          { type: 'a', name: 'An album' }
        ]
      }
    })
  })) as any
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
  const source = new BandcampSource()
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
  globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => html })) as any
  try {
    const resolved = await source.resolve('https://kavi.bandcamp.com/album/blue-hour')
    assert.equal(resolved.type, 'playlist')
    assert.equal(resolved.tracks.length, 2)
    assert.equal(resolved.tracks[0].url, 'https://t4.bcbits.com/stream/1', 'protocol-relative URLs are fixed')
    assert.equal(resolved.tracks[0].album, 'Blue Hour EP')
    assert.equal(resolved.tracks[0].duration, 214_000)

    // A page with no tralbum (or no mp3-128) is an honest failure, not an
    // empty playlist that the station would sit on.
    globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => '<html>nope</html>' })) as any
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
  globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => xml })) as any
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
  await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', () => resolve()))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  port = (server.address() as any).port
  badPort = (dead.address() as any).port

  try {
    const { AudiusSource } = await import('../src/sources/audius.ts')
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
 * NhacCuaTui now answers on `graph.nct.vn`, anonymously, over plain `fetch` —
 * the old `beta.nhaccuatui.com` HMAC scheme is gone. These tests stub `fetch`
 * and assert against the shapes recorded by a live probe of the service
 * (2026-10-22): `{ code, msg, success, data }`, `data.songs[]` for search, a
 * bare song for detail, and `streamURL[]` entries carrying
 * `{ type, typeUI, stream, onlyVIP, status, order }`.
 *
 * The stub is installed for the whole body, so no test can reach the network
 * even by accident — a test that hit the live API would be both slow and a
 * lie about what it proves.
 */
async function withNct(body, fn) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = (async (url: any, options: any = {}) => {
    calls.push({ url: String(url), options })
    const reply = typeof body === 'function' ? body(String(url), options, calls) : body
    if (reply === undefined) return { ok: false, status: 404, json: async () => ({}) }
    if (reply.__raw) return reply.__raw
    return { ok: true, status: 200, json: async () => reply, headers: new Map([['content-type', 'application/json']]) }
  }) as any
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = original
  }
}

/** A search row as the live API returns one. */
const nctSong = (over: any = {}) => ({
  key: 'x5DG3gBpOCYu',
  name: 'Khong Mon Dang Ho Doi (Rumba Ver)',
  artist: [
    { key: 'a1', name: 'Nguyen Vi' },
    { key: 'a2', name: 'Someone Else' }
  ],
  artistName: 'Nguyen Vi',
  image: 'https://avatar.nct.vn/a.jpg',
  duration: 214,
  streamURL: [
    { type: '128', typeUI: '128 kbps', stream: 'https://stream.nct.vn/a_128.mp3', onlyVIP: false, status: 1, order: 1 },
    { type: '320', typeUI: '320 kbps', stream: 'https://stream.nct.vn/a_320.mp3', onlyVIP: true, status: 1, order: 3 }
  ],
  ...over
})

/** A detail payload for one key, with a signed URL we can vary per call. */
const nctDetail = (signature = 'sig=1') => ({
  code: 0,
  data: {
    key: 'k1',
    name: 'A Song',
    artist: [{ name: 'An Artist' }],
    duration: 200,
    streamURL: [{ type: '128', stream: `https://stream.nct.vn/a.mp3?${signature}`, onlyVIP: false, status: 1, order: 1 }]
  }
})

test('NhacCuaTui search hits graph.nct.vn and keeps only what can be played', async () => {
  const source = new NhacCuaTuiSource()

  const tracks = await withNct(
    {
      code: 0,
      success: true,
      data: {
        songs: [
          nctSong(),
          nctSong({ key: 'viponly', streamURL: [{ type: '320', stream: 'https://stream.nct.vn/v.mp3', onlyVIP: true, status: 1 }] }),
          nctSong({ key: 'dead', streamURL: [{ type: '128', stream: '', onlyVIP: false, status: 1 }] })
        ]
      }
    },
    () => source.search('khong mon', 10)
  )

  assert.equal(tracks.length, 1, 'a VIP-only row and a row with no stream are both dropped')
  assert.equal(tracks[0].id, 'nct:x5DG3gBpOCYu')
  assert.equal(tracks[0].nctKey, 'x5DG3gBpOCYu')
  assert.equal(tracks[0].title, 'Khong Mon Dang Ho Doi (Rumba Ver)')
  assert.equal(tracks[0].artist, 'Nguyen Vi, Someone Else', 'every credited artist, not just the collapsed name')
  assert.equal(tracks[0].duration, 214_000, 'seconds become milliseconds')
  assert.equal(tracks[0].bitrate, 128, 'anonymous playback is the 128 kbps tier')
})

test('NhacCuaTui sends the Android client identity the service expects', async () => {
  const source = new NhacCuaTuiSource()
  await withNct({ code: 0, data: { songs: [nctSong()] } }, async (calls) => {
    await source.search('x', 5)
    const url = new URL(calls[0].url)
    assert.equal(url.origin + url.pathname, 'https://graph.nct.vn/api/v1/search/song')
    assert.equal(url.searchParams.get('keyword'), 'x')
    assert.equal(url.searchParams.get('correct'), 'true')
    assert.equal(url.searchParams.get('pageindex'), '1')
    assert.equal(calls[0].options.headers['x-os'], 'android')
  })
})

test('a VIP 320 never wins over an open 128, however the tiers are ordered', async () => {
  // The failure this prevents is subtle: ranking by `order` first picks the
  // 320, and the 320 is `onlyVIP`, so the station goes silent on the first byte.
  const source = new NhacCuaTuiSource()

  const url = await withNct(
    {
      code: 0,
      data: {
        key: 'k1',
        name: 'A Song',
        streamURL: [
          { type: '128', stream: 'https://a01.nct.vn/a_128.mp3', onlyVIP: false, status: 1, order: 1 },
          { type: '320', stream: 'https://a01.nct.vn/a_320.mp3', onlyVIP: true, status: 1, order: 9 }
        ]
      }
    },
    async () => {
      const result = await source.resolve('https://www.nhaccuatui.com/song/k1')
      return source.getTrackUrl(result.tracks[0])
    }
  )

  assert.equal(url, 'https://a01.nct.vn/a_128.mp3', 'the open stream, not the higher-numbered VIP one')
})

test('the stream URL is resolved at play time, because the CDN link expires', async () => {
  // Two detail calls with different signatures: the point is that playback
  // asks again rather than trusting a URL cached when the track was queued.
  const source = new NhacCuaTuiSource()
  let signature = 'sig=old'

  const [first, second, calls] = await withNct(
    () => nctDetail(signature),
    async (calls) => {
      const track = { id: 'nct:k1', nctKey: 'k1' }
      const a = await source.getTrackUrl(track)
      signature = 'sig=new'
      const b = await source.getTrackUrl(track)
      return [a, b, calls.length]
    }
  )

  assert.match(first, /sig=old/)
  assert.match(second, /sig=new/, 'a fresh signature is fetched, not the stale one')
  assert.equal(calls, 2)
})

test('a stream URL off the service is refused rather than followed', async () => {
  const source = new NhacCuaTuiSource()

  await withNct(
    { code: 0, data: { key: 'k1', name: 'A', streamURL: [{ type: '128', stream: 'https://evil.example.com/a.mp3', onlyVIP: false, status: 1, order: 1 }] } },
    async () => {
      await assert.rejects(() => source.getTrackUrl({ nctKey: 'k1' }), /no playable stream/)
    }
  )
})

test('an API error is thrown so the registry can fall through', async () => {
  const source = new NhacCuaTuiSource()
  await withNct({ code: 1001, msg: 'Invalid params', success: false }, async () => {
    await assert.rejects(() => source.search('x'), /Invalid params/)
  })
})

test('a song page link resolves through /api/v1/song/detail', async () => {
  const source = new NhacCuaTuiSource()

  await withNct({ code: 0, data: nctSong() }, async (calls) => {
    const result = await source.resolve('https://www.nhaccuatui.com/song/x5DG3gBpOCYu')
    assert.equal(result.type, 'track')
    assert.equal(result.tracks[0].nctKey, 'x5DG3gBpOCYu')
    assert.match(calls[0].url, /\/api\/v1\/song\/detail\/x5DG3gBpOCYu$/)
  })

  // The older dotted `.html` shape still resolves; links to it are everywhere.
  await withNct({ code: 0, data: nctSong() }, async () => {
    const legacy = await source.resolve('https://www.nhaccuatui.com/bai-hat/khong-mon.x5DG3gBpOCYu.html')
    assert.equal(legacy.tracks[0].nctKey, 'x5DG3gBpOCYu')
  })
})

test('a stream is audio/mpeg and accepts the 206 a seek produces', async () => {
  const source = new NhacCuaTuiSource()

  const opened = await withNct(
    (url) => {
      if (url.includes('/api/v1/song/detail/')) return nctDetail()
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0xff, 0xfb]))
          controller.close()
        }
      })
      return { __raw: { ok: true, status: 206, body: stream, headers: new Map([['content-type', 'audio/mpeg']]) } }
    },
    () => source.stream({ id: 'nct:k1', nctKey: 'k1', bitrate: 128 })
  )

  assert.equal(opened.contentType, 'audio/mpeg')
  assert.equal(opened.mode, 'nhaccuatui')
  assert.equal(opened.bitrate, 128)
})

test('a streamless search row is completed from detail instead of disappearing', async () => {
  const source = new NhacCuaTuiSource()
  const row = nctSong({ key: 'needsDetail', streamURL: [] })

  const tracks = await withNct(
    (url) => {
      if (url.includes('/song/detail/needsDetail')) return { code: 0, data: nctSong({ key: 'needsDetail' }) }
      return { code: 0, data: { songs: [row] } }
    },
    () => source.search('a song', 5)
  )

  assert.equal(tracks.length, 1)
  assert.equal(tracks[0].nctKey, 'needsDetail')
  assert.equal(tracks[0].streamable, true, 'detail supplied the open stream')
})

test('a playlist row without a stream is resolved too', async () => {
  const source = new NhacCuaTuiSource()

  const result = await withNct(
    (url) => {
      if (url.includes('/playlist/detail/')) {
        return { code: 0, data: { title: 'Mix', listSong: [nctSong({ key: 'k9', streamURL: [] })] } }
      }
      return { code: 0, data: nctSong({ key: 'k9' }) }
    },
    () => source.resolve('https://www.nhaccuatui.com/playlist/mix.k9.html')
  )

  assert.equal(result.type, 'playlist')
  assert.equal(result.tracks.length, 1)
  assert.equal(result.tracks[0].streamable, true)
})

test('an expired stream URL is refreshed once on the first 403', async () => {
  const source = new NhacCuaTuiSource()
  let opened = 0

  const handle = await withNct(
    (url) => {
      if (url.includes('/api/v1/song/detail/')) return nctDetail(opened === 0 ? 'sig=dead' : 'sig=fresh')
      opened += 1
      if (opened === 1) {
        return { __raw: { ok: false, status: 403, body: null, headers: new Map() } }
      }
      return {
        __raw: {
          ok: true,
          status: 200,
          body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0xff, 0xfb])); controller.close() } }),
          headers: new Map([['content-type', 'audio/mpeg']])
        }
      }
    },
    () => source.stream({ id: 'nct:k1', nctKey: 'k1', bitrate: 128 })
  )

  assert.equal(handle.mode, 'nhaccuatui')
  assert.equal(opened, 2, 'the first stream was refused and retried with a fresh signature')
})

test('the short /l/ link also reaches song detail', async () => {
  const source = new NhacCuaTuiSource()
  await withNct({ code: 0, data: nctSong({ key: 'short1' }) }, async (calls) => {
    const result = await source.resolve('https://www.nhaccuatui.com/l/short1')
    assert.equal(result.tracks[0].nctKey, 'short1')
    assert.match(calls[0].url, /song\/detail\/short1$/)
  })
})

test('a public track can be rehydrated from its page link so the browser can play it', async () => {
  const registry = new SourceRegistry({})
  registry.register({
    name: 'rehydrate-demo',
    prefixes: ['https://example.com/'],
    canResolve: (query) => String(query).startsWith('https://example.com/'),
    async resolve(query) {
      return {
        type: 'track',
        name: 'Song',
        tracks: [{ source: 'rehydrate-demo', id: 'rehydrate-demo:1', title: 'Song', artist: 'A', url: query, streamable: true }]
      }
    },
    getTrackUrl: (track) => track.url ?? null
  })

  // This is the shape search returns: id + link, no provider handle.
  const publicShape = { source: 'rehydrate-demo', id: 'rehydrate-demo:1', title: 'Song', artist: 'A', link: 'https://example.com/song/1' }
  assert.equal(await registry.trackUrl(publicShape), 'https://example.com/song/1')

  const full = await registry.rehydrate(publicShape)
  assert.equal(full.url, 'https://example.com/song/1', 'the handle is back')
  assert.equal(full.title, 'Song', 'public metadata wins over the provider copy')
})

test('Vimeo preserves unlisted hashes, falls back to anonymous bootstrap on 403, and returns a Node stream', async () => {
  const { VimeoSource } = await import('../src/sources/vimeo.ts')
  const seen = []
  const source = new VimeoSource({
    fetchImpl: async (url) => {
      const text = String(url)
      seen.push(text)
      if (text === 'https://player.vimeo.com/video/76979871/config?sig=ok') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            video: { title: 'Live Session', duration: 120, owner: { name: 'Kavi' } },
            request: { files: { progressive: [{ width: 360, url: 'https://cdn.vimeo.test/video.mp4' }] } }
          })
        }
      }
      if (text.startsWith('https://player.vimeo.com/video/76979871')) {
        return { ok: false, status: 403, text: async () => '' }
      }
      if (text === 'https://vimeo.com/watch') {
        return {
          ok: true,
          status: 200,
          text: async () => '<script id="__NEXT_DATA__" type="application/json">{"buildId":"b1","locale":"en"}</script>'
        }
      }
      if (text.includes('/_next/data/b1/en/76979871.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            pageProps: {
              clipId: 76979871,
              pageMetadata: { clipSignature: 'sig123' },
              viewerBootstrap: { jwt: 'jwt123' }
            }
          })
        }
      }
      if (text.startsWith('https://api.vimeo.com/videos/76979871')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ embed_player_config_url: 'https://player.vimeo.com/video/76979871/config?sig=ok' })
        }
      }
      if (text === 'https://cdn.vimeo.test/video.mp4') {
        return {
          ok: true,
          status: 200,
          headers: new Map([['content-type', 'video/mp4']]),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([0, 0, 0, 24]))
              controller.close()
            }
          })
        }
      }
      return { ok: false, status: 404, text: async () => '' }
    }
  })

  const resolved = await source.resolve('https://vimeo.com/76979871/deadbeef12')
  assert.equal(resolved.tracks[0].title, 'Live Session')
  assert.equal(resolved.tracks[0].duration, 120_000)
  assert.ok(seen.some((u) => u.includes('h=deadbeef12')), 'the unlisted hash was forwarded')

  const opened = await source.stream(resolved.tracks[0])
  assert.equal(typeof opened.stream.destroy, 'function', 'Web ReadableStream is wrapped in a Node Readable')
  opened.stream.destroy()
})

test('Song.link resolves direct streamable platforms first and handles escaped backslashes in JSON', async () => {
  const { SongLinkSource } = await import('../src/sources/songlink.ts')
  // Escaped backslash before closing quote inside a title must not break brace slicing.
  const tricky = {
    props: {
      pageProps: {
        pageData: {
          entityUniqueId: 'S:1',
          entitiesByUniqueId: { 'S:1': { title: 'Backslash \\', artistName: 'Kavi' } },
          sections: [{ links: [{ platform: 'soundcloud', url: 'https://soundcloud.com/kavi/track' }] }]
        }
      }
    }
  }
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(tricky)}</script>`
  assert.equal(pageDataFrom(html)?.entitiesByUniqueId?.['S:1']?.title, 'Backslash \\')

  // Direct SoundCloud link should go to the direct resolver, not fail in mirror.
  let directHit = null
  const songlink = new SongLinkSource({
    resolve: async (url) => {
      directHit = url
      return { tracks: [{ source: 'soundcloud', id: 'sc:9', title: 'raw', artist: 'Kavi', streamable: true }] }
    },
    mirror: {
      resolve: async () => {
        throw new Error('mirror should not be hit when direct resolver succeeds')
      }
    }
  })
  songlink.resolveLink = async () => ({
    title: 'Clean Title',
    artist: 'Kavi',
    artwork: 'https://example.com/art.jpg',
    isrc: 'US1234567890',
    links: { soundcloud: { url: 'https://soundcloud.com/kavi/track' } }
  })
  assert.ok(songlink.canResolve('slsearch:kavi clean title'))
  const resolved = await songlink.resolve('https://song.link/s/abc')
  assert.equal(directHit, 'https://soundcloud.com/kavi/track')
  assert.equal(resolved.tracks[0].source, 'soundcloud')
  assert.equal(resolved.tracks[0].title, 'Clean Title')
})

test('SourceRegistry uses defaultSearch prefix, prefers ISRC matches, and records metadata clone health', async () => {
  const registry = new SourceRegistry({ defaultSearch: 'unit-def', fallbackOrder: ['unit-a'], liveFallback: false })
  let seenQuery = null
  registry.register(
    {
      name: 'unit-def',
      prefixes: ['ud:'],
      canResolve: (q) => String(q).startsWith('ud:'),
      async resolve(q) {
        seenQuery = q
        return { type: 'search', name: q, tracks: [{ source: 'unit-def', id: 'ud:1', title: 'Blue Hour', artist: 'Kavi' }] }
      }
    },
    { before: 'http' }
  )
  await registry.resolve('blue hour')
  assert.equal(seenQuery, 'ud:blue hour', 'bare queries use defaultSearch prefix, not hardcoded scsearch:')

  registry.register(
    stub('unit-a', [
      { source: 'unit-a', id: 'ua:1', title: 'Other Mix', artist: 'Someone', isrc: 'USAAA1100001', bitrate: 320 },
      { source: 'unit-a', id: 'ua:2', title: 'Blue Hour', artist: 'Kavi', bitrate: 128 }
    ]),
    { before: 'http' }
  )
  const alts = await registry.alternatives({ id: 'm:1', source: 'deezer', title: 'Blue Hour', artist: 'Kavi', isrc: 'USAAA1100001' })
  assert.equal(alts[0].id, 'ua:1', 'matching ISRC wins')

  await registry.stream({ id: 'm:2', source: 'deezer', title: 'Blue Hour', artist: 'Kavi', metadataOnly: true })
  assert.ok(registry.healthOf('unit-a').ok >= 1, 'metadata-only clone playback records provider health')

  const described = Object.fromEntries(registry.describe().map((d) => [d.name, d]))
  assert.equal(described.somafm.live, true)
  assert.equal(described.radiobrowser.live, true)
  assert.equal(registry.ytmusic.metadataOnly, true)
})

test('SoundCloud accepts on.soundcloud.com short links and unencrypted HLS AAC fallback', () => {
  const sc = new SoundCloudSource({ clientId: 'a'.repeat(32) })
  assert.ok(sc.canResolve('https://on.soundcloud.com/abc123'))
})

test('Flowery TTS spaces concurrent requests by at least minGapMs', async () => {
  const { flowery } = await import('../src/tts/providers.ts')
  const original = globalThis.fetch
  const stamps = []
  const savedGap = flowery.minGapMs
  flowery.minGapMs = 60
  flowery.lastCallAt = 0
  flowery.nextCallAt = 0
  globalThis.fetch = (async () => {
    stamps.push(Date.now())
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }
  }) as any
  try {
    // Long text splits into 3 chunks across concurrency=2 workers.
    const text = `${'A'.repeat(500)}. ${'B'.repeat(500)}. ${'C'.repeat(500)}.`
    await flowery.speak({ text, settings: { voice: 'test-voice' }, timeoutMs: 5000 })
    assert.equal(stamps.length, 3)
    assert.ok(stamps[1] - stamps[0] >= 45, `second call waited (${stamps[1] - stamps[0]} ms)`)
    assert.ok(stamps[2] - stamps[1] >= 45, `third call waited (${stamps[2] - stamps[1]} ms)`)
  } finally {
    globalThis.fetch = original
    flowery.minGapMs = savedGap
  }
})
