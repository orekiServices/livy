/**
 * What survives a restart, and what plays when nobody said what to play.
 *
 * Both of these are about a node that is supposed to run for months on a
 * machine that will be rebooted: it should come back in the middle of the
 * song it was playing, with the queue it had, and it should never simply
 * run out of music at four in the morning.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import Memory, { slimTrack, worthResuming } from '../src/core/memory.js'
import SmartQueue, { seedsFrom, fingerprint } from '../src/core/smartQueue.js'
import Station from '../src/core/station.js'
import Store from '../src/store/index.js'
import { SourceRegistry } from '../src/sources/index.js'
import { probeMp3 } from '../src/util/metro.js'
import { quietLogs, tmpdir, makeMedia, waitFor } from './helpers.js'

quietLogs()

const storeIn = (dir) => Store.open(path.join(dir, 'livy.db'), { migrate: true })

const localStation = (dir, config = {}, extras = {}) => {
  const sources = new SourceRegistry({ mediaDir: dir, hiRes: false, liveFallback: false })
  return new Station(
    {
      id: 'fm',
      name: 'Memory FM',
      playlists: [`local:${dir}`],
      shuffle: false,
      autoStart: false,
      burstMs: 0,
      bufferAheadMs: 3000,
      automix: { enabled: false },
      autoplay: false,
      intro: null,
      ...config
    },
    sources,
    extras
  )
}

/* ------------------------------- memory ------------------------------- */

test('a track is remembered small, and only when it is worth resuming', () => {
  const track = {
    id: 'local:abc',
    source: 'local',
    title: 'A Song',
    artist: 'Someone',
    duration: 300_000,
    url: '/music/a.mp3',
    waveform: new Array(10_000).fill(0.5), // the kind of thing we must not store
    frames: [Buffer.alloc(1024)]
  }

  const slim = slimTrack(track)
  assert.equal(slim.title, 'A Song')
  assert.equal(slim.url, '/music/a.mp3')
  assert.equal(slim.waveform, undefined, 'analysis data is not memory')
  assert.equal(slim.frames, undefined, 'and neither is audio')
  assert.ok(JSON.stringify(slim).length < 400, 'a remembered track is a few hundred bytes')

  const now = Date.now()
  assert.equal(worthResuming({ track: slim, positionMs: 120_000, at: now }), true)
  assert.equal(worthResuming({ track: slim, positionMs: 3000, at: now }), false, 'barely started — play it again')
  assert.equal(worthResuming({ track: slim, positionMs: 295_000, at: now }), false, 'nearly over — move on')
  assert.equal(worthResuming({ track: slim, positionMs: 120_000, at: now - 8 * 3600_000 }), false, 'yesterday')
  assert.equal(worthResuming({ track: { ...slim, announcement: true }, positionMs: 60_000, at: now }), false, 'an ident')
  assert.equal(worthResuming({ track: { ...slim, live: true }, positionMs: 60_000, at: now }), false, 'a relay')
  assert.equal(worthResuming(null), false)
})

test('memory is written rarely and read back whole', async () => {
  const dir = tmpdir('memory-')
  const store = await storeIn(dir)
  const memory = new Memory({ store, saveEveryMs: 50 })

  const station = {
    id: 'fm',
    state: 'playing',
    current: { track: { id: 't1', title: 'One', artist: 'A', duration: 200_000 }, positionMs: 42_000 },
    queue: [{ id: 't2', title: 'Two', artist: 'B' }]
  }

  assert.equal(memory.save(station, { force: true }), true)
  // A station changes position 25 times a second; the throttle is the point.
  assert.equal(memory.save(station), false)
  assert.equal(memory.save(station), false)
  assert.ok(memory.stats().skipped >= 2)

  const recalled = memory.recall('fm')
  assert.equal(recalled.track.title, 'One')
  assert.equal(recalled.positionMs, 42_000)
  assert.equal(recalled.queue.length, 1)
  assert.equal(recalled.queue[0].title, 'Two')
  assert.equal(recalled.state, 'playing')

  // One row per station, rewritten: the table cannot grow.
  station.current.positionMs = 90_000
  memory.save(station, { force: true })
  assert.equal(memory.recall('fm').positionMs, 90_000)
  assert.equal(store.db.all('SELECT * FROM station_memory').length, 1)

  memory.forget('fm')
  assert.equal(memory.recall('fm'), null)
  store.close()
})

test('recent plays come from RAM first and SQLite after', async () => {
  const dir = tmpdir('memory-hot-')
  const store = await storeIn(dir)
  const memory = new Memory({ store })

  for (let i = 0; i < 5; i += 1) {
    memory.played('fm', { id: `hot-${i}`, title: `Hot ${i}`, artist: 'Live' })
  }
  store.savePlay({ stationId: 'fm', track: { id: 'cold-1', title: 'Cold', artist: 'Old', source: 'local' } })

  const recent = memory.recent('fm', 10)
  assert.equal(recent[0].title, 'Hot 4', 'newest first')
  assert.ok(recent.some((entry) => entry.title === 'Cold'), 'and the database fills the rest in')

  // RAM is capped, whatever happens.
  for (let i = 0; i < 200; i += 1) memory.played('fm', { id: `x-${i}`, title: `X ${i}` })
  assert.ok(memory.stats().hotTracks <= 20, `hot history stays small (${memory.stats().hotTracks})`)
  store.close()
})

test('a station comes back mid-song after a restart', async (t) => {
  const dir = tmpdir('resume-')
  makeMedia(dir, { count: 3, ms: 30_000 })
  const store = await storeIn(dir)
  const memory = new Memory({ store, saveEveryMs: 10 })

  // First life: play, get a little way in, write it down.
  const first = localStation(dir, {}, { store, memory })
  await first.load()
  await first.start()
  await waitFor(() => first.current?.track, { label: 'on air' })

  const playing = first.current.track
  // Eighteen seconds into a thirty second track: far enough in to be worth
  // resuming, with real audio still to come.
  first.current.positionMs = 18_000
  memory.save(first, { force: true })
  first.destroy()

  // Second life: same station, same memory.
  const second = localStation(dir, {}, { store, memory })
  await second.load()
  const resumed = second.resumeFromMemory()

  assert.equal(resumed.resumed, true)
  assert.equal(Math.round(resumed.positionMs / 1000), 18)
  assert.equal(second.queue[0].title, playing.title, 'the song that was playing is next')
  assert.equal(second.queue[0].resumeMs, 18_000, 'with the offset to seek to')

  // And it really seeks: the pacer reports the resumed position, not zero.
  await second.start()
  await waitFor(() => second.current?.track?.title === playing.title, { label: 'resumed track on air' })
  assert.ok(second.current.positionMs >= 18_000, `clock continues from the offset (${Math.round(second.current.positionMs)}ms)`)

  const listener = second.subscribe({ label: 'test' })
  const heard = []
  listener.on('data', (chunk) => heard.push(chunk))
  await waitFor(() => Buffer.concat(heard).length > 8000, { label: 'audio' })
  assert.ok(probeMp3(Buffer.concat(heard)).frames > 10, 'and it is really playing audio')

  listener.destroy()
  second.destroy()
  store.close()
})

test('a restart that lands on an ident does not try to resume it', async (t) => {
  const dir = tmpdir('resume-ident-')
  makeMedia(dir, { count: 2, ms: 4000 })
  const store = await storeIn(dir)
  const memory = new Memory({ store })

  const station = localStation(dir, {}, { store, memory })
  await station.load()
  const queued = station.queue.length

  memory.save(
    {
      id: 'fm',
      state: 'playing',
      current: { track: { id: 'tts:x', title: 'Station ident', announcement: true, duration: 0 }, positionMs: 30_000 },
      queue: station.queue.map((track) => ({ id: track.id, title: track.title }))
    },
    { force: true }
  )

  const resumed = station.resumeFromMemory()
  assert.equal(resumed.resumed, false, 'idents are not resumed')
  assert.equal(station.queue.length, queued, 'and nothing was pushed to the front')
  station.destroy()
  store.close()
})

/* ----------------------------- smart queue ---------------------------- */

test('seeds follow the station, not just the last record', () => {
  const history = [
    { title: 'One', artist: 'Aphex Twin' },
    { title: 'Two', artist: 'Aphex Twin' },
    { title: 'Three', artist: 'Boards of Canada' },
    { title: 'Four', artist: 'Autechre' }
  ]
  const seeds = seedsFrom(history, { limit: 3 })
  assert.deepEqual(
    seeds.map((seed) => seed.text),
    ['Aphex Twin', 'Boards of Canada', 'Autechre'],
    'one seed per artist, newest first'
  )

  // Untagged files: fall back to words from the titles.
  const untitled = seedsFrom([{ title: 'long ambient evening piece', artist: '' }], { limit: 2 })
  assert.equal(untitled[0].kind, 'title')
  assert.ok(untitled[0].text.length > 0)

  // The same recording from two sources must look the same.
  assert.equal(fingerprint({ artist: 'Daft Punk', title: 'Get Lucky (Official Video)' }), fingerprint({ artist: 'Daft punk', title: 'Get Lucky' }))
  assert.notEqual(fingerprint({ artist: 'A', title: 'One' }), fingerprint({ artist: 'A', title: 'Two' }))
})

test('autoplay refills a dry queue without repeating itself', async () => {
  const played = [
    { id: 'p1', title: 'Song One', artist: 'Known Artist' },
    { id: 'p2', title: 'Song Two', artist: 'Known Artist' }
  ]

  // A registry that answers with a catalogue, including things already played.
  const sources = {
    search: async (query) => [
      { id: 'p1', title: 'Song One', artist: 'Known Artist' }, // already played (id)
      { id: 'x9', title: 'song one', artist: 'known artist' }, // already played (same song, other id)
      { id: 'n1', title: 'New One', artist: 'Known Artist' },
      { id: 'n2', title: 'New Two', artist: 'Known Artist' }, // same artist twice
      { id: 'n3', title: 'New Three', artist: 'Another Artist' },
      { id: 'n4', title: 'Not Playable', artist: 'Third', streamable: false },
      { id: 'n5', title: 'New Five', artist: 'Fourth', seed: query }
    ]
  }

  const memory = { recent: () => played }
  const smart = new SmartQueue({ sources, memory, options: { batch: 3, perArtist: 1, minQueue: 2 } })

  const station = { id: 'fm', queue: [], current: { track: played[0] }, enqueue(tracks) { this.queue.push(...tracks) } }
  const picked = await smart.suggest(station)

  const ids = picked.map((track) => track.id)
  assert.equal(picked.length, 3)
  assert.ok(!ids.includes('p1'), 'nothing already played')
  assert.ok(!ids.includes('x9'), 'and not the same song under another id')
  assert.ok(!ids.includes('n4'), 'nothing unplayable')
  assert.equal(new Set(picked.map((track) => track.artist)).size, 3, 'one per artist')
  assert.ok(picked.every((track) => track.autoplay === true), 'and it is marked as autoplay')

  // Refill only happens when the queue is actually short.
  assert.equal(await smart.refill({ ...station, queue: [1, 2, 3] }), 0)
  const added = await smart.refill(station)
  assert.ok(added > 0)
  assert.equal(station.queue.length, added)

  // Switched off, it does nothing at all.
  smart.configure({ enabled: false })
  assert.equal(await smart.refill({ ...station, queue: [] }), 0)
})

test('autoplay never breaks a station when the sources are useless', async () => {
  const memory = { recent: () => [{ id: 'p1', title: 'One Fine Day', artist: 'Someone Known' }] }
  const station = { id: 'fm', queue: [], current: null, enqueue() {} }

  const angry = new SmartQueue({ sources: { search: async () => { throw new Error('offline') } }, memory })
  assert.deepEqual(await angry.suggest(station), [], 'a search that throws is not an outage')

  const empty = new SmartQueue({ sources: { search: async () => [] }, memory })
  assert.deepEqual(await empty.suggest(station), [])
  assert.equal(empty.stats.empty, 1)

  const noHistory = new SmartQueue({ sources: { search: async () => [{ id: 'x', title: 'X' }] }, memory: { recent: () => [] } })
  assert.deepEqual(await noHistory.suggest(station), [], 'nothing to go on, nothing invented')
  assert.equal(noHistory.stats.refills, 0)
})
