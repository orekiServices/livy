/**
 * Mirror source — paste a link from a platform Livy cannot legally or
 * practically stream (Spotify, Apple Music, YouTube, Mixcloud, Tidal…), and it
 * reads only the *public metadata* of that link, then finds the same recording
 * on a provider that does serve audio (SoundCloud, Audius, Bandcamp, archive…).
 *
 * Nothing is extracted or downloaded from the originating platform: the link
 * is used as a search query, which is all a DJ typing the title would do.
 *
 * Queries: any open.spotify.com / music.apple.com / youtube.com / youtu.be /
 *          mixcloud.com / tidal.com link, or mirror:<artist> <title>
 */
import createLogger from '../util/logger.ts'
import { splitTitle } from './ytmusic.ts'

const log = createLogger('src:mirror')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const PLATFORMS = [
  { name: 'spotify', test: /open\.spotify\.com\/(?:intl-[a-z-]+|embed)\/track\//i },
  { name: 'spotify', test: /(?:open\.spotify\.com\/|spotify\.(?:app\.)?link\/|^spotify:(?:track|album|playlist):)/i },
  { name: 'apple', test: /music\.apple\.com\//i },
  { name: 'youtube', test: /(youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts\/)/i },
  { name: 'mixcloud', test: /mixcloud\.com\/[^/]+\/[^/]+/i },
  { name: 'tidal', test: /(?:listen\.)?tidal\.com\//i }
]

const clean = (value) =>
  String(value ?? '')
    .replace(/\((official|lyric|audio|visuali[sz]er|music)?\s*video\)/gi, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s*[-–—]\s*topic$/i, '')
    .replace(/\s+/g, ' ')
    .trim()

export class MirrorSource {
  declare searchAll: any
  declare similarity: any

  name = 'mirror'
  prefixes = ['mirror:']
  /** The registry never tries to stream a mirror track: resolve returns real ones. */
  metadataOnly = true

  /**
   * @param {object} deps
   * @param {(query: string, limit: number) => Promise<object[]>} deps.search  registry search
   * @param {(a: object, b: object) => number} deps.similarity
   */
  constructor({ search, similarity }: any = {}) {
    this.searchAll = search
    this.similarity = similarity ?? (() => 0)
  }

  canResolve(query) {
    const q = String(query).trim()
    if (this.prefixes.some((p) => q.toLowerCase().startsWith(p))) return true
    return PLATFORMS.some((p) => p.test.test(q))
  }

  platformOf(url) {
    return PLATFORMS.find((p) => p.test.test(url))?.name ?? null
  }

  /* --------------------------- metadata readers -------------------------- */

  async #spotify(url) {
    let target = url
    const uriMatch = /^spotify:(track|album|playlist):([A-Za-z0-9]+)/i.exec(target)
    if (uriMatch) target = `https://open.spotify.com/${uriMatch[1].toLowerCase()}/${uriMatch[2]}`
    else if (/spotify\.(?:app\.)?link\//i.test(target)) {
      try {
        const expanded = await fetch(target, { headers: { 'user-agent': UA }, redirect: 'follow' })
        if (expanded.url) target = expanded.url
      } catch {
        /* keep original */
      }
    }
    const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(target)}`, { headers: { 'user-agent': UA } })
    if (!res.ok) throw new Error(`spotify ${res.status}`)
    const data = await res.json()
    let artist = null
    try {
      // The embed page carries the artist list; the oEmbed payload does not.
      const embed = await fetch(data.iframe_url ?? target, { headers: { 'user-agent': UA } })
      const html = await embed.text()
      artist =
        /"artists":\[\{"name":"([^"]+)"/.exec(html)?.[1] ??
        /<meta property="og:description" content="([^"·]+)/.exec(html)?.[1]?.trim() ??
        null
    } catch {
      /* metadata is best effort */
    }
    return { title: clean(data.title), artist, artwork: data.thumbnail_url ?? null, platform: 'Spotify' }
  }

  async #apple(url) {
    const id = /[?&]i=(\d+)/.exec(url)?.[1] ?? /\/(?:album|song)\/[^/]*\/(\d+)/.exec(url)?.[1]
    if (!id) throw new Error('no Apple Music id in that link')
    const res = await fetch(`https://itunes.apple.com/lookup?id=${id}`, { headers: { 'user-agent': UA } })
    if (!res.ok) throw new Error(`apple ${res.status}`)
    const [item] = (await res.json()).results ?? []
    if (!item) throw new Error('Apple Music did not know that id')
    return {
      title: clean(item.trackName ?? item.collectionName),
      artist: item.artistName ?? null,
      duration: item.trackTimeMillis ?? 0,
      artwork: item.artworkUrl100?.replace('100x100', '600x600') ?? null,
      platform: 'Apple Music'
    }
  }

  async #youtube(url) {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, { headers: { 'user-agent': UA } })
    if (!res.ok) throw new Error(`youtube ${res.status}`)
    const data = await res.json()
    // "Artist - Title" is the usual shape of a music upload; when it is not,
    // the channel name is the best guess at an artist.
    const [title, artist] = splitTitle(data.title)
    return { title, artist: artist ?? clean(data.author_name), artwork: data.thumbnail_url ?? null, platform: 'YouTube' }
  }

  async #mixcloud(url) {
    const path = new URL(url).pathname
    const res = await fetch(`https://api.mixcloud.com${path}`, { headers: { 'user-agent': UA } })
    if (!res.ok) throw new Error(`mixcloud ${res.status}`)
    const data = await res.json()
    return {
      title: clean(data.name),
      artist: data.user?.name ?? null,
      duration: (data.audio_length ?? 0) * 1000,
      artwork: data.pictures?.large ?? null,
      platform: 'Mixcloud'
    }
  }

  async #tidal(url) {
    // Tidal oEmbed answers cleanly for track/album/playlist links even when
    // the web page is a JS shell; fall back to Open Graph tags if needed.
    try {
      const oembed = await fetch(`https://oembed.tidal.com/oembed?url=${encodeURIComponent(url)}`, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000)
      })
      if (oembed.ok) {
        const data = await oembed.json()
        if (data?.title) {
          const [title, artist] = String(data.title).split(/\s+by\s+/i)
          return {
            title: clean(title),
            artist: artist ? clean(artist) : (data.author_name ? clean(data.author_name) : null),
            artwork: data.thumbnail_url ?? null,
            platform: 'TIDAL'
          }
        }
      }
    } catch {
      /* fall through to HTML OG scrape */
    }
    const res = await fetch(url, { headers: { 'user-agent': UA } })
    if (!res.ok) throw new Error(`tidal ${res.status}`)
    const html = await res.text()
    const og = /<meta property="og:title" content="([^"]+)"/.exec(html)?.[1] ?? ''
    const [title, artist] = og.split(/\s+by\s+/i)
    if (!title) throw new Error('tidal page carried no title')
    return { title: clean(title), artist: artist ? clean(artist) : null, platform: 'TIDAL' }
  }

  async metadata(url) {
    switch (this.platformOf(url)) {
      case 'spotify':
        return this.#spotify(url)
      case 'apple':
        return this.#apple(url)
      case 'youtube':
        return this.#youtube(url)
      case 'mixcloud':
        return this.#mixcloud(url)
      case 'tidal':
        return this.#tidal(url)
      default:
        throw new Error('Not a link Livy can mirror')
    }
  }

  /* ------------------------------- resolving ----------------------------- */

  async resolve(query, { limit = 5 }: any = {}) {
    let q = String(query).trim()
    for (const p of this.prefixes) if (q.toLowerCase().startsWith(p)) q = q.slice(p.length).trim()

    const meta = /^https?:\/\/|^spotify:/i.test(q) ? await this.metadata(q) : { title: q, artist: null, platform: 'search' }
    const term = [meta.artist, meta.title].filter(Boolean).join(' ').slice(0, 120)
    if (!term) throw new Error('That link carried no usable title')

    const candidates = await this.searchAll(term, 12)
    const scored = candidates
      .map((candidate) => ({ candidate, score: this.similarity(meta, candidate) }))
      .filter(({ score }) => score >= 0.34)
      .sort((a, b) => b.score - a.score || (b.candidate.bitrate ?? 128) - (a.candidate.bitrate ?? 128))

    if (!scored.length) throw new Error(`Nothing playable matches "${term}"`)

    const tracks = scored.slice(0, limit).map(({ candidate, score }) => ({
      ...candidate,
      artwork: candidate.artwork ?? meta.artwork ?? null,
      mirroredFrom: meta.platform,
      link: /^https?:/i.test(q) ? q : candidate.link ?? null,
      matchScore: Number(score.toFixed(3))
    }))

    log.info(`${meta.platform}: "${term}" → ${tracks[0].source} "${tracks[0].title}" (${tracks[0].matchScore})`)
    return { type: 'track', name: tracks[0].title, mirroredFrom: meta.platform, tracks }
  }

  async search(term, limit = 5) {
    const { tracks } = await this.resolve(`mirror:${term}`, { limit })
    return tracks
  }
}

export default MirrorSource
