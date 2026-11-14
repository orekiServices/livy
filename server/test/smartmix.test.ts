/**
 * Smart Automix, the Rust DSP behind it, and the database underneath.
 *
 * Three things are being protected here:
 *
 *   • **the same answers.** The Rust beat tracker and time stretcher are
 *     ports of the JavaScript ones; if they ever disagree about a tempo,
 *     every mix on every station changes character.
 *   • **the same database.** MetroDB is a drop-in for better-sqlite3, so it
 *     has to behave like one down to `{ changes, lastInsertRowid }` and a
 *     transaction that rolls back when the function throws.
 *   • **a blend you can hear before you use it.** The preview renders the
 *     real seam, not an impression of one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

import { smartCrossfadeMs, EFFECTS, AUTO_EFFECT } from '../src/core/automix.ts'
import { previewTransition } from '../src/core/preview.ts'
import { analyseBeat, stretchAudio, engineInfo, probeMp3 } from '../src/util/metro.ts'
import { estimateBeat, timeStretch } from '../src/core/dsp.ts'
import { quietLogs, tmpdir, beatLoop, makeMedia, boot, api } from './helpers.ts'

quietLogs()

const require = createRequire(import.meta.url)
const monoOf = (audio) => {
  const mono = new Float32Array(audio.length)
  for (let i = 0; i < audio.length; i += 1) mono[i] = (audio.left[i] + audio.right[i]) / 2
  return mono
}

/* ------------------------- the Rust DSP path -------------------------- */

test('the Rust beat tracker agrees with the JavaScript one', async () => {
  for (const bpm of [92, 124, 140]) {
    const audio = beatLoop({ bpm, seconds: 12 })
    const mono = monoOf(audio)

    const js = estimateBeat(mono, 44100)
    const engine = await analyseBeat(mono, 44100)

    assert.ok(js, `javascript found ${bpm} BPM`)
    assert.ok(engine, `the engine found ${bpm} BPM`)
    assert.ok(Math.abs(js.bpm - engine.bpm) < 0.5, `${bpm}: ${js.bpm.toFixed(2)} vs ${engine.bpm.toFixed(2)}`)
    assert.ok(Math.abs(js.confidence - engine.confidence) < 0.05, 'and they are equally sure about it')
    assert.ok(Math.abs(engine.bpm - bpm) < 3, `and both are right (${engine.bpm.toFixed(1)} ≈ ${bpm})`)
  }
})

test('time stretching changes the tempo and not the length contract', async () => {
  const audio = beatLoop({ bpm: 120, seconds: 8 })

  for (const stretch of [1.05, 0.94]) {
    const out = await stretchAudio([audio.left, audio.right], 44100, { stretch })
    const expected = Math.round(audio.length * stretch)

    assert.ok(Math.abs(out.length - expected) <= 2, `${stretch}: ${out.length} ≈ ${expected}`)
    assert.equal(out.channels.length, 2, 'stereo in, stereo out')
    assert.equal(out.channels[0].length, out.length)
    assert.ok(out.map, 'and the time map comes back, because the caller needs to find the beats')

    // The point of WSOLA: the tempo moves, the pitch does not, and the beat
    // is still a beat afterwards.
    const beat = await analyseBeat(monoOf({ left: out.channels[0], right: out.channels[1], length: out.length }), 44100)
    assert.ok(beat, 'the stretched audio still has a detectable beat')
    assert.ok(Math.abs(beat.bpm - 120 / stretch) < 4, `stretched to ${(120 / stretch).toFixed(1)} BPM, measured ${beat.bpm.toFixed(1)}`)
  }

  // A ratio of one is a no-op, not a re-render.
  const same = await stretchAudio([audio.left, audio.right], 44100, { stretch: 1 })
  assert.equal(same.length, audio.length)
})

test('the heavy DSP does not block the event loop', async () => {
  if (!engineInfo().native) return // the JavaScript fallback is synchronous by nature

  const audio = beatLoop({ bpm: 124, seconds: 30 })
  let ticks = 0
  const timer = setInterval(() => {
    ticks += 1
  }, 5)

  await Promise.all([analyseBeat(monoOf(audio), 44100), stretchAudio([audio.left, audio.right], 44100, { stretch: 1.04 })])
  clearInterval(timer)

  // A blocked loop gives zero or one tick; anything above a handful means
  // the work really happened somewhere else.
  assert.ok(ticks > 3, `the pacer kept running during the analysis (${ticks} ticks)`)
})

/* --------------------------- smart lengths ---------------------------- */

test('the blend length follows the pair, within its bounds', () => {
  const base = { crossfadeMs: 6000, minCrossfadeMs: 2000, maxCrossfadeMs: 30_000, smart: true }

  const locked = smartCrossfadeMs({ matched: true, tempoDelta: 0.3, correlation: 0.5, energy: 0.5, bpm: 128 }, base)
  const clash = smartCrossfadeMs({ matched: false, tempoDelta: 28, correlation: -0.3, energy: 0.8, bpm: 90 }, base)

  assert.ok(locked.ms > 6000, `two locked records hold a long blend (${locked.ms}ms)`)
  assert.ok(clash.ms < 6000, `two that fight get it over with (${clash.ms}ms)`)
  assert.ok(locked.ms <= 30_000 && clash.ms >= 2000, 'both inside the bounds')
  assert.match(locked.why, /locked|together/)

  // Rounded to bars, so a blend ends where the music does.
  const barMs = (60_000 / 128) * 4
  assert.ok(Math.abs(locked.ms - locked.bars * barMs) < 1, `${locked.bars} whole bars`)

  // It can never ask for more audio than there is.
  const short = smartCrossfadeMs({ matched: true, tempoDelta: 0.2, correlation: 0.6, bpm: 128, available: 3500 }, base)
  assert.ok(short.ms <= 3500, `${short.ms}ms fits in the 3.5s we hold`)

  // Bounds are respected even when the request is silly.
  assert.equal(smartCrossfadeMs({}, { ...base, crossfadeMs: 500 }).ms >= 2000, true)
  assert.equal(smartCrossfadeMs({ matched: true, tempoDelta: 0 }, { ...base, crossfadeMs: 90_000 }).ms <= 30_000, true)

  // Switched off, what you configure is what you get.
  assert.equal(smartCrossfadeMs({ matched: true, tempoDelta: 0.1, bpm: 128 }, { ...base, smart: false }).ms, 6000)
})

/* ------------------------------ preview ------------------------------- */

test('every transition can be auditioned before it goes on air', async () => {
  for (const effect of ['crossfade', 'roll', 'drop', AUTO_EFFECT]) {
    const preview = await previewTransition({ effect, crossfadeMs: 4000 })
    const probe = probeMp3(preview.mp3)

    assert.ok(probe.frames > 50, `${effect}: a real rendering (${probe.frames} frames)`)
    assert.ok(probe.durationMs > 4000, `${effect}: long enough to hear the seam`)
    assert.ok(EFFECTS.includes(preview.report.effect), `${effect}: it says what it rendered`)
    if (effect !== AUTO_EFFECT) assert.equal(preview.report.effect, effect, 'and it rendered what was asked for')
    assert.ok(preview.material, 'and what it used to do it')
  }

  await assert.rejects(() => previewTransition({ effect: 'not-a-transition' }), /unknown transition/)
})

test('the owner can list and hear transitions over HTTP', async (t) => {
  const dir = tmpdir('preview-')
  const mediaDir = path.join(dir, 'media')
  makeMedia(mediaDir, { count: 2, ms: 1500 })

  const server = await boot({
    _dir: dir,
    owner: { key: 'preview-key' },
    sources: { mediaDir },
    stations: [{ id: 'fm', name: 'Preview FM', playlists: [`local:${mediaDir}`], autoStart: false }]
  })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.port}`

  const listed = await api(base, '/api/v1/owner/automix', { key: 'preview-key' })
  assert.ok(listed.effects.includes('auto'))
  assert.ok(listed.effects.length >= 10, 'ten transitions and auto')
  assert.ok(listed.traits.roll, 'with what each one needs')
  assert.ok(listed.engine, 'and where the DSP runs')

  const res = await fetch(`${base}/api/v1/owner/automix/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-owner-key': 'preview-key' },
    body: JSON.stringify({ effect: 'filter', crossfadeMs: 3000 })
  })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'audio/mpeg')
  assert.equal(res.headers.get('x-livy-effect'), 'filter')
  assert.ok(probeMp3(Buffer.from(await res.arrayBuffer())).frames > 40, 'and it is audio')

  // Owner-only, and honest about nonsense.
  assert.equal((await fetch(`${base}/api/v1/owner/automix/preview`, { method: 'POST' })).status, 401)
  const bad = await api(base, '/api/v1/owner/automix/preview', {
    method: 'POST',
    key: 'preview-key',
    body: { effect: 'nope' }
  })
  assert.equal(bad._status, 400)
})

/* ------------------------------- MetroDB ------------------------------ */

test('MetroDB behaves like better-sqlite3', { skip: metrodb() ? false : 'no metrodb binary' }, () => {
  const Database = metrodb()
  const db = new Database(path.join(tmpdir('metrodb-'), 'test.db'))

  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n REAL, raw BLOB)')

  const insert = db.prepare('INSERT INTO t (name, n) VALUES (?, ?)')
  const first = insert.run('one', 1.5)
  assert.equal(first.changes, 1)
  assert.equal(first.lastInsertRowid, 1)

  // Variadic *and* array parameters, like better-sqlite3.
  insert.run(['two', 2.5])
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM t').get().c, 2)

  const row = db.prepare('SELECT * FROM t WHERE id = ?').get(1)
  assert.equal(row.name, 'one')
  assert.equal(row.n, 1.5)
  assert.equal(row.raw, null)
  assert.equal(db.prepare('SELECT * FROM t WHERE id = ?').get(99), undefined, 'a miss is undefined, not null')

  assert.equal(db.prepare('SELECT * FROM t ORDER BY id').all().length, 2)
  assert.equal([...db.prepare('SELECT * FROM t').iterate()].length, 2)

  // `undefined` is a NULL, not a crash: objects have missing fields.
  insert.run('three', undefined)
  assert.equal(db.prepare('SELECT n FROM t WHERE name = ?').get('three').n, null)

  // Transactions: committed on return, rolled back on throw, nestable.
  const addMany = db.transaction((names) => {
    for (const name of names) insert.run(name, 0)
    return names.length
  })
  assert.equal(addMany(['a', 'b']), 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM t').get().c, 5)

  assert.throws(() =>
    db.transaction(() => {
      insert.run('doomed', 0)
      throw new Error('no')
    })()
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM t').get().c, 5, 'the failed transaction left nothing behind')

  const nested = db.transaction(() => {
    insert.run('outer', 0)
    db.transaction(() => insert.run('inner', 0))()
    return 'done'
  })
  assert.equal(nested(), 'done')
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM t').get().c, 7)

  assert.equal(db.pragma('journal_mode = WAL')[0].journal_mode, 'wal')
  assert.equal(db.pragma('user_version', { simple: true }), 0)
  assert.equal(db.inTransaction, false)
  assert.ok(db.name.endsWith('test.db'))
  assert.equal(db.open, true)

  db.close()
  assert.equal(db.open, false)
  assert.throws(() => db.prepare('SELECT 1').get(), /closed/)
})

function metrodb() {
  try {
    const module = require('../../native/metrodb/index.js')
    return module.available ? module : null
  } catch {
    return null
  }
}
