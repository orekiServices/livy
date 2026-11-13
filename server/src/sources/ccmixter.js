/**
 * ccMixter source — Creative Commons remix community, no API key.
 *
 *   ccsearch:<terms> | https://ccmixter.org/files/<user>/<id>
 *
 * The query API returns the uploaded files directly, most of them VBR MP3s
 * at 192 kbps or better, which makes this a useful hi-res clone target when
 * SoundCloud only offers a 128 kbps progressive stream.
 */
import https from 'node:https'
import { Readable } from 'node:stream'
import createLogger from '../util/logger.js'

const log = createLogger('src:ccmixter')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const API = 'https://ccmixter.org/api/query'

/**
 * ccMixter answers its API with a very large header block (long Set-Cookie and
 * Link headers), which trips undici's 16 KB limit — so the JSON calls go
 * through node:https with a roomier `maxHeaderSize` instead of fetch().
 */
function getJson(url, { timeout = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'user-agent': UA, accept: 'application/json' }, maxHeaderSize: 256 * 1024, timeout },
      (res) => {
        if (res.statusCode >= 400) {
          res.resume()
          return reject(new Error(`ccmixter ${res.statusCode}`))
        }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (error) {
            reject(new Error(`ccmixter: bad JSON (${error.message})`))
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('ccmixter: timed out')))
    req.on('error', reject)
  })
}

/** "…,mp3,44k,stereo,VBR,…,flac,192k,…" → best MP3 bitrate we can infer. */
function bitrateFromTags(systags = '') {
  const kbps = [...String(systags).matchAll(/(\d{2,3})k/g)].map((m) => Number(m[1]))
  const best = kbps.filter((n) => n >= 64 && n <= 320).sort((a, b) => b - a)[0]
  return best ?? 192 // ccMixter uploads are VBR ~192 by convention
}

export class CcMixterSource {
  name = 'ccmixter'
  prefixes = ['ccsearch:', 'ccmixter:']
  hiRes = true

  canResolve(query) {
    const q = String(query).trim().toLowerCase()
    return this.prefixes.some((p) => q.startsWith(p)) || /^https?:\/\/(dig\.)?ccmixter\.org\//.test(q)
  }

  #toTracks(rows, limit) {
    const tracks = []
    for (const row of rows) {
      const file = (row.files ?? []).find((f) => /\.mp3$/i.test(f.download_url ?? f.file_name ?? ''))
      if (!file) continue
      const bitrate = bitrateFromTags(row.upload_extra?.systags)
      tracks.push({
        source: 'ccmixter',
        id: `cc:${row.upload_id}`,
        title: String(row.upload_name ?? 'Untitled').replace(/\s+/g, ' ').trim(),
        artist: row.user_name ?? 'ccMixter',
        album: null,
        duration: Number(file.file_extra?.duration_num ?? 0) * 1000 || 0,
        artwork: row.user_page_image ?? null,
        url: file.download_url,
        pageUrl: row.file_page_url ?? `https://ccmixter.org/files/${row.user_name}/${row.upload_id}`,
        bitrate,
        licence: row.license_name ?? 'Creative Commons',
        streamable: true
      })
      if (tracks.length >= limit) break
    }
    return tracks
  }

  async search(term, limit = 15) {
    // Ask for more than we need: rows without an MP3 file (FLAC-only uploads,
    // samples, a cappellas) are dropped, so the raw count is not the result
    // count.
    const url = `${API}?f=json&limit=${Math.min(limit * 3, 60)}&search=${encodeURIComponent(term)}&search_type=all&sort=rank`
    const rows = await getJson(url)
    const tracks = this.#toTracks(Array.isArray(rows) ? rows : [], limit)
    log.debug(`search "${term}" -> ${tracks.length}`)
    return tracks
  }

  async resolve(query, { limit = 30 } = {}) {
    let q = String(query).trim()
    for (const p of this.prefixes) if (q.toLowerCase().startsWith(p)) q = q.slice(p.length).trim()

    const id = /ccmixter\.org\/files\/[^/]+\/(\d+)/.exec(q)?.[1]
    if (id) {
      const tracks = this.#toTracks(await getJson(`${API}?f=json&ids=${id}`), 1)
      if (!tracks.length) throw new Error('No MP3 on that ccMixter upload')
      return { type: 'track', name: tracks[0].title, tracks }
    }

    return { type: 'search', name: q, tracks: await this.search(q, limit) }
  }

  /** The download URL is already public and stable. */
  getTrackUrl(track) {
    return track.url ?? null
  }

  async stream(track) {
    return new Promise((resolve, reject) => {
      const req = https.get(
        track.url,
        {
          headers: { 'user-agent': UA, referer: track.pageUrl ?? 'https://ccmixter.org/' },
          maxHeaderSize: 256 * 1024,
          timeout: 20_000
        },
        (res) => {
          if (res.statusCode >= 400) {
            res.resume()
            return reject(new Error(`ccmixter stream ${res.statusCode}`))
          }
          resolve({ stream: res, contentType: 'audio/mpeg', mode: 'ccmixter', bitrate: track.bitrate })
        }
      )
      req.on('timeout', () => req.destroy(new Error('ccmixter: timed out')))
      req.on('error', reject)
    })
  }
}

export default CcMixterSource
