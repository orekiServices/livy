/**
 * A station is a channel that has to keep playing. These tests run real
 * stations off real MP3 files on disk — the pacer, the frame buffer, the
 * request line and the listener plumbing are all exercised for real; only the
 * network is absent.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import Station, { publicTrack } from '../src/core/station.ts'
import StationManager from '../src/core/stationManager.ts'
import { SourceRegistry } from '../src/sources/index.ts'
import { probeMp3 } from '../src/util/mp3.ts'
import { quietLogs, tmpdir, makeMedia, waitFor, waitEvent } from './helpers.ts'

quietLogs()

/** A station fed from a folder of generated MP3s. Nothing leaves the machine. */
function localStation(config: any = {}, { count = 3, ms = 1500 }: any = {}) {
  const dir = tmpdir('station-')
  makeMedia(dir, { count, ms })
  const sources = new SourceRegistry({ mediaDir: dir, hiRes: false, liveFallback: false })
  const station = new Station(
    {
      id: 'test-fm',
      name: 'Test FM',
      playlists: [`local:${dir}`],
      shuffle: false,
      autoStart: false,
      burstMs: 500,
      bufferAheadMs: 2000,
      quality: 'normal',
      automix: { enabled: false },
      intro: null,
      ...config
    },
    sources,
    { store: config.store ?? null }
  )
  return { station, sources, dir }
}

const collect = (stream: any, ms: number): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks = []
    const onData = (chunk) => chunks.push(chunk)
    stream.on('data', onData)
    setTimeout(() => {
      stream.off('data', onData)
      resolve(Buffer.concat(chunks))
    }, ms)
  })

test('a station loads its playlist and reports itself without leaking internals', async () => {
  const { station, dir } = localStation()
  await station.load()

  assert.equal(station.queue.length, 3)
  assert.equal(station.state, 'loading')

  const info = station.info({ queue: true })
  assert.equal(info.id, 'test-fm')
  assert.equal(info.stream, '/stream/test-fm.mp3')
  assert.equal(info.contentType, 'audio/mpeg')
  assert.equal(info.queueLength, 3)
  assert.equal(info.allowRequests, false)

  // publicTrack is an allow-list: the local file path must not be in there.
  const serialised = JSON.stringify(info)
  assert.ok(!serialised.includes(dir), 'no filesystem paths reach a listener')
  assert.equal(info.queue[0].url, undefined)
  assert.deepEqual(Object.keys(publicTrack({ id: 'x', title: 't', url: '/secret/file.mp3', apiKey: 'nope' })).includes('url'), false)

  station.destroy()
})

test('a listener gets real, continuous MP3 audio in real time', async (t) => {
  const { station } = localStation()
  t.after(() => station.destroy())

  await station.load()
  await station.start()

  const stream = station.subscribe({ label: 'test' })
  const audio = await collect(stream, 1200)

  assert.ok(audio.length > 4000, `expected a real stream, got ${audio.length} bytes`)
  const probe = probeMp3(audio)
  assert.ok(probe.frames > 20, 'a whole stream of frames')
  assert.equal(probe.bitrate, 128)

  // The pacer runs in real time: a second and a bit of wall clock is a
  // second and a bit of audio, plus whatever burst the listener joined on.
  assert.ok(probe.durationMs > 900 && probe.durationMs < 3000, `paced to real time, got ${probe.durationMs.toFixed(0)}ms`)

  const np = station.nowPlaying()
  assert.ok(np, 'something is on air')
  assert.equal(np.station, 'test-fm')
  assert.match(np.title, / - /, 'the ICY title is "artist - title"')
  assert.equal(station.listeners, 1)
  assert.ok(station.stats.bytesOut > 0)
})

test('a new listener starts instantly thanks to the burst buffer', async (t) => {
  const { station } = localStation()
  t.after(() => station.destroy())
  await station.load()
  await station.start()
  await waitFor(() => station.state === 'playing', { label: 'playing' })

  const stream = station.subscribe({ label: 'late' })
  const firstChunk = await new Promise<Buffer>((resolve) => stream.once('data', resolve))
  assert.ok(firstChunk.length > 0, 'audio arrives on the very first tick, not after a track change')

  const quiet = station.subscribe({ label: 'no-burst', burst: false })
  assert.equal(station.listeners, 2)
  quiet.destroy()
  await waitFor(() => station.listeners === 1, { label: 'listener removed' })
})

test('skip() drops the rest of the track and moves on', async (t) => {
  const { station } = localStation({}, { count: 3, ms: 3000 })
  t.after(() => station.destroy())
  await station.load()
  await station.start()
  await waitFor(() => station.current?.track, { label: 'on air' })

  const first = station.current.track.id
  const changed = waitEvent(station, 'track')
  assert.equal(station.skip(), true)
  await changed
  assert.notEqual(station.current.track.id, first, 'a different track is on air')
  assert.equal(station.history[0].id, first, 'and the skipped one went to history')
})

test('the request line: cooldowns, duplicates, votes and ordering', async (t) => {
  const { station, dir } = localStation({
    allowRequests: true,
    requestCooldownMs: 0,
    maxPendingPerUser: 2,
    autoStart: false
  })
  t.after(() => station.destroy())
  await station.load()

  const files = station.queue.map((track) => track.url)
  const ask = (file, by) => station.request({ query: `local:${file}`, by, requesterId: by })

  const first = await ask(files[0], 'ana')
  assert.equal(first.position, 1)
  assert.equal(first.request.votes, 1)

  await assert.rejects(ask(files[0], 'ben'), /already on air or queued/)

  const second = await ask(files[1], 'ben')
  assert.equal(second.position, 2, 'a one-vote request queues behind the earlier one')

  // Votes reorder the line; a second vote from the same listener does not.
  station.voteRequest(second.request.id, 'cara')
  assert.equal(station.requestPosition(second.request.id), 1, 'the most wanted track moves to the front')
  assert.throws(() => station.voteRequest(second.request.id, 'cara'), /already voted/)
  assert.throws(() => station.voteRequest('nope', 'cara'), /No such request/)

  await ask(files[2], 'ana')
  await assert.rejects(ask(path.join(dir, 'missing.mp3'), 'ana'), /You already have 2 pending requests/)

  const line = station.publicRequests()
  assert.deepEqual(
    line.map((r) => r.by),
    ['ben', 'ana', 'ana'],
    'the public view is sorted by votes, then by time'
  )
  assert.ok(!JSON.stringify(line).includes(dir), 'requests do not leak file paths either')

  assert.ok(station.removeRequest(line[0].id))
  assert.equal(station.requests.length, 2)

  // A station that does not take requests says so with a 403.
  const closed = localStation({ allowRequests: false })
  await assert.rejects(closed.station.request({ query: 'anything' }), (error: any) => {
    assert.equal(error.status, 403)
    return true
  })
  closed.station.destroy()
})

test('vote-skip needs half the room', async (t) => {
  const { station } = localStation({ allowRequests: true, voteSkipRatio: 0.5 }, { count: 3, ms: 3000 })
  t.after(() => station.destroy())
  await station.load()
  await station.start()
  await waitFor(() => station.current?.track, { label: 'on air' })

  const listeners = [station.subscribe({ label: 'l1' }), station.subscribe({ label: 'l2' }), station.subscribe({ label: 'l3' })]
  t.after(() => listeners.forEach((stream) => stream.destroy()))

  const first = station.voteSkip('ana')
  assert.deepEqual({ votes: first.votes, needed: first.needed, passed: first.passed }, { votes: 1, needed: 2, passed: false })

  const playing = station.current.track.id
  const second = station.voteSkip('ben')
  assert.equal(second.passed, true, 'two out of three carries the vote')
  await waitFor(() => station.current?.track?.id !== playing, { label: 'skipped' })
  assert.equal(station.voteSkips.size, 0, 'the tally resets for the new track')
})

test('an owner announcement jumps the queue and is never crossfaded', async (t) => {
  const { station, dir } = localStation({}, { count: 2, ms: 2500 })
  t.after(() => station.destroy())
  await station.load()
  await station.start()
  await waitFor(() => station.current?.track, { label: 'on air' })

  const ident = { id: 'ident-1', source: 'local', title: 'Test FM ident', artist: 'Station', url: path.join(dir, 'Test Artist - Track 1.mp3'), announcement: true }
  station.playAnnouncement(ident, { immediate: true })
  await waitFor(() => station.current?.track?.id === 'ident-1', { timeout: 8000, label: 'ident on air' })
  assert.equal(station.current.track.announcement, true)
})

test('the manager keeps stations apart and cleans up after itself', () => {
  const dir = tmpdir('manager-')
  makeMedia(dir, { count: 2, ms: 1200 })
  const sources = new SourceRegistry({ mediaDir: dir, hiRes: false, liveFallback: false })
  const manager = new StationManager({ defaults: { autoStart: false, automix: { enabled: false } }, sources })

  const events = []
  manager.on('added', (station) => events.push(`added:${station.id}`))
  manager.on('removed', (station) => events.push(`removed:${station.id}`))

  const lofi = manager.add({ name: 'Lo-Fi Nights', playlists: [`local:${dir}`] })
  manager.add({ id: 'jazz', name: 'Jazz Club', playlists: [`local:${dir}`] })

  assert.equal(lofi.id, 'lo-fi-nights', 'the id is slugged from the name')
  assert.equal(manager.size, 2)
  assert.throws(() => manager.add({ id: 'jazz' }), /already exists/)
  assert.throws(() => manager.add({}), /needs an id or name/)

  assert.equal(manager.find('JAZZ').id, 'jazz')
  assert.equal(manager.find('lo-fi').id, 'lo-fi-nights', 'partial names resolve')
  assert.equal(manager.find('nothing here'), undefined)

  manager.update('jazz', { name: 'Jazz Club Deluxe', allowRequests: true })
  assert.equal(manager.get('jazz').name, 'Jazz Club Deluxe')
  assert.equal(manager.get('jazz').options.allowRequests, true)
  assert.equal(manager.get('lo-fi-nights').options.allowRequests, false, 'one station cannot change another')

  const stats = manager.stats()
  assert.equal(stats.stations, 2)
  assert.equal(stats.listeners, 0)

  assert.equal(manager.remove('jazz'), true)
  assert.equal(manager.remove('jazz'), false)
  assert.deepEqual(events, ['added:lo-fi-nights', 'added:jazz', 'removed:jazz'])

  manager.stopAll()
  assert.equal(manager.size, 0)
})

test('station events are re-emitted on the manager with the station attached', async () => {
  const dir = tmpdir('events-')
  makeMedia(dir, { count: 1, ms: 1200 })
  const sources = new SourceRegistry({ mediaDir: dir, hiRes: false, liveFallback: false })
  const manager = new StationManager({ sources })
  const station = manager.add({ id: 'ev', playlists: [`local:${dir}`], autoStart: false, automix: { enabled: false } })

  const seen = waitEvent(manager, 'queue')
  await station.load()
  const [emitter, queue] = (await seen) as any[]
  assert.equal(emitter.id, 'ev')
  assert.equal(queue.length, 1)

  manager.stopAll()
})
