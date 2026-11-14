/**
 * Lyrics: the LRC reader, the matching rules, and the lookup's own resilience.
 *
 * The interesting cases are the ones a radio station actually hits — a file
 * with an `[offset:]` tag, a duration that is three seconds out, a search that
 * comes back with somebody else's song, and a miss that must not be cached for
 * a week. None of them need the network: `fetch` is stubbed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import Lyrics, { bareTitle, cleanTitle, lrcOffset, parseLrc, splitArtistTitle, titlesMatch, lineAt, toTtml } from '../src/core/lyrics.js'

const lrc = ['[ar:Someone]', '[ti:Song]', '[00:10.00]first line', '[00:14.50]second line', '[00:20.00]third line'].join('\n')

test('LRC: timestamps, ID tags and the offset tag', () => {
  const lines = parseLrc(lrc)
  assert.deepEqual(
    lines.map((line) => line.at),
    [10_000, 14_500, 20_000]
  )
  assert.equal(lines[0].text, 'first line', 'the [ar:] tag is not a lyric')
  assert.equal(lrcOffset(lrc), 0)

  // A hand-tuned file asks for a shift in milliseconds; positive means early.
  const shifted = parseLrc(`[offset:+1500]\n${lrc}`)
  assert.deepEqual(
    shifted.map((line) => line.at),
    [8500, 13_000, 18_500]
  )
  assert.equal(lrcOffset('[offset:-250]'), -250)
  assert.equal(lrcOffset('[offset:abc]'), 0)
  // A negative result is clamped: a lyric cannot start before the song does.
  assert.equal(parseLrc('[offset:60000]\n[00:01.00]early')[0].at, 0)

  // Two stamps on one line are two lines with the same words.
  const repeated = parseLrc('[00:05.00][00:15.00]chorus')
  assert.equal(repeated.length, 2)
  assert.deepEqual(repeated.map((line) => line.at), [5000, 15_000])
})

test('LRC: titles are cleaned without merging different songs', () => {
  assert.equal(cleanTitle('Song (Official Video)'), 'Song')
  assert.equal(cleanTitle('Song [HD]'), 'Song')
  assert.equal(cleanTitle('Song - Official Audio'), 'Song')
  assert.equal(bareTitle('Song (w/ Sinéad O\'Connor)'), 'Song')
  assert.equal(bareTitle('Song feat. Someone'), 'Song')

  // "Clean" and "Free Fallin'" are titles, not decoration.
  assert.equal(cleanTitle('Clean'), 'Clean')
  assert.equal(cleanTitle("Free Fallin'"), "Free Fallin'")

  assert.deepEqual(splitArtistTitle({ artist: '', title: 'Artist - Song' }), { artist: 'Artist', title: 'Song' })
  assert.deepEqual(splitArtistTitle({ artist: 'Artist', title: 'Artist - Song' }), { artist: 'Artist', title: 'Song' })
})

test('LRC: one song, one title — a different song is refused', () => {
  assert.equal(titlesMatch('Song (Remastered)', 'Song'), true)
  assert.equal(titlesMatch('Song (Live at Wembley)', 'Song'), true)
  assert.equal(titlesMatch('Song', 'Another Song'), false)
  assert.equal(titlesMatch('', 'Song'), false)
})

test('LRC: the current line, and TTML the component can sweep', () => {
  const lines = parseLrc(lrc)
  assert.equal(lineAt(lines, 0), -1)
  assert.equal(lineAt(lines, 10_000), 0)
  assert.equal(lineAt(lines, 14_499), 0)
  assert.equal(lineAt(lines, 14_500), 1)
  assert.equal(lineAt(lines, 999_999), 2)

  const ttml = toTtml(lines, { durationMs: 30_000 })
  assert.match(ttml, /^<\?xml/)
  assert.match(ttml, /<p begin="00:10\.000" end="00:14\.500">/)
  // Words are spread inside the line, not across the whole gap.
  assert.match(ttml, /<span begin="00:10\.000"/)
  assert.equal(toTtml([], {}), null)
})

/* ------------------------------ the lookup ------------------------------ */

/** Answer `/api/get` and `/api/search` from a table, and count the calls. */
function stubFetch(routes) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const text = String(url)
    calls.push(text)
    for (const [pattern, answer] of Object.entries(routes)) {
      if (!text.includes(pattern)) continue
      const value = typeof answer === 'function' ? answer(text, calls) : answer
      return {
        ok: value != null,
        status: value == null ? 404 : 200,
        async json() {
          return value
        }
      }
    }
    return { ok: false, status: 404, async json() {} }
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    }
  }
}

test('lookup: a duration three seconds out no longer hides the words', async () => {
  const hit = {
    id: 7,
    trackName: 'Song',
    artistName: 'Someone',
    albumName: 'Album',
    duration: 197,
    instrumental: false,
    plainLyrics: 'first line\nsecond line',
    syncedLyrics: lrc
  }
  // `/get` with a duration answers 404 unless the numbers agree — which is the
  // whole point: the third attempt drops the duration.
  const stub = stubFetch({
    'track_name=Song&duration=200': null,
    'artist_name=Someone&track_name=Song': hit
  })
  try {
    const lyrics = new Lyrics({ timeoutMs: 1000 })
    const found = await lyrics.find({ artist: 'Someone', title: 'Song', duration: 200_000 })
    assert.equal(found.found, true)
    assert.equal(found.synced, true)
    assert.equal(found.lines.length, 3)
    assert.equal(found.lrclibId, 7)
    assert.ok(found.ttml, 'TTML comes with it')
    const asked = stub.calls.filter((url) => url.includes('/get'))
    assert.equal(asked.length, 2, 'duration first, then without')
    assert.ok(asked[1].includes('artist_name=Someone'), 'the second attempt keeps the title')
  } finally {
    stub.restore()
  }
})

test('lookup: somebody else’s song is never returned as this one', async () => {
  const other = { id: 9, trackName: 'Different Song', artistName: 'Someone', duration: 240, plainLyrics: 'words', syncedLyrics: null }
  const stub = stubFetch({
    '/get': null,
    '/search': [other]
  })
  try {
    const lyrics = new Lyrics({ timeoutMs: 1000 })
    // No duration to compare, and the title does not match: refuse.
    const found = await lyrics.find({ artist: 'Someone', title: 'Song' })
    assert.equal(found.found, false)
    assert.deepEqual(found.lines, [])

    // With a duration that fits, the same row is the right recording.
    const byLength = await lyrics.find({ artist: 'Someone', title: 'Song', duration: 240_000 })
    assert.equal(byLength.found, true)
    assert.equal(byLength.lines.length, 0, 'plain lyrics carry no timings')
    assert.equal(byLength.plain, 'words')
  } finally {
    stub.restore()
  }
})

test('lookup: a miss is cheap to repeat, and it does not last a week', async () => {
  const stub = stubFetch({ '/get': null, '/search': [] })
  try {
    const cached = new Lyrics({ timeoutMs: 1000 })
    await cached.find({ artist: 'Nobody', title: 'Nothing' })
    const first = stub.calls.length
    await cached.find({ artist: 'Nobody', title: 'Nothing' })
    assert.equal(stub.calls.length, first, 'the miss is cached for the day')

    // …but not for ever: lyrics are added to the database constantly, so the
    // negative entry expires on its own clock.
    const eager = new Lyrics({ timeoutMs: 1000, missTtlMs: 0 })
    await eager.find({ artist: 'Nobody', title: 'Nothing Else' })
    const second = stub.calls.length
    await eager.find({ artist: 'Nobody', title: 'Nothing Else' })
    assert.ok(stub.calls.length > second, 'an expired miss is looked up again')
  } finally {
    stub.restore()
  }
})

test('lookup: announcements and live relays have no lyrics worth fetching', async () => {
  const stub = stubFetch({})
  try {
    const lyrics = new Lyrics({ timeoutMs: 1000 })
    assert.equal((await lyrics.find({ title: 'Station ident', announcement: true })).found, false)
    assert.equal((await lyrics.find({ title: 'Live set', live: true })).found, false)
    assert.equal(stub.calls.length, 0, 'and nothing is asked of the network')
  } finally {
    stub.restore()
  }
})
