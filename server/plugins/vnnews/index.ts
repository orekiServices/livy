/**
 * VNNews — bản tin tiếng Việt, on air between 17:00 and 19:00 Hanoi time.
 *
 * Vietnamese radio has a rush-hour news slot, and this is it: every half
 * hour inside the window the station interrupts itself, reads the headlines
 * from VnExpress, Tuổi Trẻ, Thanh Niên, Dân Trí and VOV, and hands the music
 * back. Outside the window it does nothing at all.
 *
 * Three things make it work on a small node:
 *
 *   • **It is only ever text.** The feeds are RSS; the voice is the node's
 *     own TTS. Nothing is downloaded, decoded or transcoded — a bulletin is
 *     a few kilobytes of Vietnamese and one MP3 the node renders itself.
 *   • **Fast Vietnamese, off the event loop.** The bulletin is voiced in a
 *     **worker thread** (see voice.js / voice-worker.js) before it is put on
 *     air, so the pacer never waits on a dozen HTTP requests. If the worker
 *     is slow, broken or unavailable the phrase is rendered inline instead —
 *     the listener always gets the news.
 *   • **It never repeats a story.** Headlines are deduplicated by link and
 *     by title across bulletins, so the 17:30 edition is new news.
 *   • **It sounds like radio.** A music bed runs under the voice, ducked out
 *     of the way by the same sidechain compressor the DJ uses, and fades in
 *     and out around the bulletin (see bed.js).
 *
 * It runs on a clock (17:00–19:00, every half hour) and/or **every N songs**,
 * whichever the owner sets.
 *
 * Settings (all editable per station):
 *
 *   start, end        "17:00" / "19:00" — the window, in `timezone`
 *   timezone          IANA zone, default Asia/Ho_Chi_Minh
 *   everyMinutes      how often inside the window (default 30)
 *   headlines         how many stories per bulletin (default 6)
 *   summaries         read the one-line summary after each headline
 *   language / speed  the voice (default vi, normal pace)
 *   feeds             RSS URLs, in order of preference
 *
 * Routes (under /api/v1/x/vnnews):
 *   GET  /                    status, window, next bulletin, cached headlines
 *   GET  /headlines           what the next bulletin would read
 *   GET  /script?station=id   the exact words, without airing them
 *   POST /read/:station       owner: read one now, window or no window
 */
import { VoicePool } from './voice.ts'
import { mixWithBed, loadBed } from './bed.ts'

const AGENT = 'Mozilla/5.0 (compatible; Livy/3 VNNews)'

/* ------------------------------ feed bits ----------------------------- */

/**
 * Named entities Vietnamese feeds actually emit.
 *
 * Some outlets publish "TP.HCM đ&agrave;o tạo" — half the accents as
 * entities and half as UTF-8 — so a bulletin that only decodes `&amp;` ends
 * up reading "đ ampersand agrave semicolon o" out loud. Anything numeric is
 * handled generically; these are the named ones that turn up.
 */
const ENTITIES = {
  nbsp: ' ',
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü',
  ygrave: 'ỳ', yacute: 'ý', ntilde: 'ñ', ccedil: 'ç', eth: 'đ',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã',
  Egrave: 'È', Eacute: 'É', Ecirc: 'Ê',
  Igrave: 'Ì', Iacute: 'Í',
  Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ',
  Ugrave: 'Ù', Uacute: 'Ú', Yacute: 'Ý', ETH: 'Đ'
}

export const decodeEntities = (value) =>
  String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,8});/g, (whole, name) => ENTITIES[name] ?? whole)

const strip = (value) =>
  decodeEntities(
    String(value ?? '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ')
  )
    // Twice: a feed that double-escapes (&amp;agrave;) is not rare.
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,8});/g, (whole, name) => ENTITIES[name] ?? whole)
    .replace(/\s+/g, ' ')
    .trim()

const tagOf = (xml, name) => {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml)
  return match ? strip(match[1]) : null
}

/** Every `<item>` in a feed, as plain objects. */
export function parseFeed(xml, source: any = null) {
  const items = []
  for (const match of String(xml).matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)) {
    const body = match[1]
    const title = tagOf(body, 'title')
    if (!title) continue
    items.push({
      title,
      summary: tagOf(body, 'description') ?? '',
      link: tagOf(body, 'link') ?? '',
      publishedAt: Date.parse(tagOf(body, 'pubDate') ?? '') || null,
      source
    })
  }
  return items
}

/** The bit of a VnExpress description that is actually a sentence. */
export function firstSentence(text, limit = 180) {
  const clean = strip(text)
  if (!clean) return ''
  const stop = clean.search(/[.!?…]\s/)
  const sentence = stop > 30 ? clean.slice(0, stop + 1) : clean
  return sentence.length > limit ? `${sentence.slice(0, limit).replace(/\s+\S*$/, '')}…` : sentence
}

/** A short name for a feed, for "theo VnExpress". */
export function sourceName(url = '') {
  const host = /https?:\/\/([^/]+)/i.exec(url)?.[1]?.replace(/^www\./, '') ?? ''
  const known = {
    'vnexpress.net': 'VnExpress',
    'tuoitre.vn': 'Tuổi Trẻ',
    'thanhnien.vn': 'Thanh Niên',
    'dantri.com.vn': 'Dân Trí',
    'vov.vn': 'VOV',
    'vietnamnet.vn': 'VietnamNet',
    'laodong.vn': 'Lao Động',
    'nhandan.vn': 'Nhân Dân'
  }
  return known[host] ?? host
}

/* ------------------------------ the clock ----------------------------- */

/** Minutes past midnight, in the given zone. */
export function localMinutes(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0)
  return hour * 60 + minute
}

const toMinutes = (hhmm, fallback) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (!match) return fallback
  return Math.min(24 * 60, Number(match[1]) * 60 + Number(match[2]))
}

/**
 * Is it news time, and when is the next bulletin?
 *
 * A window that wraps past midnight (`22:00`–`02:00`) is honoured, because
 * somebody will want the late edition.
 */
export function windowState(now, settings) {
  const timezone = settings.timezone || 'Asia/Ho_Chi_Minh'
  const start = toMinutes(settings.start, 17 * 60)
  const end = toMinutes(settings.end, 19 * 60)
  const every = Math.max(5, Number(settings.everyMinutes) || 30)
  const minutes = localMinutes(now, timezone)

  const wraps = end <= start
  const open = wraps ? minutes >= start || minutes < end : minutes >= start && minutes < end

  // Bulletins land on the grid from `start`: 17:00, 17:30, 18:00…
  const sinceStart = (minutes - start + 24 * 60) % (24 * 60)
  const intoSlot = sinceStart % every
  const nextInMinutes = open ? every - intoSlot : (start - minutes + 24 * 60) % (24 * 60)

  return {
    open,
    timezone,
    localTime: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
    window: `${settings.start ?? '17:00'}–${settings.end ?? '19:00'}`,
    everyMinutes: every,
    nextInMinutes,
    // The slot this moment belongs to, used so a bulletin airs once even
    // though the timer ticks more often than that.
    slot: open ? `${new Date(now).toISOString().slice(0, 10)}#${Math.floor(sinceStart / every)}` : null
  }
}

/* ----------------------------- the script ----------------------------- */

const HOUR_WORDS = ['mười hai', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín', 'mười', 'mười một', 'mười hai']

/** "17:30" → "năm giờ ba mươi phút chiều" — TTS reads words better than digits. */
export function spokenTime(minutes) {
  const hour24 = Math.floor(minutes / 60) % 24
  const minute = minutes % 60
  const hour12 = hour24 % 12
  // Vietnamese splits the day at roughly 11, 13 and 19.
  const part = hour24 < 11 ? 'sáng' : hour24 < 13 ? 'trưa' : hour24 < 19 ? 'chiều' : 'tối'
  const words = [`${HOUR_WORDS[hour12]} giờ`]
  if (minute === 30) words.push('rưỡi')
  else if (minute > 0) words.push(`${minute} phút`)
  words.push(part)
  return words.join(' ')
}

/** Turn a list of stories into something a person would actually read out. */
export function buildScript(items, { stationName = 'đài', at = 17 * 60, summaries = true }: any = {}) {
  if (items.length === 0) return null

  const lines = [
    `Xin chào quý vị và các bạn. ${stationName} xin gửi tới quý vị bản tin lúc ${spokenTime(at)}.`,
    `Sau đây là ${items.length} tin chính.`
  ]

  items.forEach((item, index) => {
    lines.push(`Tin thứ ${index + 1}. ${item.title}.`)
    if (summaries && item.summary) lines.push(item.summary)
    if (item.source) lines.push(`Theo ${item.source}.`)
  })

  lines.push('Bản tin đến đây là kết thúc. Cảm ơn quý vị đã lắng nghe, chương trình âm nhạc xin được tiếp tục.')
  return lines.join(' ')
}

/* ------------------------------- plugin ------------------------------- */

export const manifest = {
  name: 'VNNews',
  version: '1.0.0',
  description: 'Vietnamese news bulletins on air 17:00–19:00 Hanoi time, read from VnExpress and friends',
  scope: 'stations'
}

export default function setup(ctx) {
  /** stationId → slot id already read, so a bulletin airs once. */
  const aired = new Map()
  /** The worker that turns the script into speech (with an inline fallback). */
  let voice = null
  /** Links and titles already read on each station. */
  const seen = new Map()
  let cache = { at: 0, items: [] }

  const settingsFor = (stationId) => ({
    start: '17:00',
    end: '19:00',
    timezone: 'Asia/Ho_Chi_Minh',
    everyMinutes: 30,
    headlines: 6,
    summaries: true,
    language: 'vi',
    speed: 1,
    feeds: [],
    ...ctx.stations.settings(stationId)
  })

  async function fetchFeed(url) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const res = await fetch(url, { headers: { 'user-agent': AGENT, accept: 'application/rss+xml,application/xml,text/xml' }, signal: controller.signal })
      if (!res.ok) throw new Error(`${res.status}`)
      return parseFeed(await res.text(), sourceName(url))
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * The newsroom: every feed, in parallel, then edited into a running order.
   *
   * Three things a real bulletin does that a naive sort does not:
   *
   *   • **One dead feed is not a silent bulletin.** Failures are logged and
   *     skipped, and the rest of the news goes out.
   *   • **Timestamps are not trusted.** Vietnamese feeds disagree about time
   *     zones — one outlet stamps local time as UTC and lands seven hours in
   *     the future, another leaves a year-old date on a live story. Dates in
   *     the future are clamped to now and anything older than a day is only
   *     used if there is nothing fresher.
   *   • **No outlet takes the whole bulletin.** Stories are interleaved
   *     round-robin across sources, in the order the feeds are configured,
   *     so a six-story bulletin is six newsrooms, not six pages of one.
   */
  async function headlines(settings, { force = false }: any = {}) {
    if (!force && Date.now() - cache.at < 120_000 && cache.items.length) return cache.items

    const feeds = settings.feeds?.length ? settings.feeds : []
    const results = await Promise.allSettled(feeds.map((url) => fetchFeed(url)))

    const now = Date.now()
    const freshFor = Math.max(1, Number(settings.maxAgeHours) || 24) * 3600_000
    const bySource = new Map()

    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') {
        ctx.log.debug(`feed failed (${feeds[index]}): ${result.reason?.message ?? result.reason}`)
        return
      }
      const source = sourceName(feeds[index])
      const list = bySource.get(source) ?? []
      for (const item of result.value) {
        // A stamp in the future is a time-zone bug, not a scoop.
        const at = item.publishedAt && item.publishedAt <= now + 60_000 ? item.publishedAt : now
        list.push({ ...item, publishedAt: at, stale: item.publishedAt ? now - item.publishedAt > freshFor : false })
      }
      bySource.set(source, list)
    })

    // Newest first inside each outlet…
    for (const list of bySource.values()) list.sort((a, b) => b.publishedAt - a.publishedAt)

    // …then take one from each in turn. Fresh stories first; stale ones are
    // kept at the back rather than thrown away, for a quiet news day.
    const ordered = []
    const queues = [...bySource.values()]
    for (let round = 0; queues.some((list) => list.length); round += 1) {
      for (const list of queues) {
        const item = list.shift()
        if (item) ordered.push(item)
      }
      if (round > 40) break
    }
    ordered.sort((a, b) => Number(a.stale) - Number(b.stale))

    // The same event is on five front pages at once: keep the first telling.
    const byTitle = new Map()
    for (const item of ordered) {
      const key = item.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 60)
      if (!byTitle.has(key)) byTitle.set(key, { ...item, summary: firstSentence(item.summary) })
    }

    cache = { at: Date.now(), items: [...byTitle.values()] }
    if (cache.items.length) {
      ctx.log.debug(`${cache.items.length} headlines from ${bySource.size}/${feeds.length} feed(s)`)
    }
    return cache.items
  }

  /** The stories this station has not read yet. */
  async function nextStories(stationId, settings, options: any = {}) {
    const pool = await headlines(settings, options)
    const already = seen.get(stationId) ?? new Set()
    const fresh = pool.filter((item) => !already.has(item.link || item.title))
    // If everything has been read (a quiet news day), start again rather
    // than air silence.
    const chosen = (fresh.length ? fresh : pool).slice(0, Math.max(1, Number(settings.headlines) || 6))
    return chosen
  }

  function remember(stationId, items) {
    const already = seen.get(stationId) ?? new Set()
    for (const item of items) already.add(item.link || item.title)
    // Keep a day's worth, not a lifetime's.
    if (already.size > 400) seen.set(stationId, new Set([...already].slice(-200)))
    else seen.set(stationId, already)
  }

  /**
   * The voice pool, made on first use.
   *
   * `worker: false` in the settings skips the thread entirely and renders
   * inline — useful on a machine where threads are expensive, and the switch
   * to reach for if anything ever looks wrong.
   */
  function voicePool(settings) {
    if (settings.worker === false) return null
    if (!ctx.tts) return null
    if (!voice) {
      voice = new VoicePool({
        tts: ctx.tts,
        log: (message) => ctx.log.warn(message),
        timeoutMs: Math.max(2000, Number(settings.renderTimeoutMs) || 20_000)
      })
    }
    return voice
  }

  /** Write, voice and air one bulletin. */
  async function readBulletin(stationId, { force = false, reason = 'schedule' }: any = {}) {
    const station = ctx.stations.get(stationId)
    if (!station) throw new Error(`no station "${stationId}" for this plugin`)

    const settings = settingsFor(stationId)
    const state = windowState(Date.now(), settings)
    if (!state.open && !force) return { aired: false, reason: 'outside the news window', ...state }

    const items = await nextStories(stationId, settings, { force })
    if (items.length === 0) return { aired: false, reason: 'no headlines', ...state }

    const minutes = localMinutes(Date.now(), state.timezone)
    const script = buildScript(items, { stationName: station.name, at: minutes, summaries: settings.summaries !== false })
    const language = settings.language ?? 'vi'
    const speed = Number(settings.speed) || 1

    // Voice it *before* airing it. The station will ask the TTS engine for
    // this exact phrase a moment later and find it already rendered, so the
    // announcement starts instantly and the pacer never waited for a
    // network round trip. Every failure path here ends in the station
    // rendering it itself, so this can only make things faster.
    let voiced = null
    const pool = voicePool(settings)
    if (pool) {
      const started = Date.now()
      try {
        const result = await pool.speak(script, { language, speed })
        voiced = { ...result, ms: Date.now() - started }
      } catch (error) {
        ctx.log.debug(`pre-render skipped: ${error.message}`)
      }
    }

    // A bed under the voice, if the owner wants one. It is mixed into a
    // single MP3 here — the station just plays a file, exactly as it would
    // play any other announcement.
    let bedFile = null
    if (settings.bed && settings.bed !== 'none') {
      try {
        const spoken = voiced?.file ?? (await ctx.tts?.speak(script, { language, speed }))?.file
        if (spoken) {
          const mixed = await mixWithBed({
            voiceFile: spoken,
            bed: await loadBed(settings, ctx),
            cacheDir: ctx.tts.cacheDir,
            gainDb: Number(settings.bedGainDb ?? -14),
            duckDb: Number(settings.bedDuckDb ?? -9),
            leadInMs: Number(settings.bedLeadInMs ?? 2500),
            tailMs: Number(settings.bedTailMs ?? 3000)
          })
          if (mixed) bedFile = mixed
        }
      } catch (error) {
        // A bulletin with no music is still a bulletin.
        ctx.log.warn(`music bed skipped: ${error.message}`)
      }
    }

    station.say(script, {
      title: `Bản tin ${state.localTime}`,
      artist: station.name,
      language: settings.language ?? 'vi',
      // A mixed bulletin is a finished file; the station plays it instead of
      // voicing the text again.
      file: bedFile,
      // Bulletins interrupt; that is what a news slot is.
      immediate: true
    })

    remember(stationId, items)
    aired.set(stationId, state.slot)
    sinceBulletin.set(stationId, 0)
    ctx.log.info(
      `${stationId}: bản tin ${state.localTime} — ${items.length} tin (${script.length} ký tự` +
        (voiced ? `, voiced ${voiced.via}${voiced.cached ? ' from cache' : ''} in ${voiced.ms}ms` : '') +
        ')'
    )

    return {
      aired: true,
      reason,
      at: state.localTime,
      stories: items.length,
      characters: script.length,
      voice: voiced ? { via: voiced.via, cached: voiced.cached, ms: voiced.ms } : null,
      bed: Boolean(bedFile),
      ...state
    }
  }

  /* ----------------------------- the timer --------------------------- */

  // Checked every minute: cheap, and it means a station switched on at 17:04
  // does not wait until 17:30 for its first bulletin.
  ctx.every(60_000, async () => {
    for (const station of ctx.stations.list()) {
      const settings = settingsFor(station.id)
      if (settings.enabled === false) continue

      const state = windowState(Date.now(), settings)
      if (!state.open || aired.get(station.id) === state.slot) continue
      // Claim the slot first: a slow render must not queue two bulletins.
      aired.set(station.id, state.slot)

      try {
        await readBulletin(station.id)
      } catch (error) {
        aired.delete(station.id)
        ctx.log.warn(`${station.id}: bulletin failed — ${error.message}`)
      }
    }
  })

  /** stationId → songs played since the last bulletin. */
  const sinceBulletin = new Map()

  /**
   * The other trigger: every N songs.
   *
   * A clock suits a news station; a music station would rather have the
   * headlines between records. Both can be on at once — whichever comes
   * first wins, and the counter resets either way.
   */
  ctx.on('track', async ({ station, data }) => {
    const stationId = station?.id ?? station
    if (!stationId) return

    const settings = settingsFor(stationId)
    const everySongs = Math.max(0, Number(settings.everySongs) || 0)
    if (everySongs === 0) return

    // Idents, bulletins and relays are not songs.
    const track = data?.track
    if (!track || track.announcement || track.live) return

    const count = (sinceBulletin.get(stationId) ?? 0) + 1
    sinceBulletin.set(stationId, count)
    if (count < everySongs) return

    // Respect the window unless the owner said news any time.
    const state = windowState(Date.now(), settings)
    if (!state.open && settings.anytime !== true) return

    sinceBulletin.set(stationId, 0)
    try {
      await readBulletin(stationId, { force: true, reason: `every ${everySongs} songs` })
    } catch (error) {
      ctx.log.warn(`${stationId}: song-triggered bulletin failed — ${error.message}`)
    }
  })

  // A station that is switched off mid-window should not keep its slot.
  ctx.stations.onScopeChange(({ station, enabled }) => {
    if (!enabled) aired.delete(station)
    sinceBulletin.delete(station)
  })

  /* ------------------------------ routes ----------------------------- */

  ctx.registerRoute('GET', '/', async ({ res, send }) => {
    const stations = ctx.stations.list().map((station) => {
      const settings = settingsFor(station.id)
      return { id: station.id, name: station.name, ...windowState(Date.now(), settings), lastSlot: aired.get(station.id) ?? null }
    })
    return send(res, 200, {
      plugin: 'vnnews',
      cachedHeadlines: cache.items.length,
      cachedAt: cache.at || null,
      // How the speech is being made, and whether anything has gone wrong
      // with the worker — the first thing to look at if bulletins are late.
      voice: voice ? { worker: voice.available, ...voice.stats } : { worker: false },
      stations
    })
  })

  ctx.registerRoute('GET', '/headlines', async ({ res, send, url }) => {
    const stationId = url.searchParams.get('station') ?? ctx.stations.list()[0]?.id
    const settings = settingsFor(stationId ?? '')
    const items = await nextStories(stationId ?? '', settings)
    return send(res, 200, { count: items.length, items })
  })

  ctx.registerRoute('GET', '/script', async ({ res, send, fail, url }) => {
    const stationId = url.searchParams.get('station') ?? ctx.stations.list()[0]?.id
    const station = stationId ? ctx.stations.get(stationId) : null
    if (!station) return fail(res, 404, 'No such station for this plugin')

    const settings = settingsFor(stationId)
    const items = await nextStories(stationId, settings)
    const state = windowState(Date.now(), settings)
    return send(res, 200, {
      ...state,
      stories: items.length,
      script: buildScript(items, {
        stationName: station.name,
        at: localMinutes(Date.now(), state.timezone),
        summaries: settings.summaries !== false
      })
    })
  })

  ctx.registerRoute('POST', '/read/:station', async ({ res, send, fail, params, owner }) => {
    if (!owner) return fail(res, 403, 'The owner key is required')
    try {
      return send(res, 200, await readBulletin(params.station, { force: true }))
    } catch (error) {
      return fail(res, 400, error.message)
    }
  })

  ctx.log.info('VNNews ready — bản tin 17:00–19:00 (Asia/Ho_Chi_Minh)')

  return async () => {
    aired.clear()
    seen.clear()
    sinceBulletin.clear()
    await voice?.close()
    voice = null
  }
}
