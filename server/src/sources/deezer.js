/**
 * Deezer — metadata-only source.
 *
 * Deezer's public API is key-free but only hands out 30 second previews, which
 * is useless for a radio rotation. So this source resolves *metadata* (exact
 * artist / title / duration / artwork / **ISRC**) and marks the track
 * `metadataOnly`; the registry then clones it to a provider that can actually
 * stream the full recording. Same trick NodeLink uses for Spotify links,
 * implemented here from scratch on top of our existing clone/fallback
 * machinery.
 *
 * The ISRC is the interesting part: it identifies the *recording*, not the
 * release, so the clone pass can treat an ISRC match as certain rather than
 * guessing from titles (see `SourceRegistry.alternatives`).
 *
 * When the console wants to audition a result it can use `preview` — the 30
 * second MP3 Deezer serves — via the track-url endpoint.
 *
 * Queries: dzsearch:<terms> | deezer:<terms> |
 *          https://www.deezer.com/track|album|playlist|artist/<id> |
 *          dzisrc:<ISRC>
 */
import createLogger from '../util/logger.js'

const log = createLogger('src:deezer')
const API = 'https://api.deezer.com/2.0'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export class DeezerSource {
  name = 'deezer'
  prefixes = ['dzsearch:', 'deezer:', 'dzisrc:']
  metadataOnly = true

  canResolve(query) {
    const q = String(query).trim().toLowerCase()
    return this.prefixes.some((p) => q.startsWith(p)) || /^https?:\/\/(www\.)?deezer\.com\//.test(q)
  }

  async #json(path) {
    const res = await fetch(`${API}${path}`, {
      headers: { accept: 'application/json', 'user-agent': UA },
      signal: AbortSignal.timeout(12_000)
    })
    if (!res.ok) throw new Error(`deezer ${res.status}`)
    const data = await res.json()
    if (data?.error) throw new Error(`deezer: ${data.error.message ?? data.error.type ?? 'request failed'}`)
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
      artwork: raw.album?.cover_xl ?? raw.album?.cover_big ?? raw.album?.cover_medium ?? null,
      url: raw.link,
      isrc: raw.isrc ?? null,
      bitrate: 320, // what a *cloned* copy of this recording should aim for
      // The 30-second preview is the only audio Deezer itself will serve.
      preview: raw.preview ?? null,
      // no full-length audio here — the registry will clone it elsewhere
      metadataOnly: true,
      streamable: true
    }
  }

  async search(term, limit = 20) {
    const data = await this.#json(`/search?q=${encodeURIComponent(term)}&limit=${Math.min(limit, 50)}`)
    return (data.data ?? []).map((t) => this.#track(t))
  }

  /** Exact recording lookup by ISRC — used when only the ISRC is known. */
  async byIsrc(isrc) {
    const data = await this.#json(`/track/isrc:${encodeURIComponent(isrc)}`)
    if (!data?.id) return null
    return this.#track(data)
  }

  async resolve(query, { limit = 50 } = {}) {
    let q = String(query).trim()
    for (const p of this.prefixes) if (q.toLowerCase().startsWith(p)) q = q.slice(p.length).trim()

    if (/^dzisrc:/i.test(String(query).trim())) {
      const track = await this.byIsrc(q)
      if (!track) throw new Error(`Deezer does not know ISRC ${q}`)
      return { type: 'track', name: track.title, tracks: [track] }
    }

    const link = /deezer\.com\/(?:[a-z]{2}\/)?(track|album|playlist|artist)\/(\d+)/i.exec(q)
    if (link) {
      const [, kind, id] = link
      if (kind === 'track') {
        const data = await this.#json(`/track/${id}`)
        return { type: 'track', name: data.title, tracks: [this.#track(data)] }
      }
      if (kind === 'artist') {
        const data = await this.#json(`/artist/${id}/top?limit=${Math.min(limit, 100)}`)
        const tracks = (data.data ?? []).map((t) => this.#track(t))
        if (!tracks.length) throw new Error('That Deezer artist has no top tracks')
        return { type: 'playlist', name: `${data.data?.[0]?.artist?.name ?? 'Deezer artist'} — top tracks`, tracks }
      }
      const data = await this.#json(`/${kind}/${id}`)
      const tracks = (data.tracks?.data ?? []).slice(0, limit).map((t) => this.#track({ ...t, album: t.album ?? data }))
      if (!tracks.length) throw new Error(`That Deezer ${kind} has no tracks`)
      return { type: 'playlist', name: data.title, artwork: data.cover_xl ?? data.picture_xl ?? null, tracks }
    }

    return { type: 'search', name: q, tracks: await this.search(q, limit) }
  }

  /** Deezer never streams here — this failure is what triggers the clone path. */
  async stream(track) {
    log.debug(`metadata-only track "${track.title}" — handing over to the clone/fallback chain`)
    throw Object.assign(new Error('Deezer is a metadata-only source; cloning to a playable provider'), { metadataOnly: true })
  }

  /** …but its 30 second preview is a valid thing to audition in a browser. */
  getTrackUrl(track) {
    return track.preview ?? null
  }
}

export default DeezerSource
