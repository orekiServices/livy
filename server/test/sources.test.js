/**
 * The source registry: which provider claims a query, how a low-bitrate copy
 * is upgraded, and how the station keeps playing when a link dies.
 *
 * Nothing here touches the network. The built-ins are only asked *which* of
 * them recognises a query (pure string work), and every resolve/stream path
 * is driven through stub providers registered the same way a plugin would
 * register one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { SourceRegistry, similarity, fingerprintOf } from '../src/sources/index.js'
import YtMusicSource from '../src/sources/ytmusic.js'
import { quietLogs, tmpdir, makeMedia } from './helpers.js'

quietLogs()

/** A provider that serves a fixed catalogue and counts what it was asked. */
function stubSource(name, tracks = [], { fail = false, prefixes = [] } = {}) {
  const calls = { search: 0, resolve: 0, stream: 0 }
  return {
    name,
    prefixes,
    calls,
    canResolve: (query) => prefixes.some((p) => String(query).toLowerCase().startsWith(p)),
    async resolve(query) {
      calls.resolve += 1
      return { type: 'track', name: query, tracks: tracks.slice(0, 1) }
    },
    async search(_query, limit = 10) {
      calls.search += 1
      return tracks.slice(0, limit)
    },
    async stream(track) {
      calls.stream += 1
      if (fail) throw new Error(`${name} is down`)
      return { stream: `stream:${track.id}`, contentType: 'audio/mpeg', mode: name }
    }
  }
}

const registry = (config = {}) => new SourceRegistry({ hiRes: false, liveFallback: false, ...config })
const claimant = (sources, query) => sources.sources.find((source) => source.canResolve(query))?.name

test('queries go to the provider that recognises them', () => {
  const sources = registry()

  assert.equal(claimant(sources, 'scsearch:blue hour'), 'soundcloud')
  assert.equal(claimant(sources, 'https://soundcloud.com/kavi/blue-hour'), 'soundcloud')
  assert.equal(claimant(sources, 'local:jingle.mp3'), 'local')
  assert.equal(claimant(sources, '/srv/media/ident.mp3'), 'local')
  assert.equal(claimant(sources, 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'), 'mirror')
  assert.equal(claimant(sources, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'mirror')
  assert.equal(claimant(sources, 'https://feeds.megaphone.fm/darknetdiaries'), 'podcast')
  assert.equal(claimant(sources, 'https://cdn.example.com/stream.mp3'), 'http', 'http is the catch-all, and it is last')
  assert.equal(claimant(sources, 'just some words'), undefined, 'bare text has no claimant…')
  assert.equal(sources.defaultSearch, 'soundcloud', '…so it falls to the default search provider')
})

test('similarity recognises the same recording and rejects a different one', () => {
  const track = { artist: 'Kavi', title: 'Blue Hour (Official Audio) [HD]' }
  assert.ok(similarity(track, { artist: 'Kavi', title: 'Blue Hour' }) > 0.9, 'noise words are stripped')
  assert.ok(similarity(track, { artist: 'Kavi', title: 'Blue Hour - Remastered' }) > 0.6)
  assert.ok(similarity(track, { artist: 'Mira', title: 'Golden Gate' }) < 0.2)
  assert.equal(similarity({ title: '' }, { title: 'Anything' }), 0)

  // Stripping decoration must not eat titles that *are* decoration words.
  assert.equal(
    fingerprintOf({ artist: 'Taylor Swift', title: 'Clean' }),
    'taylor swift clean',
    '"Clean" is a title, not a release tag'
  )
  assert.match(fingerprintOf({ artist: 'Tom Petty', title: 'Free Fallin\'' }), /free fallin/, '"Free" is a title too')
  assert.equal(fingerprintOf({ artist: 'Kavi', title: 'Song - Official Audio' }), 'kavi song', 'a trailing tag still goes')
})

test('the local source reads a real folder and streams real bytes', async () => {
  const dir = tmpdir('local-')
  const names = makeMedia(dir, { count: 2, ms: 2000, artist: 'Kavi' })
  const sources = registry({ mediaDir: dir })

  const folder = await sources.resolve(`local:${dir}`)
  assert.equal(folder.type, 'playlist')
  assert.equal(folder.tracks.length, names.length)
  assert.equal(folder.source, 'local')
  const [first] = folder.tracks
  assert.equal(first.artist, 'Kavi', 'the "artist - title" filename convention is honoured')
  assert.match(first.title, /^Track \d$/)

  const opened = await sources.stream(first)
  assert.equal(opened.mode, 'local')
  assert.equal(opened.attempts, 1)
  const chunks = []
  for await (const chunk of opened.stream) chunks.push(chunk)
  assert.equal(Buffer.concat(chunks).length, fs.statSync(path.join(dir, names[0])).size)

  await assert.rejects(sources.resolve('local:missing.mp3'), /not found/i)
})

test('a plugin can add a provider in front of the catch-all, and take it away again', async () => {
  const sources = registry()
  const fake = stubSource('unit-stream', [{ id: 'u1', source: 'unit-stream', title: 'Hello' }], { prefixes: ['unit:'] })

  sources.register(fake)
  assert.ok(sources.sources.indexOf(fake) < sources.sources.findIndex((s) => s.name === 'http'), 'it sits in front of http')
  assert.equal(claimant(sources, 'unit:hello'), 'unit-stream')
  assert.equal((await sources.resolve('unit:hello')).source, 'unit-stream')
  assert.equal(sources.get('unit-stream'), fake)

  assert.throws(() => sources.register(fake), /already exists/)
  assert.throws(() => sources.register({ name: 'broken' }), /needs/)

  assert.equal(sources.unregister('unit-stream'), true)
  assert.equal(sources.get('unit-stream'), undefined)
  assert.equal(claimant(sources, 'unit:hello'), undefined)
  assert.equal(sources.unregister('unit-stream'), false, 'removing it twice is not an error')
})

test('a low-bitrate track is re-cloned at higher quality — but only when the match is convincing', async () => {
  const cheap = { id: 'sc1', source: 'soundcloud', title: 'Blue Hour', artist: 'Kavi', duration: 214, bitrate: 128 }
  const hifi = { id: 'ar1', source: 'unit-hifi', title: 'Blue Hour', artist: 'Kavi', duration: 215, bitrate: 320 }
  const wrong = { id: 'ar2', source: 'unit-hifi', title: 'Golden Gate', artist: 'Mira', duration: 180, bitrate: 320 }

  const sources = registry({ hiRes: true, hiResMinKbps: 192, fallbackOrder: ['unit-hifi'] })
  const hifiSource = stubSource('unit-hifi', [wrong, hifi])
  sources.register(hifiSource)

  const upgraded = await sources.prepare(cheap)
  assert.equal(upgraded.id, 'ar1', 'the matching hi-res copy wins')
  assert.equal(upgraded.bitrate, 320)
  assert.deepEqual(upgraded.upgradedFrom, { id: 'sc1', source: 'soundcloud', bitrate: 128 })

  // Second call for the same track is served from the alternatives cache.
  const searches = hifiSource.calls.search
  await sources.prepare({ ...cheap })
  assert.equal(hifiSource.calls.search, searches, 'the clone lookup is cached')

  // A track that has no convincing copy is left exactly as it was.
  const orphan = { id: 'sc2', source: 'soundcloud', title: 'Nothing Like It', artist: 'Nobody', duration: 100, bitrate: 128 }
  assert.equal((await sources.prepare(orphan)).id, 'sc2')

  // Neither idents nor live relays are ever "upgraded".
  const ident = { id: 'tts1', source: 'tts', title: 'You are listening to Test FM', announcement: true }
  assert.equal(await sources.prepare(ident), ident)
  assert.equal(await sources.prepare({ ...cheap, live: true }).then((t) => t.id), 'sc1')
})

test('a dead link falls back to the same recording on another provider', async () => {
  const dead = { id: 'sc1', source: 'unit-dead', title: 'Blue Hour', artist: 'Kavi', duration: 214, bitrate: 128 }
  const clone = { id: 'al1', source: 'unit-alive', title: 'Blue Hour', artist: 'Kavi', duration: 216, bitrate: 192 }

  const sources = registry({ fallbackOrder: ['unit-alive'] })
  const broken = stubSource('unit-dead', [dead], { fail: true })
  const alive = stubSource('unit-alive', [clone])
  sources.register(broken)
  sources.register(alive)

  const opened = await sources.stream(dead)
  assert.equal(opened.mode, 'unit-alive')
  assert.equal(opened.track.id, 'al1')
  assert.equal(opened.fallback, true)
  assert.equal(opened.attempts, 2, 'the original was tried first')
  assert.equal(broken.calls.stream, 1)

  // …unless the item is a spoken announcement, which has no equivalent.
  const ident = { id: 'tts1', source: 'unit-dead', title: 'Ident', announcement: true }
  await assert.rejects(sources.stream(ident), /unit-dead is down/)

  // …and when everything is dead the error names every provider tried.
  const allDead = registry({ fallbackOrder: ['unit-dead2'] })
  allDead.register(stubSource('unit-dead2', [], { fail: true }))
  await assert.rejects(allDead.stream({ id: 'x', source: 'unit-dead2', title: 'Gone' }), /All sources failed for "Gone"/)
})

test('a metadata-only provider is played through a clone that keeps its tags', async () => {
  const deezerish = {
    id: 'dz1',
    source: 'unit-meta',
    title: 'Blue Hour',
    artist: 'Kavi',
    duration: 214,
    artwork: 'https://example.com/cover.jpg',
    metadataOnly: true
  }
  const clone = { id: 'au1', source: 'unit-audio', title: 'blue hour (kavi)', artist: 'Kavi', duration: 215, bitrate: 192, artwork: null }

  const sources = registry({ fallbackOrder: ['unit-audio'] })
  const meta = stubSource('unit-meta', [deezerish])
  meta.metadataOnly = true
  sources.register(meta)
  sources.register(stubSource('unit-audio', [clone]))

  const opened = await sources.stream(deezerish)
  assert.equal(opened.mode, 'unit-audio', 'the audio comes from the clone')
  assert.equal(opened.track.title, 'Blue Hour', 'but the good metadata is kept')
  assert.equal(opened.track.artwork, 'https://example.com/cover.jpg')
  assert.equal(opened.track.clonedFrom, 'dz1')
  assert.equal(meta.calls.stream, 0, 'the metadata provider is never asked for audio')
})

test('search merges providers, honours a single-provider request, and ranks quality first', async () => {
  const sources = registry({ hiRes: true })
  const mine = stubSource('unit-search', [
    { id: 'a', source: 'unit-search', title: 'A', bitrate: 128 },
    { id: 'b', source: 'unit-search', title: 'B', bitrate: 320 }
  ])
  sources.register(mine)

  const results = await sources.search('anything', 5, 'unit-search')
  assert.deepEqual(
    results.map((t) => t.id),
    ['a', 'b']
  )
  assert.equal(mine.calls.search, 1)

  await assert.rejects(sources.search('x', 5, 'nope'), /cannot search/)

  const noSearch = stubSource('unit-nosearch', [])
  delete noSearch.search
  sources.register(noSearch)
  await assert.rejects(sources.search('x', 5, 'unit-nosearch'), /cannot search/)
})

/* ------------------------- ranked multi-source ------------------------ */

test('search ranks by what you asked for, not by bitrate', () => {
  const registry = new SourceRegistry({ hiRes: true })

  const candidates = [
    { id: 'a', source: 'archive', artist: 'Field Recordings', title: 'Rain on a tent', bitrate: 320 },
    { id: 'b', source: 'soundcloud', artist: 'Daft Punk', title: 'Get Lucky', bitrate: 128 },
    { id: 'c', source: 'audius', artist: 'Cover Band', title: 'Get Lucky (cover)', bitrate: 320 },
    { id: 'd', source: 'ytmusic', artist: 'Daft Punk', title: 'Get Lucky', streamable: false, metadataOnly: true }
  ]

  const ranked = registry.rank('daft punk get lucky', candidates, 10)

  assert.equal(ranked[0].id, 'b', 'the song you asked for comes first, at 128 kbps')
  assert.ok(
    ranked.findIndex((track) => track.id === 'a') > 0,
    'a 320 kbps recording of rain does not win a search for Daft Punk'
  )
  // Metadata-only entries are collapsed into the playable copy of the same
  // song, so a listener never taps a result that cannot play.
  assert.ok(!ranked.some((track) => track.streamable === false), 'nothing unplayable in the list')
  assert.ok(ranked.every((track) => typeof track.searchScore === 'number'), 'and every row says how well it matched')
})

test('the same song from three providers appears once', () => {
  const registry = new SourceRegistry({})
  const ranked = registry.rank('get lucky', [
    { id: '1', source: 'soundcloud', artist: 'Daft Punk', title: 'Get Lucky' },
    { id: '2', source: 'audius', artist: 'daft punk', title: 'Get Lucky ' },
    { id: '3', source: 'bandcamp', artist: 'Daft Punk', title: 'Get Lucky (Official Video)' },
    { id: '4', source: 'audius', artist: 'Daft Punk', title: 'Around the World' }
  ])

  assert.equal(ranked.length, 2, 'one row for Get Lucky, one for Around the World')
  assert.equal(ranked[0].title.includes('Get Lucky'), true)
})

test('sources that would answer every query stay out of a general search', () => {
  const registry = new SourceRegistry({})
  for (const name of ['tts', 'http', 'mirror', 'radiobrowser']) {
    assert.ok(registry.noSearch.has(name), `${name} is not part of "search everywhere"`)
  }
  // …but they can still be asked directly.
  assert.ok(registry.get('radiobrowser')?.search, 'radio-browser can still be searched by name')
})

test('YouTube Music is a card index: it names songs and mirrors them', async () => {
  const wanted = { id: 'ytmusic:abc', artist: 'Tycho', title: 'Awake', duration: 284_000, streamable: false }

  const ytmusic = new YtMusicSource({
    search: async () => [
      { id: 'sc:1', source: 'soundcloud', artist: 'Tycho', title: 'Awake', duration: 285_000, streamable: true },
      { id: 'sc:2', source: 'soundcloud', artist: 'Someone', title: 'Awake (cover)', duration: 200_000, streamable: true }
    ],
    similarity,
    fetchImpl: async () => ({
      ok: true,
      // Shaped like a real InnerTube answer: the text lives in `runs`,
      // in the order the app shows it.
      json: async () => ({
        contents: {
          musicResponsiveListItemRenderer: {
            flexColumns: [
              { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Awake' }] } } },
              { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Tycho' }, { text: ' • ' }, { text: '4:44' }] } } }
            ],
            playlistItemData: { videoId: 'abc' }
          }
        }
      })
    })
  })

  const found = await ytmusic.search('tycho awake', 3)
  assert.equal(found.length, 1)
  assert.equal(found[0].title, 'Awake')
  assert.equal(found[0].artist, 'Tycho')
  assert.equal(found[0].duration, 284_000)
  assert.equal(found[0].streamable, false, 'the catalogue does not serve audio')
  assert.equal(found[0].link, 'https://music.youtube.com/watch?v=abc')

  // Resolving hands the metadata to a provider that can actually play it.
  const resolved = await ytmusic.resolve('ytm:tycho awake')
  const track = resolved.tracks[0]
  assert.equal(track.source, 'soundcloud', 'it plays from somewhere real')
  assert.equal(track.mirroredFrom, 'ytmusic')
  assert.equal(track.title, 'Awake', 'with the catalogue’s idea of the title')
  assert.notEqual(track.id, wanted.id)
})
