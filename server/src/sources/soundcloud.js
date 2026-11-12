/**
 * SoundCloud source — the station's primary music supply.
 *
 * Inspired by how Lavalink/NodeLink source managers work (resolve → track →
 * playable stream), written from scratch:
 *   • client_id is scraped from soundcloud.com's own asset bundles and cached,
 *     auto-refreshed when the API answers 401/403
 *   • resolve() understands track / playlist / set / user / search URLs
 *   • stream() prefers the `progressive` audio/mpeg transcoding (a plain MP3
 *     file we can pipe with zero transcoding); if only HLS/mpeg exists we
 *     concatenate its MP3 segments, which is still byte-identical MP3
 */
import { Readable } from 'node:stream'
import createLogger from '../util/logger.js'

const log = createLogger('src:soundcloud')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const API = 'https://api-v2.soundcloud.com'

export class SoundCloudSource {
  name = 'soundcloud'
  prefixes = ['scsearch:', 'sc:']

  #clientId = null
  #clientIdPromise = null
  #fetchedAt = 0

  constructor({ clientId } = {}) {
    if (clientId) this.#clientId = clientId
  }

  /* --------------------------- client id --------------------------- */

  async clientId(force = false) {
    if (this.#clientId && !force && Date.now() - this.#fetchedAt < 6 * 3600_000) return this.#clientId
    if (this.#clientIdPromise) return this.#clientIdPromise

    this.#clientIdPromise = (async () => {
      const html = await fetch('https://soundcloud.com/discover', { headers: { 'user-agent': UA } }).then((r) => r.text())
      const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1])

      for (const src of scripts.reverse()) {
        const js = await fetch(src, { headers: { 'user-agent': UA } }).then((r) => r.text())
        const match = /client_id[:=]"([a-zA-Z0-9]{32})"/.exec(js)
        if (match) {
          this.#clientId = match[1]
          this.#fetchedAt = Date.now()
          log.info(`client_id acquired (${match[1].slice(0, 6)}…)`)
          return this.#clientId
        }
      }
      throw new Error('Could not extract a SoundCloud client_id')
    })().finally(() => {
      this.#clientIdPromise = null
    })

    return this.#clientIdPromise
  }

  async #api(path, params = {}, retry = true) {
    const clientId = await this.clientId()
    const url = new URL(path.startsWith('http') ? path : `${API}${path}`)
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v)
    url.searchParams.set('client_id', clientId)

    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } })

    if ((res.status === 401 || res.status === 403) && retry) {
      log.warn('client_id rejected, refreshing')
      await this.clientId(true)
      return this.#api(path, params, false)
    }
    if (!res.ok) throw new Error(`SoundCloud ${res.status} for ${url.pathname}`)
    return res.json()
  }

  /* ---------------------------- matching ---------------------------- */

  canResolve(query) {
    const q = String(query).trim()
    return this.prefixes.some((p) => q.toLowerCase().startsWith(p)) || /^https?:\/\/(m\.|www\.)?soundcloud\.com\//i.test(q) || /^https?:\/\/snd\.sc\//i.test(q)
  }

  /* ---------------------------- resolving --------------------------- */

  /** @returns {Promise<{type:'track'|'playlist'|'search', name?:string, tracks:object[]}>} */
  async resolve(query, { limit = 50 } = {}) {
    const q = String(query).trim()

    for (const prefix of this.prefixes) {
      if (q.toLowerCase().startsWith(prefix)) {
        const term = q.slice(prefix.length).trim()
        return { type: 'search', name: term, tracks: await this.search(term, limit) }
      }
    }

    const data = await this.#api('/resolve', { url: q })

    if (data.kind === 'track') return { type: 'track', name: data.title, tracks: [this.#track(data)] }

    if (data.kind === 'playlist') {
      const tracks = await this.#hydrate(data.tracks ?? [], limit)
      return { type: 'playlist', name: data.title, artwork: data.artwork_url, tracks }
    }

    if (data.kind === 'user') {
      const page = await this.#api(`/users/${data.id}/tracks`, { limit, access: 'playable' })
      return { type: 'playlist', name: `${data.username} — tracks`, tracks: (page.collection ?? []).map((t) => this.#track(t)) }
    }

    throw new Error(`Unsupported SoundCloud resource: ${data.kind}`)
  }

  async search(term, limit = 20) {
    const data = await this.#api('/search/tracks', { q: term, limit, access: 'playable,preview' })
    return (data.collection ?? []).map((t) => this.#track(t)).filter((t) => t.streamable)
  }

  /** Playlist payloads contain stub tracks ({id} only) — batch-fetch the rest. */
  async #hydrate(tracks, limit) {
    const full = tracks.filter((t) => t.title).slice(0, limit)
    const stubs = tracks.filter((t) => !t.title).slice(0, Math.max(0, limit - full.length))
    const out = full.map((t) => this.#track(t))

    for (let i = 0; i < stubs.length; i += 50) {
      const ids = stubs.slice(i, i + 50).map((t) => t.id).join(',')
      const batch = await this.#api('/tracks', { ids })
      out.push(...batch.map((t) => this.#track(t)))
    }
    return out.filter((t) => t.streamable)
  }

  #track(raw) {
    const artwork = (raw.artwork_url ?? raw.user?.avatar_url ?? null)?.replace('-large.', '-t500x500.') ?? null
    const progressive = raw.media?.transcodings?.find(
      (t) => t.format?.protocol === 'progressive' && t.format?.mime_type?.includes('audio/mpeg')
    )
    const hlsMp3 = raw.media?.transcodings?.find(
      (t) => t.format?.protocol === 'hls' && t.format?.mime_type?.includes('audio/mpeg')
    )

    return {
      source: 'soundcloud',
      id: `sc:${raw.id}`,
      title: raw.title ?? 'Unknown',
      artist: raw.user?.username ?? raw.publisher_metadata?.artist ?? 'Unknown artist',
      duration: raw.duration ?? raw.full_duration ?? 0,
      artwork,
      url: raw.permalink_url,
      genre: raw.genre || null,
      playbackCount: raw.playback_count ?? 0,
      likes: raw.likes_count ?? 0,
      streamable: Boolean(progressive || hlsMp3),
      _transcodings: { progressive: progressive?.url ?? null, hls: hlsMp3?.url ?? null, trackAuth: raw.track_authorization ?? null }
    }
  }

  /* ----------------------------- streaming -------------------------- */

  /** @returns {Promise<{stream: Readable, contentType: string, mode: string}>} */
  async stream(track) {
    const t = track._transcodings ?? {}
    const clientId = await this.clientId()

    if (t.progressive) {
      const { url } = await this.#api(t.progressive, { track_authorization: t.trackAuth })
      const res = await fetch(url, { headers: { 'user-agent': UA } })
      if (!res.ok || !res.body) throw new Error(`Progressive fetch failed (${res.status})`)
      return { stream: Readable.fromWeb(res.body), contentType: 'audio/mpeg', mode: 'progressive' }
    }

    if (t.hls) {
      const { url } = await this.#api(t.hls, { track_authorization: t.trackAuth })
      return { stream: hlsMp3Stream(url, clientId), contentType: 'audio/mpeg', mode: 'hls' }
    }

    throw new Error(`Track "${track.title}" has no MP3 transcoding`)
  }
}

/** Sequentially fetch HLS MP3 segments and emit them as one continuous MP3. */
export function hlsMp3Stream(playlistUrl, clientId) {
  return Readable.from(
    (async function* () {
      const text = await fetch(playlistUrl, { headers: { 'user-agent': UA } }).then((r) => r.text())
      const segments = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => new URL(l, playlistUrl).toString())

      for (const segment of segments) {
        const res = await fetch(segment, { headers: { 'user-agent': UA } })
        if (!res.ok) throw new Error(`HLS segment ${res.status}`)
        yield Buffer.from(await res.arrayBuffer())
      }
      void clientId
    })(),
    { objectMode: false }
  )
}

export default SoundCloudSource
