/**
 * Radio Browser source — 50k+ community-indexed live radio streams, no API key.
 *
 * Used for two things:
 *   1. "radio:<name|tag>" queries, so an iMusic station can relay a real
 *      broadcaster (ICY titles become our now-playing);
 *   2. last-resort fallback: if every on-demand provider fails, a station can
 *      still stay on air with a themed live stream instead of going silent.
 */
import createLogger from '../util/logger.ts'

const log = createLogger('src:radio')
const UA = 'Livy/1 (+https://github.com/orekiServices/livy; mp3 radio)'
const MIRRORS = [
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://fi1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
  'https://all.api.radio-browser.info'
]

export class RadioBrowserSource {
  declare http: any
  declare mirror: any

  name = 'radiobrowser'
  prefixes = ['radio:', 'rbsearch:']
  live = true

  constructor({ http }: any = {}) {
    this.http = http // HttpSource, used for the actual ICY connection
    this.mirror = MIRRORS[0]
  }

  canResolve(query) {
    const q = String(query).trim().toLowerCase()
    return this.prefixes.some((p) => q.startsWith(p)) || q.includes('radio-browser.info')
  }

  async #json(path) {
    let lastError
    for (const mirror of [this.mirror, ...MIRRORS.filter((m) => m !== this.mirror)]) {
      try {
        const res = await fetch(`${mirror}${path}`, {
          headers: { 'user-agent': UA, accept: 'application/json' },
          signal: AbortSignal.timeout(10_000)
        })
        if (!res.ok) throw new Error(`radio-browser ${res.status}`)
        this.mirror = mirror
        return res.json()
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('radio-browser unreachable')
  }

  #track(station) {
    return {
      source: 'radiobrowser',
      id: `rb:${station.stationuuid}`,
      title: station.name?.trim() || 'Live radio',
      artist: [station.country, station.tags?.split(',')[0]].filter(Boolean).join(' · ') || 'Live radio',
      duration: 0,
      live: true,
      artwork: station.favicon || null,
      url: station.url_resolved || station.url,
      bitrate: Number(station.bitrate) || 128,
      codec: station.codec,
      homepage: station.homepage,
      streamable: /mp3/i.test(station.codec ?? '')
    }
  }

  /**
   * @param {string} term
   * @param {number} limit
   * @param {object} [opts] `minBitrate` enforces the hi-res preference
   */
  async search(term, limit = 10, { minBitrate = 0 }: any = {}) {
    const params = new URLSearchParams({
      limit: String(limit * 3),
      codec: 'MP3',
      hidebroken: 'true',
      order: 'clickcount',
      reverse: 'true'
    })

    let stations = []
    const wanted = String(term ?? '').trim()
    if (wanted) {
      // Name matches first; if that finds nothing, treat the term as a tag,
      // then as a country. A single "jazz" should find stations whichever of
      // the three the community filed it under.
      params.set('name', wanted)
      stations = await this.#json(`/json/stations/search?${params}`)
      if (stations.length === 0) {
        params.delete('name')
        stations = await this.#json(`/json/stations/bytagexact/${encodeURIComponent(wanted)}?${params}`)
      }
      if (stations.length === 0) {
        // Last attempt: a free-text search, which the directory ranks itself.
        params.set('tag', wanted)
        stations = await this.#json(`/json/stations/search?${params}`)
      }
    } else {
      stations = await this.#json(`/json/stations/search?${params}`)
    }

    const tracks = stations
      .map((s) => this.#track(s))
      .filter((t) => t.streamable && t.url && t.bitrate >= minBitrate)
      .sort((a, b) => b.bitrate - a.bitrate)
      .slice(0, limit)

    log.debug(`search "${term}" -> ${tracks.length} live streams`)
    return tracks
  }

  async resolve(query, { limit = 10 }: any = {}) {
    let q = String(query).trim()
    for (const p of this.prefixes) if (q.toLowerCase().startsWith(p)) q = q.slice(p.length).trim()
    return { type: 'search', name: q, tracks: await this.search(q, limit) }
  }

  async stream(track, options) {
    // A Radio Browser entry is just an Icecast URL: reuse the HTTP/ICY source.
    return this.http.stream(track, options)
  }

  /**
   * Live relays are not directly playable by a browser, but a station's
   * `.pls`/`.m3u` URL is — and it is the URL the directory itself hands out.
   */
  getTrackUrl(track) {
    return /\.(pls|m3u)(\?|$)/i.test(track.url ?? '') ? track.url : null
  }
}

export default RadioBrowserSource
