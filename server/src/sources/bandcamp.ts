/**
 * Bandcamp source. Full-length `mp3-128` streams are embedded in every track
 * and album page inside the `data-tralbum` blob, so no API key is involved.
 *
 * Two lessons from NodeLink's Bandcamp resolver are baked in here:
 *
 *   • `bandcamp.com/search` now serves a JavaScript challenge, so search goes
 *     through the autocomplete API the site's own front end uses
 *     (`bcsearch_public_api/1/autocomplete_elastic`) and asks for
 *     `full_page: true`, which returns the `item_url_path` we can resolve.
 *   • Search hits already carry the artwork, artist and URL, so they are
 *     turned into tracks directly; the page is only fetched when we actually
 *     need the stream — one request per track played, not per track found.
 *
 * Queries: bcsearch:<terms> | bandcamp:<terms> |
 *          https://<artist>.bandcamp.com/track|album/<slug>
 */
import createLogger from '../util/logger.ts'
import { fetchWithConnectTimeout, responseToNodeStream } from '../util/fetchStream.ts'

const log = createLogger('src:bandcamp')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const SEARCH_API = 'https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic'

/** Bandcamp serves artwork from a size-named subdomain. */
const artworkUrl = (artId) => (artId ? `https://f4.bcbits.com/img/a${artId}_10.jpg` : null)

function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
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
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`bandcamp ${res.status}`)
    return res.text()
  }

  /** `data-tralbum` → tracks with direct mp3-128 URLs. */
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
    // JSON-LD carries the ISRC and, on single-track pages, a real duration.
    const isrc = /"isrcCode"\s*:\s*"([^"]+)"/.exec(html)?.[1] ?? blob.current?.isrc ?? null

    return (blob.trackinfo ?? [])
      .map((t, index) => {
        const file = t.file?.['mp3-128']
        if (!file) return null
        return {
          source: 'bandcamp',
          id: `bc:${blob.id ?? ''}:${t.id ?? t.track_num ?? index}`,
          title: t.title ?? 'Untitled',
          artist,
          album: blob.current?.title ?? null,
          duration: Math.round((t.duration ?? 0) * 1000),
          artwork: artUrl ?? artworkUrl(blob.art_id),
          url: file.startsWith('//') ? `https:${file}` : file,
          pageUrl,
          isrc,
          bitrate: 128,
          streamable: true
        }
      })
      .filter(Boolean)
  }

  /**
   * The autocomplete API returns hits *with* their `item_url_path` and art, so
   * a search costs one request. `full_page: true` is what makes the URL
   * absolute enough to resolve.
   */
  async search(term, limit = 15) {
    const res = await fetch(SEARCH_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ search_text: term, search_filter: 't', full_page: true, fan_id: null }),
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) throw new Error(`bandcamp search ${res.status}`)
    const data = await res.json()
    const hits = (data.auto?.results ?? []).filter((r) => r.type === 't' && r.item_url_path)

    const tracks = hits.slice(0, limit).map((hit) => ({
      source: 'bandcamp',
      id: `bc:search:${hit.id ?? hit.item_url_path}`,
      title: hit.name ?? 'Untitled',
      artist: hit.band_name ?? 'Bandcamp artist',
      album: null,
      duration: Number(hit.length ?? 0) * 1000,
      artwork: hit.art_id ? artworkUrl(hit.art_id) : (hit.img ?? null),
      pageUrl: hit.item_url_path,
      url: null, // resolved from the page on first play (see stream())
      bitrate: 128,
      streamable: true
    }))

    log.debug(`search "${term}" -> ${tracks.length}`)
    return tracks
  }

  async resolve(query, { limit = 30 }: any = {}) {
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

  /**
   * Search hits have no MP3 URL yet; the page is fetched here, once per play.
   * A hit whose page no longer carries the matching track is an error, so the
   * registry's fallback chain gets a chance.
   */
  async stream(track, { signal }: any = {}) {
    let url = track.url
    if (!url) {
      const pageUrl = track.pageUrl ?? track.link
      if (!pageUrl) throw new Error('bandcamp: missing track url')
      const html = await this.#page(pageUrl)
      const found = this.#tracksFromPage(html, pageUrl)
      if (found.length === 0) throw new Error(`no mp3-128 on ${pageUrl}`)
      const match =
        found.find((t) => t.title.toLowerCase() === String(track.title).toLowerCase()) ?? found[0]
      url = match.url
      // Keep it for the next play of the same search hit.
      track.url = url
    }

    const res = await fetchWithConnectTimeout(url, {
      headers: { 'user-agent': UA, referer: track.pageUrl ?? track.link ?? 'https://bandcamp.com/' },
      connectTimeoutMs: 20_000,
      signal
    })
    if (!res.ok || !res.body) throw new Error(`bandcamp stream ${res.status}`)
    return {
      stream: responseToNodeStream(res, { signal }),
      contentType: res.headers.get('content-type') || 'audio/mpeg',
      mode: 'bandcamp',
      bitrate: 128
    }
  }

  async getTrackUrl(track) {
    if (track.url) return track.url
    const html = await this.#page(track.pageUrl)
    const found = this.#tracksFromPage(html, track.pageUrl)
    const match = found.find((t) => t.title.toLowerCase() === String(track.title).toLowerCase()) ?? found[0]
    if (match?.url) track.url = match.url
    return match?.url ?? null
  }
}

export default BandcampSource
