/**
 * What the studio does to a station: program the queue, say something on
 * air, read the words of what is playing.
 *
 * These are the endpoints the mobile console drives, so they are tested the
 * way it uses them — a drag becomes one PATCH, a preset becomes one POST —
 * and the lyrics tests never touch the network: a fake fetch stands in for
 * LRCLIB so the suite stays hermetic and fast.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { Lyrics, parseLrc, toTtml, cleanTitle, bareTitle, splitArtistTitle, lineAt } from '../src/core/lyrics.ts'
import { ANNOUNCEMENT_PRESETS } from '../src/server/owner.ts'
import { quietLogs, tmpdir, makeMedia, boot, api, waitFor } from './helpers.ts'

quietLogs()

const KEY = 'studio-key'

async function node(t) {
  const dir = tmpdir('studio-')
  const mediaDir = path.join(dir, 'media')
  makeMedia(mediaDir, { count: 4, ms: 1200 })

  const server = await boot({
    _dir: dir,
    owner: { key: KEY, name: 'tester' },
    sources: { mediaDir },
    stations: [{ id: 'fm', name: 'Studio FM', playlists: [`local:${mediaDir}`], autoStart: false, allowRequests: true }]
  })
  t.after(() => server.close())

  const station = server.manager.get('fm')
  await station.load()
  return { ...server, base: `http://127.0.0.1:${server.port}`, station, mediaDir }
}

const titles = (queue) => queue.map((track) => track.title)

/* ------------------------------- queue -------------------------------- */

test('the queue can be reordered by drag, by move, and by play-next', async (t) => {
  const { base, station } = await node(t)

  const before = titles(station.queue)
  assert.ok(before.length >= 4, 'a queue to play with')

  // A drag: the console sends the whole order it is showing.
  const dragged = [...before].reverse()
  const reordered = await api(base, '/api/v1/owner/stations/fm/queue', {
    method: 'PATCH',
    key: KEY,
    body: { order: station.queue.map((track) => track.id).reverse() }
  })
  assert.deepEqual(titles(reordered.queue), dragged, 'the queue is in the order the console showed')

  // One move, the way a keyboard user or an ↑ button does it.
  const moved = await api(base, '/api/v1/owner/stations/fm/queue', { method: 'PATCH', key: KEY, body: { from: 3, to: 0 } })
  assert.equal(moved.moved.title, dragged[3])
  assert.deepEqual(titles(moved.queue), [dragged[3], ...dragged.filter((_, index) => index !== 3)])

  // Play next.
  const next = await api(base, '/api/v1/owner/stations/fm/queue', { method: 'PATCH', key: KEY, body: { next: 2 } })
  assert.equal(next.queue[0].title, next.next.title)

  // Nonsense is refused, not guessed at.
  assert.equal((await api(base, '/api/v1/owner/stations/fm/queue', { method: 'PATCH', key: KEY, body: {} }))._status, 400)
  assert.equal((await api(base, '/api/v1/owner/stations/fm/queue', { method: 'PATCH', key: KEY, body: { from: 99 } }))._status, 404)
  assert.equal((await api(base, '/api/v1/owner/stations/fm/queue', { method: 'PATCH', body: { next: 0 } }))._status, 401)
})

test('a reorder can never lose or duplicate a track', async (t) => {
  const { base, station } = await node(t)
  const length = station.queue.length

  // Half the ids, in a silly order, with one that does not exist.
  const partial = [station.queue[2].id, 'not-a-real-id', station.queue[0].id]
  const result = await api(base, '/api/v1/owner/stations/fm/queue', { method: 'PATCH', key: KEY, body: { order: partial } })

  assert.equal(result.queue.length, length, 'nothing was dropped')
  assert.equal(result.queue[0].title, station.queue[0].title)
  assert.equal(new Set(result.queue.map((track) => track.title)).size, new Set(titles(station.queue)).size)
})

/* ---------------------------- announcements --------------------------- */

test('an announcement takes one request, and the presets are ready-made', async (t) => {
  const { base, station } = await node(t)

  const offered = await api(base, '/api/v1/owner/stations/fm/say', { key: KEY })
  assert.ok(offered.presets.length >= 5)
  assert.ok(offered.languages.length > 10, 'and it can say them in any of them')
  for (const preset of offered.presets) assert.ok(preset.text.length > 5, `${preset.id} has words`)

  // A preset: no typing, and {station} becomes the station's name.
  const announced = await api(base, '/api/v1/owner/stations/fm/say', { method: 'POST', key: KEY, body: { preset: 'back-soon' } })
  assert.match(announced.text, /Studio FM/)
  assert.equal(announced.when, 'now')
  assert.equal(station.announcements.length, 1)
  assert.equal(station.announcements[0].announcement, true)

  // Your own words, in another language, after the current song.
  const custom = await api(base, '/api/v1/owner/stations/fm/say', {
    method: 'POST',
    key: KEY,
    body: { text: 'Chào buổi tối', language: 'vi', when: 'next' }
  })
  assert.equal(custom.language, 'vi')
  assert.equal(custom.when, 'next')
  assert.equal(station.announcements[1].language, 'vi')

  assert.equal((await api(base, '/api/v1/owner/stations/fm/say', { method: 'POST', key: KEY, body: {} }))._status, 400)
  assert.equal(
    (await api(base, '/api/v1/owner/stations/fm/say', { method: 'POST', key: KEY, body: { preset: 'nope' } }))._status,
    400,
    'an unknown preset says so'
  )
  assert.equal((await api(base, '/api/v1/owner/stations/fm/say', { method: 'POST', body: { text: 'hi' } }))._status, 401)
})

test('every shipped preset is a sentence a station could actually say', () => {
  for (const [id, preset] of Object.entries(ANNOUNCEMENT_PRESETS)) {
    assert.ok(preset.title, `${id} has a label for a button`)
    assert.match(preset.text, /[.!?]$/, `${id} is a finished sentence`)
    assert.ok(preset.text.length < 160, `${id} is short enough to listen to`)
  }
})

/* -------------------------------- lyrics ------------------------------ */

test('an LRC becomes lines, and lines become the TTML the player renders', () => {
  const lrc = ['[00:12.34] first line', '[00:15.00] second line', '[00:18.50]', '[00:20.00] third line'].join('\n')
  const lines = parseLrc(lrc)

  assert.equal(lines.length, 4)
  assert.deepEqual(lines[0], { at: 12_340, text: 'first line' })
  assert.equal(lines[2].text, '', 'an empty line is an instrumental gap')
  assert.equal(lineAt(lines, 16_000), 1, 'the second line is the one playing')
  assert.equal(lineAt(lines, 1000), -1, 'nothing before the first line')

  const ttml = toTtml(lines, { durationMs: 30_000 })
  assert.match(ttml, /<tt xmlns="http:\/\/www\.w3\.org\/ns\/ttml"/)
  assert.match(ttml, /<p begin="00:12\.340" end="00:15\.000">/)
  assert.ok(!ttml.includes('<p begin="00:18'), 'the gap is not rendered as a blank lyric')

  // Word spans are what produce the Apple-style sweep; they must tile the
  // line, in order, without overlapping.
  const spans = [...ttml.matchAll(/<span begin="(\d+):([\d.]+)" end="(\d+):([\d.]+)">([^<]*)<\/span>/g)]
  assert.equal(spans[0][5], 'first')
  assert.equal(spans[1][5], 'line')
  const start = (m) => Number(m[1]) * 60 + Number(m[2])
  const end = (m) => Number(m[3]) * 60 + Number(m[4])
  assert.ok(Math.abs(end(spans[0]) - start(spans[1])) < 0.002, 'one word ends where the next begins')
  assert.ok(end(spans[1]) <= 15.001, 'and the last word ends when the line does')

  assert.equal(toTtml([]), null)
  // Escaping, because lyrics contain everything. Each word is its own span,
  // so the escaping has to happen per word.
  const escaped = toTtml(parseLrc('[00:01.00] me & you <3'))
  assert.match(escaped, />&amp;</)
  assert.match(escaped, />&lt;3</)
})

test('a long instrumental gap keeps the line lit without smearing its words', () => {
  // LRC says when a line starts, never when its words end. Tiling the whole
  // slot between two lines proportionally meant a three-word line sung in a
  // second stayed "sung" for the ten seconds the singer rested — on a screen
  // that is nothing but lyrics, that is a highlight crawling one word every
  // three seconds.
  const lines = parseLrc(['[00:02.00] one two three', '[00:12.00] four five six'].join('\n'))
  const ttml = toTtml(lines, { durationMs: 20_000 })
  const clock = (m) => Number(m.split(':')[0]) * 60 + Number(m.split(':')[1])

  const paragraphs = [...ttml.matchAll(/<p begin="([\d:.]+)" end="([\d:.]+)">/g)].map((m) => [m[1], m[2]])
  assert.deepEqual(paragraphs[0], ['00:02.000', '00:12.000'], 'the line still holds the whole slot, so it stays on screen')

  const spans = [...ttml.matchAll(/<span begin="([\d:.]+)" end="([\d:.]+)">/g)].map((m) => [m[1], m[2]])
  assert.ok(
    clock(spans[2][1]) - clock('00:02.000') < 2000,
    `the last word ends close to the line's start, not at the next line (got ${spans[2][1]})`
  )

  // With no gap to worry about, the words still fill the line — the cap is a
  // ceiling, not a shrink.
  const tight = toTtml(parseLrc(['[00:12.34] first line', '[00:15.00] second line'].join('\n')), { durationMs: 30_000 })
  const tightSpans = [...tight.matchAll(/<span begin="([\d:.]+)" end="([\d:.]+)">([^<]*)<\/span>/g)]
  assert.equal(tightSpans[0][3], 'first')
  assert.equal(tightSpans[1][2], '00:13.140', 'a 2.66 s line is shared between its two words')
})

test('radio metadata is cleaned up before it is looked up', () => {
  assert.equal(cleanTitle('Get Lucky (Official Video)'), 'Get Lucky')
  assert.equal(cleanTitle('Song - Official Audio'), 'Song')
  assert.equal(bareTitle("Tears From The Moon (w/ Sinead O'Connor)"), 'Tears From The Moon')
  assert.equal(bareTitle('Song (feat. Someone) [Radio Edit]'), 'Song')
  assert.deepEqual(splitArtistTitle({ title: 'Daft Punk - Get Lucky' }), { artist: 'Daft Punk', title: 'Get Lucky' })
  assert.deepEqual(splitArtistTitle({ artist: 'Daft Punk', title: 'Daft Punk - Get Lucky' }), {
    artist: 'Daft Punk',
    title: 'Get Lucky'
  })
})

test('lyrics are fetched once, cached, and never break a station', async () => {
  const calls = []
  const fakeLrclib = async (url) => {
    calls.push(String(url))
    if (String(url).includes('/get?')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 1,
          trackName: 'Get Lucky',
          artistName: 'Daft Punk',
          albumName: 'RAM',
          duration: 248,
          instrumental: false,
          plainLyrics: 'like the legend',
          syncedLyrics: '[00:30.64] Like the legend\n[00:35.11] Our ends'
        })
      }
    }
    return { ok: true, status: 200, json: async () => [] }
  }

  const original = globalThis.fetch
  globalThis.fetch = fakeLrclib as any
  try {
    const lyrics = new Lyrics({})
    const found = await lyrics.find({ artist: 'Daft Punk', title: 'Get Lucky', duration: 248_000 })
    assert.equal(found.found, true)
    assert.equal(found.synced, true)
    assert.equal(found.lines.length, 2)
    assert.ok(found.ttml.includes('<span'))

    const again = await lyrics.find({ artist: 'Daft Punk', title: 'Get Lucky', duration: 248_000 })
    assert.equal(again.cached, true)
    assert.equal(calls.length, 1, 'the second play costs nothing')

    // Things with no lyrics are not looked up at all.
    const ident = await lyrics.find({ title: 'Station ident', announcement: true })
    const relay = await lyrics.find({ title: 'City FM', live: true })
    assert.equal(ident.found, false)
    assert.equal(relay.found, false)
    assert.equal(calls.length, 1, 'an ident is not a song')

    // And a provider having a bad day is not an outage.
    globalThis.fetch = (async () => {
      throw new Error('lrclib is down')
    }) as any
    const broken = new Lyrics({})
    const missing = await broken.find({ artist: 'Someone', title: 'Something' })
    assert.equal(missing.found, false)
    assert.deepEqual(missing.lines, [])
  } finally {
    globalThis.fetch = original
  }
})

test('the lyrics endpoint answers with the words and the position to sync them to', async (t) => {
  const { base, station } = await node(t)

  const idle = await api(base, '/api/v1/lyrics?station=fm')
  assert.equal(idle.found, false, 'nothing on air yet')

  await station.start()
  await waitFor(() => station.nowPlaying()?.track?.title, { label: 'something on air' })

  const playing = await api(base, '/api/v1/lyrics?station=fm')
  assert.equal(playing._status, 200)
  assert.equal(playing.station, 'fm')
  assert.ok(playing.positionMs >= 0, 'and where the station is in it')
  assert.ok(playing.serverTime > 0, 'with a clock to interpolate from')

  assert.equal((await api(base, '/api/v1/lyrics?station=nope'))._status, 404)
})
