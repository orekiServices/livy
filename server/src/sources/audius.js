/**
 * Audius source — the decentralised music network. Free, key-free, and the
 * only large catalogue that hands out **320 kbps MP3** without an API key, so
 * it doubles as a hi-res target for the re-clone pass.
 *
 * Host discovery: `https://api.audius.co` returns the list of healthy
 * discovery nodes; we keep one and rotate off it when it misbehaves.
 *
 * Queries: adsearch:<terms> | audius:<terms> | audius.co/<handle>/<slug> |
 *          audius:trending[:genre] | audius:playlist:<id>
 */
import { Readable } from 'node:stream'
import createLogger from '../util/logger.js'

const log = createLogger('src:audius')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const APP = 'nodecast'

export class AudiusSource {
  name = 'audius'
  prefixes = ['adsearch:', 'audius:']
  hiRes = true

  #hosts = ['https://discoveryprovider.audius.co', 'https://audius-discovery-1.altego.net']
  #host = null
  #discoveredAt = 0

  canResolve(query) {
    const q = String(query).trim().toLowerCase()
    return this.prefixes.some((p) => q.startsWith(p)) || /^https?:\/\/(www\.)?audius\.co\//.test(q)
  }

  /** Pick a discovery node, refreshing the list every 30 minutes. */
  async #base() {
    if (this.#host && Date.now() - this.#discoveredAt < 30 * 60_000) return this.#host
    try {
      const res = await fetch('https://api.audius.co', { headers: { 'user-agent': UA } })
      const data = await res.json()
      if (Array.isArray(data?.data) && data.data.length) this.#hosts = data.data
    } catch (error) {
      log.debug(`host discovery failed: ${error.message}`)
    }
    this.#host = this.#hosts[Math.floor(Math.random() * Math.min(this.#hosts.length, 5))]
    this.#discoveredAt = Date.now()
    return this.#host
  }

  async #api(path, params = {}) {
    const base = await this.#base()
    const url = new URL(`/v1${path}`, base)
    url.searchParams.set('app_name', APP)
    for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, String(value))
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } })
    if (!res.ok) {
      this.#host = null // try a different node next time
      throw new Error(`audius ${res.status}`)
    }
    return (await res.json())?.data ?? []
  }

  #track(raw) {
    if (!raw?.id) return null
    const art = raw.artwork ?? {}
    return {
      source: 'audius',
      id: `audius:${raw.id}`,
      trackId: raw.id,
      title: raw.title ?? 'Untitled',
      artist: raw.user?.name ?? raw.user?.handle ?? 'Audius artist',
      album: null,
      // Audius reports seconds; everything inside Nodecast is milliseconds.
      duration: Math.round((raw.duration ?? 0) * 1000),
      artwork: art['480x480'] ?? art['1000x1000'] ?? art['150x150'] ?? null,
      pageUrl: raw.permalink ? `https://audius.co${raw.permalink}` : null,
      genre: raw.genre ?? null,
      // Every Audius upload is transcoded to 320 kbps MP3.
      bitrate: 320,
      streamable: raw.is_streamable !== false && raw.is_delete !== true
    }
  }

  async search(term, limit = 15) {
    const data = await this.#api('/tracks/search', { query: term, limit: Math.min(limit, 50) })
    const tracks = data.map((t) => this.#track(t)).filter((t) => t?.streamable)
    log.debug(`search "${term}" -> ${tracks.length}`)
    return tracks.slice(0, limit)
  }

  async trending(genre = null, limit = 30) {
    const data = await this.#api('/tracks/trending', { genre, limit: Math.min(limit, 100) })
    return data.map((t) => this.#track(t)).filter((t) => t?.streamable)
  }

  async resolve(query, { limit = 30 } = {}) {
    let q = String(query).trim()
    for (const p of this.prefixes) if (q.toLowerCase().startsWith(p)) q = q.slice(p.length).trim()

    if (/^trending/i.test(q)) {
      const genre = q.split(':')[1]?.trim() || null
      const tracks = await this.trending(genre, limit)
      return { type: 'playlist', name: genre ? `Audius trending · ${genre}` : 'Audius trending', tracks }
    }

    if (/^playlist:/i.test(q)) {
      const id = q.slice('playlist:'.length).trim()
      const data = await this.#api(`/playlists/${encodeURIComponent(id)}/tracks`)
      const tracks = data.map((t) => this.#track(t)).filter((t) => t?.streamable)
      return { type: 'playlist', name: `Audius playlist ${id}`, tracks }
    }

    if (/^https?:\/\//i.test(q)) {
      const data = await this.#api('/resolve', { url: q })
      const list = (Array.isArray(data) ? data : [data]).map((t) => this.#track(t)).filter((t) => t?.streamable)
      if (!list.length) throw new Error('Nothing streamable at that Audius link')
      return { type: list.length > 1 ? 'playlist' : 'track', name: list[0].title, tracks: list.slice(0, limit) }
    }

    return { type: 'search', name: q, tracks: await this.search(q, limit) }
  }

  async stream(track) {
    const base = await this.#base()
    const id = track.trackId ?? String(track.id).replace(/^audius:/, '')
    const url = new URL(`/v1/tracks/${encodeURIComponent(id)}/stream`, base)
    url.searchParams.set('app_name', APP)

    // The stream endpoint 302s to whichever content node holds the file.
    const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`audius stream ${res.status}`)
    return { stream: Readable.fromWeb(res.body), contentType: 'audio/mpeg', mode: 'audius', bitrate: 320 }
  }
}

export default AudiusSource
