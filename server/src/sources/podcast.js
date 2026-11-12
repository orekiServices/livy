/**
 * Podcast / RSS source — any feed with MP3 enclosures becomes a playlist, and
 * the iTunes Search API (key-free) turns words into feeds.
 *
 * Queries: pcsearch:<terms> | podcast:<terms|feed url> | any .rss/.xml URL
 *
 * Episodes are ordinary long-form MP3s, so they crossfade, duck under the DJ
 * and carry ICY metadata exactly like music does.
 */
import createLogger from '../util/logger.js'

const log = createLogger('src:podcast')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const strip = (value) =>
  String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()

const tag = (xml, name) => {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml)
  return match ? strip(match[1]) : null
}

/** "01:02:03" or "3600" → milliseconds. */
function durationMs(value) {
  if (!value) return 0
  const parts = String(value).trim().split(':').map(Number)
  if (parts.some(Number.isNaN)) return 0
  const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0]
  return Math.round(seconds * 1000)
}

export class PodcastSource {
  name = 'podcast'
  prefixes = ['pcsearch:', 'podcast:', 'rss:']

  constructor({ http = null } = {}) {
    this.http = http
  }

  canResolve(query) {
    const q = String(query).trim().toLowerCase()
    if (this.prefixes.some((p) => q.startsWith(p))) return true
    return /^https?:\/\/\S+\.(rss|xml)(\?|$)/.test(q) || /^https?:\/\/\S*(feeds?|podcast)\S*\//.test(q)
  }

  /** iTunes Search: words → podcast feeds, no key required. */
  async #feedsFor(term, limit = 5) {
    const url = new URL('https://itunes.apple.com/search')
    url.searchParams.set('term', term)
    url.searchParams.set('entity', 'podcast')
    url.searchParams.set('limit', String(Math.min(limit, 20)))
    const res = await fetch(url, { headers: { 'user-agent': UA } })
    if (!res.ok) throw new Error(`podcast search ${res.status}`)
    const data = await res.json()
    return (data.results ?? [])
      .filter((r) => r.feedUrl)
      .map((r) => ({ feedUrl: r.feedUrl, name: r.collectionName, artist: r.artistName, artwork: r.artworkUrl600 ?? r.artworkUrl100 ?? null }))
  }

  async #episodes(feedUrl, limit = 30, meta = {}) {
    const res = await fetch(feedUrl, { headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml' } })
    if (!res.ok) throw new Error(`feed ${res.status}`)
    const xml = await res.text()

    const channelHead = xml.split(/<item[\s>]/i)[0]
    const show = meta.name ?? tag(channelHead, 'title') ?? 'Podcast'
    const showArt = meta.artwork ?? /<itunes:image[^>]*href="([^"]+)"/i.exec(channelHead)?.[1] ?? null

    const tracks = []
    for (const chunk of xml.split(/<item[\s>]/i).slice(1)) {
      const enclosure = /<enclosure[^>]*>/i.exec(chunk)?.[0]
      if (!enclosure) continue
      const url = /url="([^"]+)"/i.exec(enclosure)?.[1]
      const type = /type="([^"]+)"/i.exec(enclosure)?.[1] ?? ''
      if (!url || !(type.includes('mpeg') || /\.mp3(\?|$)/i.test(url))) continue

      tracks.push({
        source: 'podcast',
        id: `podcast:${tag(chunk, 'guid') ?? url}`,
        title: tag(chunk, 'title') ?? 'Episode',
        artist: meta.artist ?? show,
        album: show,
        description: (tag(chunk, 'description') ?? '').slice(0, 300) || null,
        duration: durationMs(tag(chunk, 'itunes:duration')),
        publishedAt: tag(chunk, 'pubDate'),
        artwork: /<itunes:image[^>]*href="([^"]+)"/i.exec(chunk)?.[1] ?? showArt,
        url,
        pageUrl: tag(chunk, 'link') ?? feedUrl,
        bitrate: 128,
        streamable: true
      })
      if (tracks.length >= limit) break
    }
    if (!tracks.length) throw new Error('No MP3 enclosures in that feed')
    return { show, tracks }
  }

  async search(term, limit = 10) {
    const feeds = await this.#feedsFor(term, 3)
    const out = []
    for (const feed of feeds) {
      try {
        const { tracks } = await this.#episodes(feed.feedUrl, Math.ceil(limit / feeds.length) + 1, feed)
        out.push(...tracks)
      } catch (error) {
        log.debug(`${feed.feedUrl}: ${error.message}`)
      }
      if (out.length >= limit) break
    }
    return out.slice(0, limit)
  }

  async resolve(query, { limit = 30 } = {}) {
    let q = String(query).trim()
    for (const p of this.prefixes) if (q.toLowerCase().startsWith(p)) q = q.slice(p.length).trim()

    if (/^https?:\/\//i.test(q)) {
      const { show, tracks } = await this.#episodes(q, limit)
      return { type: 'playlist', name: show, tracks }
    }

    const [feed] = await this.#feedsFor(q, 1)
    if (!feed) throw new Error(`No podcast found for "${q}"`)
    const { show, tracks } = await this.#episodes(feed.feedUrl, limit, feed)
    log.debug(`"${q}" -> ${show} (${tracks.length} episodes)`)
    return { type: 'playlist', name: show, tracks }
  }

  async stream(track, options = {}) {
    if (!this.http) throw new Error('podcast needs the http source to stream')
    return this.http.stream({ ...track, source: 'http' }, options)
  }
}

export default PodcastSource
