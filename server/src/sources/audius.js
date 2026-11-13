/**
 * Audius source — the decentralised music network. Free, key-free, and the
 * only large catalogue that hands out **320 kbps MP3** without an API key, so
 * it doubles as a hi-res target for the re-clone pass.
 *
 * Host discovery: `https://api.audius.co` returns the list of healthy
 * discovery nodes; we keep one and rotate off it when it misbehaves. A node
 * that answers 5xx or times out is *retired for the request*, not forever —
 * the list is re-read every 30 minutes.
 *
 * Queries: adsearch:<terms> | ausearch:<terms> | audius:<terms> |
 *          audius.co/<handle>/<slug> | audius:trending[:genre] |
 *          audius:playlist:<id>
 */
import { Readable } from 'node:stream'
import createLogger from '../util/logger.js'

const log = createLogger('src:audius')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const DISCOVERY = 'https://api.audius.co'
const FALLBACK_HOSTS = ['https://discoveryprovider.audius.co', 'https://audius-discovery-1.altego.net']

export class AudiusSource {
  name = 'audius'
  prefixes = ['adsearch:', 'ausearch:', 'audius:']
  hiRes = true

  #hosts = [...FALLBACK_HOSTS]
  #host = null
  #discoveredAt = 0
  #appName = 'livy'
  #discovery = DISCOVERY

  /**
   * @param {object} [options]
   * @param {string} [options.appName]   `app_name` sent to the discovery node
   * @param {string} [options.discovery] the list of healthy nodes, for a
   *   self-hosted Audius deployment or a mirror. Defaults to api.audius.co.
   */
  constructor({ appName, discovery } = {}) {
    if (appName) this.#appName = appName
    if (discovery) this.#discovery = discovery
  }

  canResolve(query) {
    const q = String(query).trim().toLowerCase()
    return this.prefixes.some((p) => q.startsWith(p)) || /^https?:\/\/(www\.)?audius\.co\//.test(q)
  }

  /**
   * The host list, refreshed every 30 minutes.
   *
   * Kept separate from picking one, because a *failed request* should rotate
   * to another **known** node without re-discovering — otherwise a node that
   * 5xxes would send every retry back to `api.audius.co` and turn a small
   * upstream hiccup into three round trips.
   */
  async #hostList() {
    if (this.#hosts.length && Date.now() - this.#discoveredAt < 30 * 60_000) return this.#hosts
    try {
      const res = await fetch(this.#discovery, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
      const data = await res.json()
      if (Array.isArray(data?.data) && data.data.length) this.#hosts = data.data
    } catch (error) {
      log.debug(`host discovery failed: ${error.message}`)
    }
    this.#discoveredAt = Date.now()
    return this.#hosts
  }

  /** Pick a usable discovery node, preferring a known-good one. */
  async #base({ exclude = null } = {}) {
    const hosts = await this.#hostList()
    if (this.#host && this.#host !== exclude) return this.#host

    const usable = hosts.filter((host) => host !== exclude)
    const pool = usable.length ? usable : hosts
    this.#host = pool[Math.floor(Math.random() * Math.min(pool.length, 5))]
    return this.#host
  }

  /**
   * One API call with failover: three different discovery nodes are tried
   * before the request is allowed to fail, because a single unhealthy node
   * should never take the station's quality floor with it.
   */
  async #api(path, params = {}) {
    const tried = new Set()
    let lastError
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const base = await this.#base({ exclude: [...tried].pop() ?? null })
      if (tried.has(base)) break // every known node has been tried
      tried.add(base)

      const url = new URL(`/v1${path}`, base)
      url.searchParams.set('app_name', this.#appName)
      for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, String(value))

      try {
        const res = await fetch(url, {
          headers: { 'user-agent': UA, accept: 'application/json' },
          signal: AbortSignal.timeout(12_000)
        })
        if (!res.ok) {
          lastError = new Error(`audius ${res.status} (${new URL(base).host})`)
          this.#host = null // rotate off this node
          continue
        }
        return (await res.json())?.data ?? []
      } catch (error) {
        lastError = error
        this.#host = null
      }
    }
    throw lastError ?? new Error('audius: no discovery node answered')
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
      // Audius reports seconds; everything inside Livy is milliseconds.
      duration: Math.round((raw.duration ?? 0) * 1000),
      artwork: art['1000x1000'] ?? art['480x480'] ?? art['150x150'] ?? null,
      pageUrl: raw.permalink ? `https://audius.co${raw.permalink}` : null,
      genre: raw.genre ?? null,
      // Every Audius upload is transcoded to 320 kbps MP3.
      bitrate: 320,
      streamable: raw.is_streamable !== false && raw.is_delete !== true
    }
  }

  async search(term, limit = 15) {
    const data = await this.#api('/tracks/search', { query: term, limit: Math.min(limit, 50) })
    const tracks = (Array.isArray(data) ? data : []).map((t) => this.#track(t)).filter((t) => t?.streamable)
    log.debug(`search "${term}" -> ${tracks.length}`)
    return tracks.slice(0, limit)
  }

  async trending(genre = null, limit = 30) {
    const data = await this.#api('/tracks/trending', { genre, limit: Math.min(limit, 100) })
    return (Array.isArray(data) ? data : []).map((t) => this.#track(t)).filter((t) => t?.streamable)
  }

  async #playlist(id, limit) {
    const data = await this.#api(`/playlists/${encodeURIComponent(id)}/tracks`, { limit })
    const list = Array.isArray(data) ? data : []
    const tracks = list.map((t) => this.#track(t)).filter((t) => t?.streamable)
    if (tracks.length === 0) throw new Error('That Audius playlist has no streamable tracks')
    return tracks
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
      return { type: 'playlist', name: `Audius playlist ${id}`, tracks: await this.#playlist(id, limit) }
    }

    if (/^https?:\/\//i.test(q)) {
      const data = await this.#api('/resolve', { url: q })
      const list = (Array.isArray(data) ? data : [data]).map((t) => this.#track(t)).filter((t) => t?.streamable)
      if (!list.length) throw new Error('Nothing streamable at that Audius link')
      return { type: list.length > 1 ? 'playlist' : 'track', name: list[0].title, tracks: list.slice(0, limit) }
    }

    return { type: 'search', name: q, tracks: await this.search(q, limit) }
  }

  /** The `/stream` endpoint 302s to whichever content node holds the file. */
  async getTrackUrl(track) {
    const base = await this.#base()
    const id = track.trackId ?? String(track.id).replace(/^audius:/, '')
    const url = new URL(`/v1/tracks/${encodeURIComponent(id)}/stream`, base)
    url.searchParams.set('app_name', this.#appName)
    return url.toString()
  }

  async stream(track) {
    const url = await this.getTrackUrl(track)
    const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`audius stream ${res.status}`)
    return { stream: Readable.fromWeb(res.body), contentType: 'audio/mpeg', mode: 'audius', bitrate: 320 }
  }
}

export default AudiusSource
