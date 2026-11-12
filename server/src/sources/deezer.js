/**
 * Deezer — metadata-only source.
 *
 * Deezer's public API is key-free but only hands out 30 second previews, which
 * is useless for a radio rotation. So this source resolves *metadata* (exact
 * artist / title / duration / artwork) and marks the track `metadataOnly`;
 * the registry then clones it to a provider that can actually stream the full
 * recording. Same trick NodeLink uses for Spotify links, implemented here from
 * scratch on top of our existing clone/fallback machinery.
 *
 * Queries: dzsearch:<terms> | https://www.deezer.com/track|album|playlist/<id>
 */
import createLogger from '../util/logger.js'

const log = createLogger('src:deezer')
const API = 'https://api.deezer.com'

export class DeezerSource {
  name = 'deezer'
  prefixes = ['dzsearch:', 'deezer:']
  metadataOnly = true

  canResolve(query) {
    const q = String(query).trim().toLowerCase()
    return this.prefixes.some((p) => q.startsWith(p)) || /^https?:\/\/(www\.)?deezer\.com\//.test(q)
  }

  async #json(path) {
    const res = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`deezer ${res.status}`)
    const data = await res.json()
    if (data.error) throw new Error(`deezer: ${data.error.message ?? data.error.type}`)
    return data
  }

  #track(raw) {
    return {
      source: 'deezer',
      id: `dz:${raw.id}`,
      title: raw.title_short ?? raw.title,
      artist: raw.artist?.name ?? 'Unknown artist',
      album: raw.album?.title ?? null,
      duration: (raw.duration ?? 0) * 1000,
      artwork: raw.album?.cover_xl ?? raw.album?.cover_big ?? null,
      url: raw.link,
      isrc: raw.isrc ?? null,
      // no playable audio here — the registry will clone it elsewhere
      metadataOnly: true,
      streamable: true
    }
  }

  async search(term, limit = 20) {
    const data = await this.#json(`/search?q=${encodeURIComponent(term)}&limit=${limit}`)
    return (data.data ?? []).map((t) => this.#track(t))
  }

  async resolve(query, { limit = 50 } = {}) {
    let q = String(query).trim()
    for (const p of this.prefixes) if (q.toLowerCase().startsWith(p)) q = q.slice(p.length).trim()

    const link = /deezer\.com\/(?:[a-z]{2}\/)?(track|album|playlist)\/(\d+)/i.exec(q)
    if (link) {
      const [, kind, id] = link
      if (kind === 'track') {
        const data = await this.#json(`/track/${id}`)
        return { type: 'track', name: data.title, tracks: [this.#track(data)] }
      }
      const data = await this.#json(`/${kind}/${id}`)
      const tracks = (data.tracks?.data ?? []).slice(0, limit).map((t) => this.#track({ ...t, album: data.album ?? data }))
      return { type: 'playlist', name: data.title, artwork: data.cover_xl ?? data.picture_xl ?? null, tracks }
    }

    return { type: 'search', name: q, tracks: await this.search(q, limit) }
  }

  /** Deezer never streams here — this failure is what triggers the clone path. */
  async stream(track) {
    log.debug(`metadata-only track "${track.title}" — handing over to the clone/fallback chain`)
    throw Object.assign(new Error('Deezer is a metadata-only source; cloning to a playable provider'), { metadataOnly: true })
  }
}

export default DeezerSource
