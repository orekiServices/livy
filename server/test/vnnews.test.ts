/**
 * VNNews — bản tin tiếng Việt, 17:00–19:00.
 *
 * The clock is the part worth testing hard: a news slot that fires twice, or
 * an hour late, or in the wrong time zone is worse than no news slot. So the
 * window logic is tested against fixed instants in several zones, and the
 * bulletin itself against a feed this test serves on localhost — no
 * VnExpress, no Google, no clock-watching.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { buildSilence } from '../src/util/mp3.ts'

import vnnews, {
  parseFeed,
  decodeEntities,
  firstSentence,
  sourceName,
  localMinutes,
  windowState,
  spokenTime,
  buildScript
} from '../plugins/vnnews/index.ts'
import { VoicePool } from '../plugins/vnnews/voice.ts'
import { LIMITS } from '../plugins/vnnews/voice-worker.ts'
import { chunkText, google } from '../src/tts/providers.ts'
import { TtsEngine } from '../src/tts/index.ts'
import { quietLogs, tmpdir, makeMedia, boot, api } from './helpers.ts'

quietLogs()

const KEY = 'vnnews-key'
const HANOI = 'Asia/Ho_Chi_Minh'

/** An RSS feed, as a Vietnamese newspaper publishes one. */
const feedXml = (items, title = 'Tin mới nhất') =>
  `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>${title}</title>
${items
  .map(
    (item) => `<item>
  <title>${item.title}</title>
  <description><![CDATA[<a href="x"><img src="y"></a></br>${item.summary}]]></description>
  <link>${item.link}</link>
  <pubDate>${item.pubDate ?? 'Mon, 28 Sep 2026 15:32:11 +0700'}</pubDate>
</item>`
  )
  .join('\n')}
</channel></rss>`

/* ------------------------------ parsing ------------------------------- */

test('a Vietnamese feed is read, entities and all', () => {
  const xml = feedXml([
    { title: 'Giá vàng tăng mạnh', summary: 'Giá vàng miếng tăng 2 triệu đồng. Thị trường sôi động.', link: 'https://x/1' },
    { title: 'TP.HCM đ&agrave;o tạo l&aacute;i xe', summary: 'Kh&ocirc;ng kh&iacute; lạnh tràn về.', link: 'https://x/2' }
  ])

  const items = parseFeed(xml, 'VnExpress')
  assert.equal(items.length, 2)
  assert.equal(items[0].title, 'Giá vàng tăng mạnh')
  assert.equal(items[0].source, 'VnExpress')
  assert.equal(items[0].link, 'https://x/1')
  assert.ok(items[0].publishedAt > 0, 'the date is parsed')

  // Half-escaped accents are normal in Vietnamese feeds, and reading
  // "đ ampersand agrave" out loud is not acceptable.
  assert.equal(items[1].title, 'TP.HCM đào tạo lái xe')
  assert.match(items[1].summary, /Không khí lạnh/)

  assert.equal(decodeEntities('&#273;&#7907;t 2'), 'đợt 2')
  assert.equal(decodeEntities('a &amp; b'), 'a & b')

  // The description is HTML with an image; only the sentence should survive.
  assert.equal(firstSentence('<img src="a">Giá vàng miếng tăng 2 triệu đồng. Thị trường sôi động.'), 'Giá vàng miếng tăng 2 triệu đồng.')
  assert.ok(firstSentence('x'.repeat(400)).length <= 181, 'a long paragraph is trimmed')

  assert.equal(sourceName('https://vnexpress.net/rss/tin-moi-nhat.rss'), 'VnExpress')
  assert.equal(sourceName('https://tuoitre.vn/rss/tin-moi-nhat.rss'), 'Tuổi Trẻ')
  assert.equal(sourceName('https://unknown.example/rss'), 'unknown.example')
})

/* ------------------------------- clock -------------------------------- */

test('the 17:00–19:00 window is Hanoi time, wherever the server is', () => {
  const settings = { start: '17:00', end: '19:00', timezone: HANOI, everyMinutes: 30 }

  // 10:05 UTC is 17:05 in Hanoi: on air.
  const inside = windowState(Date.parse('2026-09-28T10:05:00Z'), settings)
  assert.equal(inside.open, true)
  assert.equal(inside.localTime, '17:05')
  assert.equal(inside.nextInMinutes, 25, 'the next bulletin is at 17:30')

  // 14:05 UTC is 21:05 in Hanoi: closed, and it says when it opens again.
  const outside = windowState(Date.parse('2026-09-28T14:05:00Z'), settings)
  assert.equal(outside.open, false)
  assert.equal(outside.slot, null)
  // 21:05 → 17:00 tomorrow is 19 h 55 m away.
  assert.equal(outside.nextInMinutes, 19 * 60 + 55, 'counts down to tomorrow 17:00')

  // The boundaries themselves: 17:00 is in, 19:00 is out.
  assert.equal(windowState(Date.parse('2026-09-28T10:00:00Z'), settings).open, true)
  assert.equal(windowState(Date.parse('2026-09-28T12:00:00Z'), settings).open, false)

  // Same instant, different zone: the window follows the zone, not the box.
  assert.equal(windowState(Date.parse('2026-09-28T10:05:00Z'), { ...settings, timezone: 'UTC' }).open, false)
  assert.equal(localMinutes(Date.parse('2026-09-28T10:05:00Z'), HANOI), 17 * 60 + 5)

  // A late edition that wraps past midnight still works.
  const late = { start: '22:00', end: '02:00', timezone: HANOI, everyMinutes: 60 }
  assert.equal(windowState(Date.parse('2026-09-28T16:30:00Z'), late).open, true, '23:30 Hanoi')
  assert.equal(windowState(Date.parse('2026-09-28T18:30:00Z'), late).open, true, '01:30 Hanoi')
  assert.equal(windowState(Date.parse('2026-09-28T03:30:00Z'), late).open, false, '10:30 Hanoi')
})

test('a bulletin belongs to one slot, so it airs once', () => {
  const settings = { start: '17:00', end: '19:00', timezone: HANOI, everyMinutes: 30 }
  const slotAt = (iso) => windowState(Date.parse(iso), settings).slot

  // Every minute of 17:00–17:29 is the same bulletin…
  assert.equal(slotAt('2026-09-28T10:00:00Z'), slotAt('2026-09-28T10:29:00Z'))
  // …17:30 is the next one…
  assert.notEqual(slotAt('2026-09-28T10:29:00Z'), slotAt('2026-09-28T10:30:00Z'))
  // …and tomorrow's 17:00 is not today's.
  assert.notEqual(slotAt('2026-09-28T10:00:00Z'), slotAt('2026-09-29T10:00:00Z'))
})

/* ------------------------------ the script ---------------------------- */

test('the script is Vietnamese a newsreader could actually read', () => {
  assert.equal(spokenTime(17 * 60), 'năm giờ chiều')
  assert.equal(spokenTime(17 * 60 + 30), 'năm giờ rưỡi chiều')
  assert.equal(spokenTime(19 * 60), 'bảy giờ tối')
  assert.equal(spokenTime(8 * 60), 'tám giờ sáng')

  const items = [
    { title: 'Giá vàng tăng mạnh', summary: 'Vàng miếng tăng 2 triệu đồng.', source: 'VnExpress' },
    { title: 'Mưa lớn ở miền Bắc', summary: 'Không khí lạnh tràn về.', source: 'Tuổi Trẻ' }
  ]
  const script = buildScript(items, { stationName: 'Đài Test', at: 17 * 60 + 30 })

  assert.match(script, /^Xin chào quý vị và các bạn/)
  assert.match(script, /Đài Test/)
  assert.match(script, /bản tin lúc năm giờ rưỡi chiều/)
  assert.match(script, /Tin thứ 1\. Giá vàng tăng mạnh/)
  assert.match(script, /Theo VnExpress\./)
  assert.match(script, /Tin thứ 2\. Mưa lớn ở miền Bắc/)
  assert.match(script, /Cảm ơn quý vị đã lắng nghe/)

  // Summaries can be switched off for a headlines-only bulletin.
  const short = buildScript(items, { stationName: 'Đài Test', summaries: false })
  assert.ok(!short.includes('Vàng miếng tăng'))
  assert.ok(short.length < script.length)

  assert.equal(buildScript([], {}), null, 'no news is no bulletin')
})

/* ---------------------------- on a real node -------------------------- */

async function node(t, { feeds, settings = {} }) {
  const dir = tmpdir('vnnews-')
  const mediaDir = path.join(dir, 'media')
  makeMedia(mediaDir, { count: 2, ms: 1200 })

  const server = await boot({
    _dir: dir,
    owner: { key: KEY, name: 'tester' },
    sources: { mediaDir },
    stations: [{ id: 'vn', name: 'Đài Thử Nghiệm', playlists: [`local:${mediaDir}`], autoStart: false, language: 'vi' }],
    plugins: { enabled: true, dir: path.resolve('plugins'), disabled: ['console', 'now-playing', 'hourly-ident', 'live-relay'] }
  })
  t.after(() => server.close())

  const base = `http://127.0.0.1:${server.port}`
  // Settings go through the owner API, the same way the console sets them.
  await api(base, '/api/v1/owner/plugins/vnnews', {
    method: 'PATCH',
    key: KEY,
    body: { settings: { feeds, everyMinutes: 30, headlines: 3, ...settings } }
  })
  await server.plugins.enable('vnnews')

  return { ...server, base, station: server.manager.get('vn') }
}

test('the plugin reads real headlines from real feeds, mixing the outlets', async (t) => {
  // Two "newspapers", so the running order can be checked for balance.
  const one = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(
      feedXml([
        { title: 'Tin A1 của báo một', summary: 'Nội dung A1.', link: 'https://a/1' },
        { title: 'Tin A2 của báo một', summary: 'Nội dung A2.', link: 'https://a/2' },
        { title: 'Tin A3 của báo một', summary: 'Nội dung A3.', link: 'https://a/3' }
      ])
    )
  })
  const two = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(
      feedXml([
        { title: 'Tin B1 của báo hai', summary: 'Nội dung B1.', link: 'https://b/1' },
        { title: 'Tin B2 của báo hai', summary: 'Nội dung B2.', link: 'https://b/2' }
      ])
    )
  })
  await new Promise<void>((resolve) => one.listen(0, '127.0.0.1', () => resolve()))
  await new Promise<void>((resolve) => two.listen(0, '127.0.0.1', () => resolve()))
  t.after(() => {
    one.close()
    two.close()
  })

  const feeds = [`http://127.0.0.1:${(one.address() as any).port}/a.rss`, `http://127.0.0.1:${(two.address() as any).port}/b.rss`]
  const { base, station } = await node(t, { feeds })

  const headlines = await api(base, '/api/v1/x/vnnews/headlines?station=vn')
  assert.equal(headlines.count, 3)
  // Round-robin: not three stories from the same newspaper.
  const sources = new Set(headlines.items.map((item) => item.source))
  assert.equal(sources.size, 2, 'both outlets are represented')

  const script = await api(base, '/api/v1/x/vnnews/script?station=vn')
  assert.match(script.script, /Đài Thử Nghiệm/)
  assert.equal(script.stories, 3)

  // Reading it puts a Vietnamese announcement on air, ahead of the music.
  const read = await api(base, '/api/v1/x/vnnews/read/vn', { method: 'POST', key: KEY })
  assert.equal(read.aired, true)
  assert.equal(read.stories, 3)
  assert.equal(station.announcements.length, 1)

  const bulletin = station.announcements[0]
  assert.match(bulletin.title, /^Bản tin \d{2}:\d{2}$/)
  assert.equal(bulletin.language, 'vi', 'read in Vietnamese, whatever the node default is')
  assert.equal(bulletin.announcement, true)
  assert.match(bulletin.text, /Xin chào quý vị/)

  // And it does not read the same stories again next time.
  await api(base, '/api/v1/x/vnnews/read/vn', { method: 'POST', key: KEY })
  const second = station.announcements[1]
  assert.ok(second, 'a second bulletin')
  assert.notEqual(second.text, bulletin.text, 'new news, not a repeat')
})

test('a dead feed does not silence the bulletin, and reading is owner-only', async (t) => {
  const alive = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(feedXml([{ title: 'Tin vẫn chạy', summary: 'Báo còn sống.', link: 'https://ok/1' }]))
  })
  await new Promise<void>((resolve) => alive.listen(0, '127.0.0.1', () => resolve()))
  t.after(() => alive.close())

  const { base } = await node(t, {
    // One good feed, one refusing connections, one 500.
    feeds: [`http://127.0.0.1:${(alive.address() as any).port}/ok.rss`, 'http://127.0.0.1:9/dead.rss', 'https://example.invalid/nope.rss']
  })

  const headlines = await api(base, '/api/v1/x/vnnews/headlines?station=vn')
  assert.equal(headlines.count, 1, 'the surviving feed still makes a bulletin')
  assert.equal(headlines.items[0].title, 'Tin vẫn chạy')

  // Anyone can see the status and the headlines…
  const status = await api(base, '/api/v1/x/vnnews/')
  assert.equal(status.plugin, 'vnnews')
  assert.equal(status.stations[0].id, 'vn')
  assert.ok(['17:00–19:00'].includes(status.stations[0].window))

  // …but only the owner can put one on air.
  assert.equal((await api(base, '/api/v1/x/vnnews/read/vn', { method: 'POST' }))._status, 403)
  assert.equal((await api(base, '/api/v1/x/vnnews/read/nope', { method: 'POST', key: KEY }))._status, 400)
})

test('outside the window nothing goes on air by itself', async (t) => {
  const feed = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(feedXml([{ title: 'Tin ngoài giờ', summary: 'Không nên phát.', link: 'https://x/1' }]))
  })
  await new Promise<void>((resolve) => feed.listen(0, '127.0.0.1', () => resolve()))
  t.after(() => feed.close())

  // A window that cannot be open: one minute long, in the middle of the night.
  const { base, station } = await node(t, {
    feeds: [`http://127.0.0.1:${(feed.address() as any).port}/x.rss`],
    settings: { start: '03:00', end: '03:01' }
  })

  const status = await api(base, '/api/v1/x/vnnews/')
  if (status.stations[0].open) return // the one minute a day this cannot be tested

  assert.equal(station.announcements.length, 0, 'the timer stayed quiet')

  // The owner can still force one — that is what the button is for.
  const forced = await api(base, '/api/v1/x/vnnews/read/vn', { method: 'POST', key: KEY })
  assert.equal(forced.aired, true)
  assert.equal(station.announcements.length, 1)
})

test('the plugin is a plugin: it is off until asked, and it cleans up', async (t) => {
  assert.equal(typeof vnnews, 'function', 'the module exports a setup()')

  const dir = tmpdir('vnnews-off-')
  const mediaDir = path.join(dir, 'media')
  makeMedia(mediaDir, { count: 1, ms: 800 })
  const server = await boot({
    _dir: dir,
    owner: { key: KEY },
    sources: { mediaDir },
    stations: [{ id: 'vn', name: 'Đài', playlists: [`local:${mediaDir}`], autoStart: false }],
    plugins: { enabled: true, dir: path.resolve('plugins') }
  })
  t.after(() => server.close())

  const listed = server.plugins.list().find((plugin) => plugin.id === 'vnnews')
  assert.ok(listed, 'it is discovered')
  assert.equal(listed.status, 'disabled', 'a plugin that interrupts the music is opt-in')

  await server.plugins.enable('vnnews')
  assert.equal(server.plugins.list().find((plugin) => plugin.id === 'vnnews').status, 'ready')
  assert.equal((await api(`http://127.0.0.1:${server.port}`, '/api/v1/x/vnnews/')).plugin, 'vnnews')

  await server.plugins.disable('vnnews')
  assert.equal((await api(`http://127.0.0.1:${server.port}`, '/api/v1/x/vnnews/'))._status, 404, 'its routes go with it')
})

/* --------------------------- the voice worker ------------------------- */

/** A stand-in for translate_tts that returns real, tiny MP3s. */
function voiceServer({ delayMs = 0, fail = false }: any = {}) {
  const clip = Buffer.concat(buildSilence(300).frames)
  let requests = 0
  const server = http.createServer((req, res) => {
    requests += 1
    const answer = () => {
      if (fail) {
        res.writeHead(500)
        return res.end('no')
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg' })
      res.end(clip)
    }
    if (delayMs) setTimeout(answer, delayMs)
    else answer()
  })
  return {
    server,
    get requests() {
      return requests
    },
    async listen() {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      return `http://127.0.0.1:${(server.address() as any).port}/tts`
    }
  }
}

const engineFor = () => new TtsEngine({ cacheDir: tmpdir('voice-'), provider: 'google', language: 'vi' })

test('a long bulletin is cut into chunks the provider will accept', () => {
  const text = 'Xin chào quý vị. ' + 'Một câu rất dài để kiểm tra việc cắt đoạn. '.repeat(20)
  const pieces = chunkText(text, google.chunkLimit)

  assert.ok(pieces.length > 1, 'it is split')
  for (const piece of pieces) assert.ok(piece.length <= google.chunkLimit, `${piece.length} ≤ ${google.chunkLimit}`)
  // Nothing is lost in the cutting.
  assert.equal(pieces.join(' ').replace(/\s+/g, ' ').trim(), text.replace(/\s+/g, ' ').trim())

  // The worker refuses anything past its hard limit before making a request.
  assert.ok(LIMITS.maxCharacters > 1000)

  // The *engine* owns the cache name, and everything that changes the sound
  // changes the name — the worker just writes where it is told.
  const engine = engineFor()
  const name = (options) => engine.cachePathFor('xin chào', options)
  assert.equal(name({ language: 'vi', speed: 1 }), name({ language: 'vi', speed: 1 }))
  assert.notEqual(name({ language: 'vi', speed: 1 }), name({ language: 'vi', speed: 0.8 }), 'pace')
  assert.notEqual(name({ language: 'vi', speed: 1 }), name({ language: 'en', speed: 1 }), 'language')
  assert.notEqual(name({ language: 'vi', speed: 1 }), name({ language: 'vi', speed: 1, provider: 'flowery' }), 'service')
})

test('the worker renders off the event loop, into the cache the engine reads', async (t) => {
  const fake = voiceServer()
  const endpoint = await fake.listen()
  t.after(() => fake.server.close())

  const tts = engineFor()
  const pool = new VoicePool({ tts, endpoint })
  t.after(() => pool.close())

  const script = 'Xin chào quý vị và các bạn. ' + 'Đây là bản tin thử nghiệm. '.repeat(10)
  const first = await pool.speak(script, { language: 'vi', speed: 1 })

  assert.equal(first.via, 'worker')
  assert.equal(first.cached, false)
  assert.ok(fs.statSync(first.file).size > 1024, 'a real clip was written')
  assert.ok(fake.requests > 1, 'the script was chunked')

  // Asking again costs nothing…
  const again = await pool.speak(script, { language: 'vi', speed: 1 })
  assert.equal(again.cached, true)
  assert.equal(again.file, first.file)

  // …and the engine finds precisely that file, which is the whole point:
  // the station's say() is instant because the work already happened.
  const viaEngine = await tts.speak(script, { language: 'vi', speed: 1 })
  assert.equal(viaEngine.file, first.file)
  assert.equal(viaEngine.provider, 'cache')
  assert.equal(pool.stats.rendered, 1)
})

test('nothing the worker can do stops the news going out', async (t) => {
  const tts = engineFor()

  // 1. A provider that never answers: the task is abandoned, the worker is
  //    replaced, and the phrase is rendered inline instead.
  const hang = voiceServer({ delayMs: 60_000 })
  const hangEndpoint = await hang.listen()
  t.after(() => hang.server.close())

  const slow = new VoicePool({ tts, endpoint: hangEndpoint, timeoutMs: 800 })
  t.after(() => slow.close())

  const rescued = await slow.speak('Một câu ngắn.', { language: 'vi' })
  assert.equal(rescued.via, 'inline', 'the listener still gets audio')
  assert.equal(slow.stats.timeouts, 1)
  assert.equal(slow.stats.fallbacks, 1)
  assert.equal(slow.stats.restarts, 1, 'one incident is counted once')

  // 2. A provider that errors: reported as a failure, then inline.
  const broken = voiceServer({ fail: true })
  const brokenEndpoint = await broken.listen()
  t.after(() => broken.server.close())

  const failing = new VoicePool({ tts, endpoint: brokenEndpoint })
  t.after(() => failing.close())
  const fallback = await failing.speak('Một câu khác.', { language: 'vi' })
  assert.equal(fallback.via, 'inline')
  assert.equal(failing.stats.failures, 1)

  // 3. No TTS engine at all: no worker, no crash.
  const none = new VoicePool({ tts: { provider: 'off', speak: async () => ({ file: '/dev/null', cached: true }) } })
  const quiet = await none.speak('Không có giọng nói.', { language: 'vi' })
  assert.equal(quiet.via, 'inline')
  assert.equal(none.available, false)
  await none.close()

  // 4. Text beyond the hard limit never reaches the network.
  const guard = voiceServer()
  const guardEndpoint = await guard.listen()
  t.after(() => guard.server.close())
  const bounded = new VoicePool({ tts, endpoint: guardEndpoint })
  t.after(() => bounded.close())
  const huge = await bounded.speak('a'.repeat(LIMITS.maxCharacters + 1), { language: 'vi' })
  assert.equal(huge.via, 'inline', 'refused by the worker, handled by the fallback')
  assert.equal(guard.requests, 0, 'and not one request was made')
})

test('closing the plugin stops the thread', async (t) => {
  const fake = voiceServer()
  const endpoint = await fake.listen()
  t.after(() => fake.server.close())

  const tts = engineFor()
  const pool = new VoicePool({ tts, endpoint })
  await pool.speak('Xin chào.', { language: 'vi' })
  assert.equal(pool.available, true)

  await pool.close()
  assert.equal(pool.available, false)
  await pool.close() // twice is safe
})
