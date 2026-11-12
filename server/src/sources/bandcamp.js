/**
 * Bandcamp source. Full-length `mp3-128` streams are embedded in every track
 * and album page inside the `data-tralbum` blob, so no API key is involved.
 *
 * Queries: bcsearch:<terms> | https://<artist>.bandcamp.com/track|album/<slug>
 */
import { Readable } from 'node:stream'
import createLogger from '../util/logger.js'

const log = createLogger('src:bandcamp')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export class BandcampSource {
  name = 'bandcamp'
  prefixes = ['bcsearch:', 'bandcamp:']

  canResolve(query) {
    const q = String(query).trim().toLowerCase()
    return this.prefixes.some((p) => q.startsWith(p)) || /^https?:\/\/[^/]+\.bandcamp\.com\//.test(q)
  }

  async #page(url) {
    const res = await fetch(url, { headers: { 'user-agent': UA } })
    if (!res.ok) throw new Error(`bandcamp ${res.status}`)
    return res.text()
  }

  #tracksFromPage(html, pageUrl) {
    const match = /data-tralbum="([^"]+)"/.exec(html)
    if (!match) return []
    let blob
    try {
      blob = JSON.parse(decodeEntities(match[1]))
    } catch {
      return []
    }

    const artUrl = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1] ?? null
    const artist = blob.artist ?? 'Bandcamp artist'

    return (blob.trackinfo ?? [])
      .filter((t) => t.file?.['mp3-128'])
      .map((t) => ({
        source: 'bandcamp',
        id: `bc:${blob.id ?? ''}:${t.id ?? t.track_num}`,
        title: t.title ?? 'Untitled',
        artist,
        album: blob.current?.title ?? null,
        duration: Math.round((t.duration ?? 0) * 1000),
        artwork: artUrl,
        url: t.file['mp3-128'].startsWith('//') ? `https:${t.file['mp3-128']}` : t.file['mp3-128'],
        pageUrl,
        bitrate: 128,
        streamable: true
      }))
  }

  async search(term, limit = 15) {
    const res = await fetch('https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ search_text: term, search_filter: 't', full_page: false, fan_id: null })
    })
    if (!res.ok) throw new Error(`bandcamp search ${res.status}`)
    const data = await res.json()
    const hits = (data.auto?.results ?? []).filter((r) => r.type === 't').slice(0, Math.min(limit, 8))

    // Each hit needs its page fetched to reach the mp3-128 URL; keep it small.
    const pages = await Promise.allSettled(hits.map((hit) => this.#page(hit.item_url_path ?? hit.url)))
    const tracks = []
    for (const [index, page] of pages.entries()) {
      if (page.status !== 'fulfilled') continue
      const found = this.#tracksFromPage(page.value, hits[index].item_url_path ?? hits[index].url)
      if (found.length) tracks.push(found[0])
      if (tracks.length >= limit) break
    }
    log.debug(`search "${term}" -> ${tracks.length}`)
    return tracks
  }

  async resolve(query, { limit = 30 } = {}) {
    let q = String(query).trim()
    for (const p of this.prefixes) if (q.toLowerCase().startsWith(p)) q = q.slice(p.length).trim()

    if (/^https?:\/\//i.test(q)) {
      const html = await this.#page(q)
      const tracks = this.#tracksFromPage(html, q).slice(0, limit)
      if (tracks.length === 0) throw new Error('No streamable MP3 on that Bandcamp page')
      return { type: tracks.length > 1 ? 'playlist' : 'track', name: tracks[0].album ?? tracks[0].title, tracks }
    }

    return { type: 'search', name: q, tracks: await this.search(q, limit) }
  }

  async stream(track) {
    const res = await fetch(track.url, { headers: { 'user-agent': UA, referer: track.pageUrl ?? 'https://bandcamp.com/' } })
    if (!res.ok || !res.body) throw new Error(`bandcamp stream ${res.status}`)
    return { stream: Readable.fromWeb(res.body), contentType: 'audio/mpeg', mode: 'bandcamp', bitrate: 128 }
  }
}

export default BandcampSource
