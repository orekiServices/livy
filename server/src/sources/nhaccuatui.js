/**
 * NhacCuaTui — Vietnam's largest streaming catalogue.
 *
 * This is where a Vietnamese listener's request should land first: the
 * catalogue is Vietnamese music, not a Western library with a few local
 * albums bolted on. For a radio node running in Huế, SoundCloud's long tail
 * simply does not cover the songs people ask for.
 *
 * Two upstreams, and one of them is the interesting part:
 *
 *   1. **`beta.nhaccuatui.com/api`** — an undocumented JSON API. Every call
 *      is signed with `a` (a fixed public app key), `t` (now, in ms) and `s`
 *      (HMAC-SHA512 of `t` with a secret that ships in the web bundle as an
 *      AES blob). This is an unofficial client for an unofficial API: it can
 *      break without warning, and if it does, the source says so and the
 *      registry falls through to its next provider rather than failing the
 *      station.
 *
 *   2. **`nhaccuatui.com/download/song/<key>`** — the endpoint the web
 *      player itself calls, which answers with `{ data: { stream_url } }`
 *      pointing at the CDN. That is a *public* MP3, so streaming it server
 *      side needs no browser session. This is what actually plays.
 *
 * Queries:
 *   nctsearch:<terms>            nct:<terms>
 *   https://www.nhaccuatui.com/bai-hat/<slug>.<key>.html
 *   https://www.nhaccuatui.com/playlist/<slug>.<key>.html
 *
 * Quality: the download endpoint serves MP3 (commonly 320 kbps for newer
 * uploads, `_hq`/`_320` style names at the CDN). Which tier you get is
 * NhacCuaTui's decision; `bitrate` therefore reports the conservative 128
 * unless the CDN filename advertises better, so the hi-res re-clone pass is
 * never misled into thinking a 128 kbps file is hi-res.
 */
import crypto from 'node:crypto'
import https from 'node:https'
import { Readable } from 'node:stream'

import createLogger from '../util/logger.js'

const log = createLogger('src:nhaccuatui')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const API = 'https://beta.nhaccuatui.com/api'
const PAGE = 'https://www.nhaccuatui.com'
const SITE = 'nhaccuatui.com'

/**
 * The public app key and the AES-wrapped HMAC secret, exactly as the site's
 * own bundle ships them. Neither is a credential anyone can revoke on our
 * behalf — they are the client's identity, and every unofficial NCT client
 * carries the same pair.
 */
const APP_KEY = 'e3afd4b6c89147258a56a641af16cc79'
const SECRET_BLOB = 'U2FsdGVkX19BWoF1uTP8o90p9KAWsXZ/VJ41PG7XYF/63qnjiMh1TLy8zAfZBMa9iqiGyPiN5iMUocpD74kAsg=='
const SECRET_PASSPHRASE = 'nhaccuatui'

/**
 * `s` is an HMAC-SHA512 of the millisecond timestamp, keyed with the secret
 * that the site keeps AES-encrypted in its bundle.
 *
 * The blob is OpenSSL's `Salted__` format: 8 byte magic, 8 byte salt, then
 * AES-256-CBC. Node will *not* derive the key from a passphrase when the salt
 * is supplied separately — `createDecipheriv` insists on a real key and iv —
 * so the derivation is spelled out here: OpenSSL's `EVP_BytesToKey` with MD5
 * and one iteration, `D_i = MD5(D_{i-1} ‖ passphrase ‖ salt)`, taking 32
 * bytes of key then 16 of iv. That is the same scheme crypto-js uses for
 * `CryptoJS.AES.decrypt(blob, 'nhaccuatui')`, and it decrypts to the
 * 32-character hex secret.
 *
 * It is computed once and kept: the timestamp changes per request but the key
 * does not, and decrypting it is the only expensive step.
 */
function unwrapSecret() {
  const raw = Buffer.from(SECRET_BLOB, 'base64')
  if (raw.subarray(0, 8).toString('binary') !== 'Salted__') throw new Error('not an OpenSSL blob')
  const salt = raw.subarray(8, 16)
  const body = raw.subarray(16)

  const passphrase = Buffer.from(SECRET_PASSPHRASE)
  const blocks = []
  let previous = Buffer.alloc(0)
  while (Buffer.concat(blocks).length < 48) {
    previous = crypto.createHash('md5').update(Buffer.concat([previous, passphrase, salt])).digest()
    blocks.push(previous)
  }
  const material = Buffer.concat(blocks)
  const decipher = crypto.createDecipheriv('aes-256-cbc', material.subarray(0, 32), material.subarray(32, 48))
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}

let cachedSecret = null
function secret() {
  if (cachedSecret) return cachedSecret
  try {
    cachedSecret = unwrapSecret()
  } catch (error) {
    log.debug(`could not unwrap the API secret: ${error.message}`)
    // A wrong secret only costs a signature that upstream rejects, which is a
    // failure this source already handles — better than throwing at import.
    cachedSecret = SECRET_PASSPHRASE
  }
  return cachedSecret
}

/** `{ a, s, t }` for one call. `t` is milliseconds, as the site sends it. */
function signedQuery() {
  const t = String(Date.now())
  const s = crypto.createHmac('sha512', secret()).update(t).digest('hex')
  return `a=${encodeURIComponent(APP_KEY)}&s=${s}&t=${t}`
}

/**
 * A POST with a form body, over `node:https` rather than fetch.
 *
 * Two reasons: these responses carry long `Set-Cookie`/`Link` headers that
 * trip undici's 16 KB limit (the same reason ccMixter uses https), and the
 * API wants `Content-Type: application/x-www-form-urlencoded` with a body
 * that is *not* JSON.
 */
function postForm(path, body = '', { timeout = 12_000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = `${API}/${path}?${signedQuery()}`
    const payload = Buffer.from(body, 'utf8')
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'user-agent': UA,
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': payload.length,
          referer: `${PAGE}/`
        },
        maxHeaderSize: 256 * 1024,
        timeout
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode >= 400) return reject(new Error(`nhaccuatui api ${res.statusCode}`))
          try {
            resolve(JSON.parse(text))
          } catch (error) {
            reject(new Error(`nhaccuatui: bad JSON (${error.message})`))
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('nhaccuatui: timed out')))
    req.on('error', reject)
    req.end(payload)
  })
}

/** Does this object look like a song, rather than a playlist or an envelope? */
function isSong(row) {
  return Boolean(row && typeof row === 'object' && (row.key || row.songKey) && (row.name || row.title))
}

/**
 * The API wraps everything in `{ data: … }` and is inconsistent about whether
 * a result is `data`, `data.items`, `data.listSong` or `data.song`. Rather
 * than guess per endpoint, walk the envelope for the first thing that looks
 * like songs — **including a bare object**, because `media/info` answers with
 * a single song and no list around it.
 */
function songList(payload) {
  const seen = new Set()
  const walk = (node, depth = 0) => {
    if (!node || depth > 4) return null
    if (Array.isArray(node)) {
      const songs = node.filter(isSong)
      return songs.length ? songs : null
    }
    if (typeof node !== 'object' || seen.has(node)) return null
    if (isSong(node)) return [node]
    seen.add(node)
    for (const key of ['items', 'listSong', 'song', 'list', 'data', 'result', 'search']) {
      if (key in node) {
        const found = walk(node[key], depth + 1)
        if (found) return found
      }
    }
    return null
  }
  return walk(payload) ?? []
}

/** The CDN advertises its tier in the filename: `_hq`, `_320`, `128`. */
function bitrateFromUrl(url = '') {
  const s = String(url).toLowerCase()
  if (/(^|[_-])320|_hq/.test(s)) return 320
  if (/(^|[_-])192/.test(s)) return 192
  if (/(^|[_-])128/.test(s)) return 128
  // NhacCuaTui's default CDN files are 128 kbps; claiming higher would make
  // the hi-res re-clone pass skip a track that actually needs it.
  return 128
}

/** `00:04:12` | `252` | `4:12` → milliseconds. */
function toMs(value) {
  if (value == null || value === '') return 0
  if (typeof value === 'number') return Math.round(value > 10_000 ? value : value * 1000)
  const text = String(value).trim()
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000)
  const parts = text.split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part))) return 0
  const seconds = parts.reduce((total, part) => total * 60 + part, 0)
  return Math.round(seconds * 1000)
}

/** The first of several spellings that actually has something in it. */
function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return null
}

/** Join an `artists`/`singers` array of names or `{name}` objects. */
function names(list) {
  if (!Array.isArray(list)) return null
  const joined = list
    .map((entry) => (typeof entry === 'string' ? entry : entry?.name ?? entry?.singerName ?? null))
    .filter((name) => typeof name === 'string' && name.trim())
    .join(', ')
  return joined || null
}

/**
 * Whatever the API calls the artist this week.
 *
 * `??` is the wrong operator here and was the bug: an empty string is not
 * nullish, so a row carrying `artistName: ''` and a perfectly good `singers`
 * array reported the artist as the empty string. Take the first spelling that
 * has text in it.
 */
function artistOf(row = {}) {
  return firstText(row.artistName, row.singerName, row.artist, row.singer, names(row.artists), names(row.singers)) ?? 'NhacCuaTui'
}

function artOf(row = {}) {
  return firstText(row.image, row.thumbnail, row.cover, row.artistCover, row.imageUrl)
}

export class NhacCuaTuiSource {
  name = 'nhaccuatui'
  prefixes = ['nctsearch:', 'nct:', 'nhaccuatui:']

  canResolve(query) {
    const q = String(query).trim().toLowerCase()
    return this.prefixes.some((p) => q.startsWith(p)) || /^https?:\/\/(www\.|beta\.)?nhaccuatui\.com\//.test(q)
  }

  /** One search row → a Livy track (a promise-free map; the key is the id). */
  #track(row) {
    const key = row.key ?? row.songKey
    if (!key) return null
    // Same empty-string trap as the artist: `.test('')` is false, but a field
    // that is a *blank string* would otherwise win over the real link, and a
    // `${PAGE}` + '' link is not a page.
    const link = firstText(row.link)
    const pageUrl = firstText(row.url) ?? (link ? `${PAGE}${link}` : `${PAGE}/bai-hat/${firstText(row.slug) ?? 'song'}.${key}.html`)
    return {
      source: 'nhaccuatui',
      id: `nct:${key}`,
      // The key is the only thing the stream endpoint needs.
      nctKey: key,
      title: String(row.name ?? row.title ?? 'Untitled').replace(/\s+/g, ' ').trim(),
      artist: artistOf(row),
      album: row.albumName ?? row.album ?? null,
      duration: toMs(row.duration ?? row.time ?? row.length),
      artwork: artOf(row),
      pageUrl,
      bitrate: 128,
      streamable: true
    }
  }

  async search(term, limit = 15) {
    const q = String(term).trim()
    if (!q) return []
    const payload = await postForm('search/all', `key=${encodeURIComponent(q)}`)
    const rows = songList(payload)

    // `search/all` mixes songs, playlists, albums and videos; only rows that
    // carry a song key can be played, and the ones marked as something else
    // (an mv, a playlist) must not be aired as songs.
    const tracks = []
    for (const row of rows) {
      if (row.type && !/song|bai-hat/i.test(String(row.type))) continue
      const track = this.#track(row)
      if (track) tracks.push(track)
      if (tracks.length >= limit) break
    }
    log.debug(`search "${q}" -> ${tracks.length}`)
    return tracks
  }

  /** Song detail — one key in, the same track shape out. */
  async #detail(key) {
    const payload = await postForm('media/info', `key=${encodeURIComponent(key)}&type=song`)
    const row = songList(payload)[0] ?? null
    if (!row) return null
    const track = this.#track(row)
    if (!track) return null

    // The detail response is also where the stream URLs live, so keep them
    // and skip the extra round trip through /download/song later.
    const streams = Array.isArray(row.streamURL) ? row.streamURL : []
    const best = streams.find((s) => /320/.test(String(s?.typeUI))) ?? streams.find((s) => /lossless|flac/i.test(String(s?.typeUI))) ?? streams[0]
    if (best?.stream) {
      track.directUrl = best.stream
      track.bitrate = bitrateFromUrl(best.typeUI ?? best.stream)
    }
    return track
  }

  async resolve(query, { limit = 30 } = {}) {
    let q = String(query).trim()
    for (const prefix of this.prefixes) {
      if (q.toLowerCase().startsWith(prefix)) q = q.slice(prefix.length).trim()
    }

    // A song page: the key is the last dotted segment of the slug.
    const songKey = /\/bai-hat\/[^/]*?\.([A-Za-z0-9]+)\.html/i.exec(q)?.[1]
    if (songKey) {
      const track = await this.#detail(songKey)
      if (!track) throw new Error('Nothing playable at that NhacCuaTui link')
      return { type: 'track', name: track.title, tracks: [track] }
    }

    // A playlist page: the site renders it from the same API, but the key's
    // type differs and the response is a list, so ask for it as a playlist.
    const playlistKey = /\/playlist\/[^/]*?\.([A-Za-z0-9]+)\.html/i.exec(q)?.[1]
    if (playlistKey) {
      const payload = await postForm('media/info', `key=${encodeURIComponent(playlistKey)}&type=playlist`)
      const tracks = songList(payload)
        .map((row) => this.#track(row))
        .filter(Boolean)
        .slice(0, limit)
      if (!tracks.length) throw new Error('Nothing playable in that NhacCuaTui playlist')
      return { type: 'playlist', name: tracks[0].album ?? 'NhacCuaTui playlist', tracks }
    }

    // A bare nhaccuatui.com URL we do not recognise: try it as a song key
    // rather than silently falling through to a search of the URL text.
    if (/^https?:\/\//i.test(q) && q.includes(SITE)) {
      const tail = /\.([A-Za-z0-9]+)\.html/i.exec(q)?.[1]
      if (tail) {
        const track = await this.#detail(tail)
        if (track) return { type: 'track', name: track.title, tracks: [track] }
      }
      throw new Error('Unrecognised NhacCuaTui link')
    }

    return { type: 'search', name: q, tracks: await this.search(q, limit) }
  }

  /**
   * The CDN URL, from whichever of the two upstreams answers first.
   *
   * The detail response usually already carries it; `/download/song` is the
   * fallback because that is what the site's own player calls when it does
   * not. Both want the song key and nothing else, which is why the key is
   * carried on the track separately from the prefixed `id`.
   */
  async getTrackUrl(track) {
    if (track.directUrl) return track.directUrl
    const key = track.nctKey ?? String(track.id ?? '').replace(/^nct:/, '')
    if (!key) return null

    const res = await fetch(`${PAGE}/download/song/${encodeURIComponent(key)}`, {
      headers: { 'user-agent': UA, accept: 'application/json', referer: track.pageUrl ?? `${PAGE}/` },
      signal: AbortSignal.timeout(12_000)
    })
    if (!res.ok) throw new Error(`nhaccuatui download ${res.status}`)
    const payload = await res.json()
    const url = payload?.data?.stream_url ?? payload?.data?.streamUrl ?? null
    if (!url) throw new Error(payload?.error_message ? `nhaccuatui: ${payload.error_message}` : 'nhaccuatui: no stream url')
    return url
  }

  async stream(track) {
    const url = await this.getTrackUrl(track)
    if (!url) throw new Error('nhaccuatui: no stream url')

    const res = await fetch(url, {
      headers: { 'user-agent': UA, referer: `${PAGE}/` },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000)
    })
    if (!res.ok || !res.body) throw new Error(`nhaccuatui stream ${res.status}`)
    return {
      stream: Readable.fromWeb(res.body),
      contentType: res.headers.get('content-type') ?? 'audio/mpeg',
      mode: 'nhaccuatui',
      bitrate: track.bitrate ?? bitrateFromUrl(url)
    }
  }
}

export default NhacCuaTuiSource
