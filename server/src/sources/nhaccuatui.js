/**
 * NhacCuaTui — Vietnam's largest streaming catalogue.
 *
 * This is where a Vietnamese listener's request should land: the catalogue is
 * Vietnamese music, not a Western library with a few local albums bolted on.
 * For a radio node running in Huế, SoundCloud's long tail does not carry the
 * songs people ask for.
 *
 * ## The API moved
 *
 * The old `beta.nhaccuatui.com/api` (HMAC-signed `a`/`s`/`t`) is gone. The
 * service now answers on **`graph.nct.vn`**, anonymously, with the headers an
 * Android client sends and no signature at all. This was checked against three
 * independent clients and — the one that settles it — a live probe dated
 * 2026-10-22 that recorded real HTTP codes:
 *
 *   search   GET /api/v1/search/song?keyword=&pageindex=&pagesize=&correct=true
 *   detail   GET /api/v1/song/detail/<key>
 *
 * Both wrap their payload in `{ code, msg, success, data }`, where `code === 0`
 * is the success case. Search returns `data.songs[]`; detail returns the song
 * itself.
 *
 * ## What actually plays
 *
 * A song's `streamURL[]` entries carry `{ type, typeUI, stream, download,
 * onlyVIP, status, order }`. The probe's finding, reproduced here: **public
 * 128 kbps streams play without a login**, served from `stream.nct.vn` or
 * `a01.nct.vn`, `audio/mpeg`, answering HTTP 206 to a Range request.
 *
 * Two rules follow, and both matter:
 *
 *   • never take an `onlyVIP` entry — it is not a stream we are allowed to
 *     open, and pretending otherwise fails at the first byte;
 *   • resolve the URL when the stream is actually opened, not when the track
 *     is queued. The CDN URLs are signed and expire, so a queue that cached
 *     one for four minutes ago is holding a dead link.
 *
 * Anonymous quality is 128 kbps, so `hiRes` is deliberately false and
 * `bitrate` reports what was selected rather than what the catalogue offers —
 * otherwise the hi-res re-clone pass would skip a track that needs it.
 *
 * ## Unofficial, and allowed to break
 *
 * This is an undocumented API. When it moves, this source throws and the
 * registry falls through to its next provider — that is the designed failure,
 * not a station going silent.
 *
 * Queries:
 *   nctsearch:<terms>            nct:<terms>
 *   https://www.nhaccuatui.com/song/<key>
 *   https://www.nhaccuatui.com/bai-hat/<slug>.<key>.html
 *   https://www.nhaccuatui.com/playlist/<slug>.<key>.html
 */
import { Readable } from 'node:stream'

import createLogger from '../util/logger.js'

const log = createLogger('src:nhaccuatui')

const API = 'https://graph.nct.vn'
const PAGE = 'https://www.nhaccuatui.com'
const SITE = 'nhaccuatui.com'

/** What the Android client sends. `x-os` is what the service keys its answers on. */
const HEADERS = {
  'user-agent': 'okhttp/4.12.0',
  'x-os': 'android',
  accept: 'application/json',
  'content-type': 'application/json'
}

/** CDN hosts a signed stream URL is allowed to point at. */
const STREAM_HOSTS = ['nct.vn', 'nhaccuatui.com', 'nixcdn.com']

/* ------------------------------ transport ------------------------------ */

/**
 * One API call. `code === 0` is success; anything else is an error the caller
 * is expected to let escape, because the registry knows how to fall through.
 */
async function api(path, params = {}, { timeout = 12_000 } = {}) {
  const url = new URL(path, API)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }

  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeout) })
  if (!res.ok) throw new Error(`nhaccuatui ${res.status}`)

  const payload = await res.json()
  if (payload?.success === false || (payload?.code !== undefined && payload.code !== 0)) {
    throw new Error(`nhaccuatui: ${payload?.msg || `code ${payload?.code}`}`)
  }
  return payload?.data ?? null
}

/* ------------------------------- parsing ------------------------------- */

/** The first of several spellings that actually has something in it. */
function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return null
}

/**
 * `artist` is an array of `{ key, name, image }` on the current API, and
 * `artistName` is the collapsed credit. Prefer the array (it names every
 * performer on a collaboration) and fall back to the scalar.
 */
function artistOf(row = {}) {
  const list = Array.isArray(row.artist) ? row.artist : null
  if (list) {
    const joined = list
      .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
      .filter((name) => typeof name === 'string' && name.trim())
      .join(', ')
    if (joined) return joined
  }
  return firstText(row.artistName) ?? 'NhacCuaTui'
}

function artworkOf(row = {}) {
  return firstText(row.image, row.thumbnail, row.bgImage, row.artistImage)
}

/**
 * Duration's unit is not documented and no client converts it. A song longer
 * than 10,000 is already milliseconds; anything smaller can only be seconds.
 */
function durationMs(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n > 10_000 ? n : n * 1000)
}

/** Is this stream entry one we can actually open? */
function playable(entry) {
  return Boolean(entry?.stream) && entry.onlyVIP !== true && entry.status !== 0
}

/**
 * Pick the best open stream.
 *
 * `order` ranks the tiers (the highest is the best available), but a VIP tier
 * must never win: an `onlyVIP` 320 is not a 320 we can play, and preferring it
 * because its number is bigger means silence. So filter to what is playable,
 * *then* rank.
 */
function bestStream(streams = []) {
  const open = streams.filter(playable)
  if (!open.length) return null
  return open.slice().sort((a, b) => (Number(b.order) || 0) - (Number(a.order) || 0))[0]
}

/** A signed URL is only followed to a host the service actually serves from. */
function trustedStreamUrl(value) {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    const host = url.hostname.toLowerCase()
    return STREAM_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)) ? url : null
  } catch {
    return null
  }
}

/** `987654321` (ms, 1-based or 0-based pages) → a positive integer. */
function positive(value, fallback) {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/* -------------------------------- source ------------------------------- */

export class NhacCuaTuiSource {
  name = 'nhaccuatui'
  prefixes = ['nctsearch:', 'nct:', 'nhaccuatui:']

  canResolve(query) {
    const q = String(query).trim().toLowerCase()
    return this.prefixes.some((p) => q.startsWith(p)) || /^https?:\/\/(www\.)?nhaccuatui\.com\//.test(q)
  }

  /** One API row → a Livy track. The key is the only thing playback needs. */
  #track(row) {
    const key = firstText(row?.key, row?.songKey)
    if (!key) return null

    const title = firstText(row.name, row.title)
    if (!title) return null

    // A track with no open stream at all is not queueable — airing it would
    // fail at the first byte, after the queue has already committed to it.
    const stream = bestStream(Array.isArray(row.streamURL) ? row.streamURL : [])
    const page = firstText(row.url) ?? `${PAGE}/song/${key}`

    return {
      source: 'nhaccuatui',
      id: `nct:${key}`,
      // Kept apart from the prefixed `id`: the stream call wants the bare key.
      nctKey: key,
      title: title.replace(/\s+/g, ' ').trim(),
      artist: artistOf(row),
      album: firstText(row.albumName, row.album),
      duration: durationMs(row.duration),
      artwork: artworkOf(row),
      pageUrl: page,
      // Anonymous playback is 128 kbps; say so rather than flattering the row.
      bitrate: stream ? 128 : null,
      streamable: Boolean(stream)
    }
  }

  async search(term, limit = 15) {
    const keyword = String(term).trim()
    if (!keyword) return []

    const data = await api('/api/v1/search/song', {
      keyword,
      pageindex: 1,
      pagesize: Math.min(Math.max(positive(limit, 15), 1), 50),
      // Ask the service to correct typos; it is noticeably better with them.
      correct: 'true'
    })

    const rows = Array.isArray(data?.songs) ? data.songs : []
    const tracks = []
    for (const row of rows) {
      const track = this.#track(row)
      if (track?.streamable) tracks.push(track)
      if (tracks.length >= limit) break
    }
    log.debug(`search "${keyword}" -> ${tracks.length}/${rows.length}`)
    return tracks
  }

  /** Song detail. This is the call that carries the signed stream URLs. */
  async #detail(key) {
    const data = await api(`/api/v1/song/detail/${encodeURIComponent(key)}`)
    return data ? this.#track(data) : null
  }

  async resolve(query, { limit = 30 } = {}) {
    let q = String(query).trim()
    for (const prefix of this.prefixes) {
      if (q.toLowerCase().startsWith(prefix)) q = q.slice(prefix.length).trim()
    }

    // `/song/<key>` is the current shape; the older `/bai-hat/<slug>.<key>.html`
    // still resolves because links to it are all over the web.
    const songKey = /\/song\/([A-Za-z0-9]+)/i.exec(q)?.[1] ?? /\/bai-hat\/[^/]*?\.([A-Za-z0-9]+)\.html/i.exec(q)?.[1]
    if (songKey) {
      const track = await this.#detail(songKey)
      if (!track?.streamable) throw new Error('Nothing playable at that NhacCuaTui link')
      return { type: 'track', name: track.title, tracks: [track] }
    }

    const playlistKey = /\/playlist\/[^/]*?\.([A-Za-z0-9]+)\.html/i.exec(q)?.[1]
    if (playlistKey) {
      const data = await api(`/api/v1/playlist/detail/${encodeURIComponent(playlistKey)}`, {
        key: playlistKey,
        // One-based: pn=0 comes back with an empty track list.
        pn: 1,
        rn: Math.min(Math.max(positive(limit, 30), 1), 100)
      })
      const rows = Array.isArray(data?.listSong) ? data.listSong : []
      const tracks = rows.map((row) => this.#track(row)).filter((track) => track?.streamable).slice(0, limit)
      if (!tracks.length) throw new Error('Nothing playable in that NhacCuaTui playlist')
      return { type: 'playlist', name: firstText(data?.title, data?.name) ?? tracks[0].album ?? 'NhacCuaTui playlist', tracks }
    }

    if (/^https?:\/\//i.test(q) && q.includes(SITE)) throw new Error('Unrecognised NhacCuaTui link')

    return { type: 'search', name: q, tracks: await this.search(q, limit) }
  }

  /**
   * The CDN URL, resolved at the moment of playing rather than at queue time.
   *
   * Signed URLs expire, so a track that sat in the queue for four minutes is
   * holding a link that no longer opens. One detail call is cheap and always
   * returns the current signature.
   */
  async getTrackUrl(track) {
    const key = firstText(track?.nctKey) ?? String(track?.id ?? '').replace(/^nct:/, '')
    if (!key) return null

    const data = await api(`/api/v1/song/detail/${encodeURIComponent(key)}`)
    const streams = Array.isArray(data?.streamURL) ? data.streamURL : []
    const chosen = bestStream(streams)
    // `download` is the same file offered as a download; prefer it only when
    // `stream` is missing, because the download tier can be the VIP one.
    const url = trustedStreamUrl(chosen?.stream) ?? trustedStreamUrl(chosen?.download)
    if (!url) throw new Error('nhaccuatui: no playable stream')
    return url.toString()
  }

  async stream(track) {
    const url = await this.getTrackUrl(track)
    if (!url) throw new Error('nhaccuatui: no stream url')

    const res = await fetch(url, {
      // The CDN checks the referer, and answers 206 to a Range request, which
      // is exactly what a seek in the console sends.
      headers: { 'user-agent': HEADERS['user-agent'], referer: `${PAGE}/` },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000)
    })
    if (!res.ok && res.status !== 206) throw new Error(`nhaccuatui stream ${res.status}`)
    if (!res.body) throw new Error('nhaccuatui stream: empty body')

    return {
      stream: Readable.fromWeb(res.body),
      contentType: res.headers.get('content-type') ?? 'audio/mpeg',
      mode: 'nhaccuatui',
      // Anonymous playback is the 128 kbps tier; the header is believed when
      // it says something, but it usually does not.
      bitrate: track.bitrate ?? 128
    }
  }
}

export default NhacCuaTuiSource
