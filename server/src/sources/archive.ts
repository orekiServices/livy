/**
 * Internet Archive source — the node's hi-res supply.
 *
 * archive.org hosts a huge amount of freely distributable audio and serves it
 * as plain MP3 files, frequently as "VBR MP3" at 192–320 kbps (SoundCloud caps
 * at 128 kbps). That makes it both our quality upgrade path and a strong
 * fallback when another provider refuses to stream a track.
 *
 * Queries:  ia:<terms> | iasearch:<terms> | archive:<terms> |
 *           https://archive.org/details/<id>
 *
 * Two filters matter for a radio rotation:
 *   • collections that are audio but never music (old-time radio, audiobooks,
 *     podcasts, news) are excluded from search;
 *   • only real `.mp3` originals are queued — an item's derivative files
 *     (spectrograms, ZIPs, 64 kbps "alternate" copies) are ignored, and the
 *     highest-bitrate MP3 of each song wins.
 */
import createLogger from '../util/logger.ts'
import { fetchWithConnectTimeout, responseToNodeStream } from '../util/fetchStream.ts'

const log = createLogger('src:archive')
const UA = 'Livy/1 (+https://github.com/orekiServices/livy; mp3 radio)'
const SEARCH = 'https://archive.org/advancedsearch.php'

const seconds = (value) => {
  if (value == null) return 0
  if (typeof value === 'number') return Math.round(value * 1000)
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000)
  const parts = String(value).split(':').map(Number)
  if (parts.some(Number.isNaN)) return 0
  return parts.reduce((acc, part) => acc * 60 + part, 0) * 1000
}

/** Bitrate as a number; "VBR" derivatives are ~192 by convention. */
function bitrateOf(file) {
  const fromField = parseFloat(String(file.bitrate ?? '').replace(/[^\d.]/g, ''))
  if (Number.isFinite(fromField) && fromField > 0) return Math.round(fromField)
  if (/vbr/i.test(file.format ?? '')) return 192
  return 128
}

export class ArchiveSource {
  name = 'archive'
  prefixes = ['ia:', 'iasearch:', 'archive:']
  /** Everything here is a real file download, so quality is whatever the file is. */
  hiRes = true

  #metaCache = new Map()

  /** Ignore mega-compilations; a radio rotation wants songs, not 6-hour reels. */
  maxTrackMs

  constructor({ maxTrackMs = 30 * 60_000 }: any = {}) {
    this.maxTrackMs = maxTrackMs
  }

  canResolve(query) {
    const q = String(query).trim().toLowerCase()
    return this.prefixes.some((p) => q.startsWith(p)) || /^https?:\/\/(www\.)?archive\.org\//.test(q)
  }

  async #json(url) {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`archive.org ${res.status}`)
    return res.json()
  }

  async #metadata(identifier) {
    if (this.#metaCache.has(identifier)) return this.#metaCache.get(identifier)
    const data = await this.#json(`https://archive.org/metadata/${encodeURIComponent(identifier)}`)
    this.#metaCache.set(identifier, data)
    if (this.#metaCache.size > 300) this.#metaCache.delete(this.#metaCache.keys().next().value)
    return data
  }

  /** Expand one archive item into playable MP3 tracks (best bitrate per song). */
  #tracksFrom(meta, { perItem = 3 }: any = {}) {
    const identifier = meta.metadata?.identifier
    if (!identifier) return []

    const creator = [].concat(meta.metadata?.creator ?? 'Internet Archive')[0]
    const album = meta.metadata?.title ?? identifier

    // Group by "song" (original file) and keep the highest-bitrate MP3 of each.
    const best = new Map()
    for (const file of meta.files ?? []) {
      // Only real MP3 files: archive items also expose "…MP3 ZIP" bundles,
      // spectrograms and derivative archives that would poison the queue.
      if (!file.name || !/\.mp3$/i.test(file.name)) continue
      if (!/mp3/i.test(file.format ?? '') || /zip|torrent/i.test(file.format ?? '')) continue
      const lengthMs = seconds(file.length)
      if (lengthMs > 0 && lengthMs > this.maxTrackMs) continue // skip 6-hour compilations
      const key = (file.original ?? file.name).replace(/\.[^.]+$/, '')
      const bitrate = bitrateOf(file)
      const previous = best.get(key)
      if (!previous || bitrate > previous.bitrate) best.set(key, { file, bitrate })
    }

    return [...best.values()]
      .sort((a, b) => b.bitrate - a.bitrate)
      .slice(0, perItem)
      .map(({ file, bitrate }) => ({
        source: 'archive',
        id: `ia:${identifier}/${file.name}`,
        title: file.title ?? file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '),
        artist: file.artist ?? creator,
        album,
        duration: seconds(file.length),
        artwork: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
        url: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(file.name)}`,
        pageUrl: `https://archive.org/details/${encodeURIComponent(identifier)}`,
        bitrate,
        format: file.format,
        size: Number(file.size ?? 0),
        streamable: true
      }))
  }

  /** Collections that are audio but never "radio music": talk, books, shows. */
  static EXCLUDED = ['oldtimeradio', 'audio_bookspoetry', 'librivoxaudio', 'audio_podcast', 'radioprograms', 'audio_news']

  async search(term, limit = 20, { perItem = 3, musicOnly = true }: any = {}) {
    const exclude = musicOnly ? ` AND -collection:(${ArchiveSource.EXCLUDED.join(' OR ')})` : ''
    const query = `mediatype:(audio) AND format:(MP3)${exclude} AND (${term})`
    const url =
      `${SEARCH}?q=${encodeURIComponent(query)}` +
      '&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator&fl%5B%5D=downloads' +
      `&sort%5B%5D=downloads+desc&rows=${Math.max(3, Math.ceil(limit / perItem))}&page=1&output=json`

    const data = await this.#json(url)
    const docs = data.response?.docs ?? []

    const batches = await Promise.allSettled(docs.map((doc) => this.#metadata(doc.identifier)))
    const tracks = []
    for (const batch of batches) {
      if (batch.status !== 'fulfilled') continue
      tracks.push(...this.#tracksFrom(batch.value, { perItem }))
      if (tracks.length >= limit) break
    }

    log.debug(`search "${term}" -> ${tracks.length} tracks`)
    return tracks.slice(0, limit)
  }

  async resolve(query, { limit = 30 }: any = {}) {
    let q = String(query).trim()
    for (const p of this.prefixes) if (q.toLowerCase().startsWith(p)) q = q.slice(p.length).trim()

    const detail = /archive\.org\/(?:details|download)\/([^/?#]+)/i.exec(q)
    if (detail) {
      const meta = await this.#metadata(decodeURIComponent(detail[1]))
      return { type: 'playlist', name: meta.metadata?.title ?? detail[1], tracks: this.#tracksFrom(meta, { perItem: limit }) }
    }

    return { type: 'search', name: q, tracks: await this.search(q, limit) }
  }

  async stream(track, { signal }: any = {}) {
    if (!track.url) throw new Error('archive.org: missing stream url')
    const res = await fetchWithConnectTimeout(track.url, {
      headers: { 'user-agent': UA },
      connectTimeoutMs: 20_000,
      signal
    })
    if (!res.ok || !res.body) throw new Error(`archive.org download ${res.status}`)
    return {
      stream: responseToNodeStream(res, { signal }),
      contentType: res.headers.get('content-type') || 'audio/mpeg',
      mode: 'archive',
      bitrate: track.bitrate
    }
  }

  getTrackUrl(track) {
    return track.url ?? null
  }
}

export default ArchiveSource
