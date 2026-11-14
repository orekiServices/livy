/**
 * SoundCloud source — the station's primary music supply.
 *
 * Inspired by how Lavalink/NodeLink source managers work (resolve → track →
 * playable stream), written from scratch:
 *
 *   • client_id is scraped from soundcloud.com's own asset bundles and cached,
 *     auto-refreshed when the API answers 401/403. A user-supplied key is
 *     honoured (and still refreshed if it expires).
 *   • resolve() understands track / playlist / set / user / search URLs, plus
 *     the private `snd.sc` short links those pages share.
 *   • stream() prefers the `progressive` MP3 transcoding — a plain file we can
 *     pipe with zero transcoding. When the uploader disabled downloads only
 *     HLS exists, and its MP3 segments are concatenated segment by segment
 *     (still byte-identical MP3). Encrypted-HLS-only tracks are reported as
 *     such instead of failing obscurely.
 *   • DRM/geo-blocked/30-second-preview uploads are marked at resolve time,
 *     so the rotation never queues something it cannot air.
 *
 * What this deliberately does not do is sign a player token to unlock the
 * encrypted HLS renditions: that is runtime plagiarism, not playback.
 */
import { Readable } from 'node:stream'
import createLogger from '../util/logger.ts'
import { fetchWithConnectTimeout, responseToNodeStream } from '../util/fetchStream.ts'

const log = createLogger('src:soundcloud')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const API = 'https://api-v2.soundcloud.com'

/** SoundCloud hands out encrypted renditions only to signed players. */
const ENCRYPTED = new Set(['cbc-encrypted-hls', 'ctr-encrypted-hls'])

/** Assets are big; the client_id lives near the top of one of them. */
const CLIENT_ID_RE = /client_id\s*[:=]\s*["']?([a-zA-Z0-9]{32})["']?/

const isMp3 = (t) => t?.format?.mime_type?.includes('mpeg')
const isAac = (t) => /mp4|aac/i.test(t?.format?.mime_type ?? '')
const isProgressive = (t) => t?.format?.protocol === 'progressive'
const isHls = (t) => t?.format?.protocol === 'hls'

export class SoundCloudSource {
  name = 'soundcloud'
  prefixes = ['scsearch:', 'sc:']
  #clientId = null
  #clientIdPromise = null
  #fetchedAt = 0

  constructor({ clientId }: any = {}) {
    // A configured key is used as-is, and still refreshed if it stops working.
    if (clientId) this.#clientId = clientId
  }

  /* --------------------------- client id --------------------------- */

  async clientId(force = false) {
    if (this.#clientId && !force && Date.now() - this.#fetchedAt < 6 * 3600_000) return this.#clientId
    if (this.#clientIdPromise) return this.#clientIdPromise

    this.#clientIdPromise = (async () => {
      const { inline, assets } = await this.#assetUrls()

      // The page itself sometimes carries the key in its hydrated state; that
      // is cheaper and more stable than any asset bundle.
      if (inline) {
        this.#clientId = inline
        this.#fetchedAt = Date.now()
        log.info(`client_id found inline (${inline.slice(0, 6)}…)`)
        return this.#clientId
      }

      for (const src of assets.reverse()) {
        try {
          const js = await fetch(src, { headers: { 'user-agent': UA } }).then((r) => (r.ok ? r.text() : ''))
          const match = CLIENT_ID_RE.exec(js)
          if (match) {
            this.#clientId = match[1]
            this.#fetchedAt = Date.now()
            log.info(`client_id acquired (${match[1].slice(0, 6)}…)`)
            return this.#clientId
          }
        } catch (error) {
          log.debug(`asset ${src.slice(-40)} unreadable: ${error.message}`)
        }
      }

      // Nothing new was found. A previously supplied key is better than
      // throwing away a working node.
      if (this.#clientId) return this.#clientId
      throw new Error('Could not extract a SoundCloud client_id')
    })().finally(() => {
      this.#clientIdPromise = null
    })

    return this.#clientIdPromise
  }

  /**
   * Every script URL the public pages reference.
   *
   * Both the marketing site and the player are asked: a page redesign on one
   * of them (or an A/B test) should not cost the node its key.
   */
  async #assetUrls() {
    const pages = ['https://soundcloud.com/discover', 'https://soundcloud.com/']
    const assets = new Set()

    for (const page of pages) {
      try {
        const html = await fetch(page, { headers: { 'user-agent': UA } }).then((r) => (r.ok ? r.text() : ''))

        // The hydrated app state sometimes carries the key outright.
        const inline = CLIENT_ID_RE.exec(html)?.[1]
        if (inline) return { inline, assets: [] }

        for (const match of html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)) {
          assets.add(match[1])
        }
      } catch (error) {
        log.debug(`page ${page} unreadable: ${error.message}`)
      }
    }
    return { inline: null, assets: [...assets] }
  }

  async #api(path, params: any = {}, retry = true) {
    const clientId = await this.clientId()
    const url = new URL(path.startsWith('http') ? path : `${API}${path}`)
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v))
    url.searchParams.set('client_id', clientId)

    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } })

    if ((res.status === 401 || res.status === 403) && retry) {
      log.warn(`client_id rejected (${res.status}), refreshing`)
      await this.clientId(true)
      return this.#api(path, params, false)
    }
    if (res.status === 404) throw new Error('SoundCloud: not found (deleted or private)')
    if (!res.ok) throw new Error(`SoundCloud ${res.status} for ${url.pathname}`)
    return res.json()
  }

  /** Follow a snd.sc short link to the real track/playlist URL. */
  async #expand(url) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' })
      return res.url || url
    } catch {
      return url
    }
  }

  /* ---------------------------- matching ---------------------------- */

  canResolve(query) {
    const q = String(query).trim()
    return (
      this.prefixes.some((p) => q.toLowerCase().startsWith(p)) ||
      /^https?:\/\/(m\.|www\.|on\.)?soundcloud\.com\//i.test(q) ||
      /^https?:\/\/snd\.sc\//i.test(q)
    )
  }

  /* ---------------------------- resolving --------------------------- */

  /** @returns {Promise<{type:'track'|'playlist'|'search', name?:string, tracks:object[]}>} */
  async resolve(query, { limit = 50 }: any = {}) {
    let q = String(query).trim()

    for (const prefix of this.prefixes) {
      if (q.toLowerCase().startsWith(prefix)) {
        const term = q.slice(prefix.length).trim()
        return { type: 'search', name: term, tracks: await this.search(term, limit) }
      }
    }

    if (/^https?:\/\/(snd\.sc|on\.soundcloud\.com)\//i.test(q)) q = await this.#expand(q)
    const data = await this.#api('/resolve', { url: q })

    if (data.kind === 'track') return { type: 'track', name: data.title, tracks: [this.#track(data)] }

    if (data.kind === 'playlist') {
      // A set/album that is entirely private has nothing to air.
      const tracks = await this.#hydrate(data.tracks ?? [], limit)
      if (tracks.length === 0) throw new Error(`"${data.title}" has no streamable tracks`)
      return { type: 'playlist', name: data.title, artwork: data.artwork_url ?? null, tracks }
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
      try {
        const batch = await this.#api('/tracks', { ids })
        out.push(...batch.map((t) => this.#track(t)))
      } catch (error) {
        log.debug(`stub hydration failed: ${error.message}`)
      }
    }
    return out.filter((t) => t.streamable)
  }

  #track(raw) {
    const artwork = (raw.artwork_url ?? raw.user?.avatar_url ?? null)?.replace(/-large\./, '-t500x500.') ?? null
    const transcodings = raw.media?.transcodings ?? []
    const progressive = transcodings.find((t) => isProgressive(t) && isMp3(t))
    const hlsMp3 = transcodings.find((t) => isHls(t) && isMp3(t))
    const hlsAac = transcodings.find((t) => isHls(t) && isAac(t))
    const encrypted = transcodings.length > 0 && transcodings.every((t) => ENCRYPTED.has(t.format?.protocol))

    // `policy: 'BLOCK'` is a geo block, `policy: 'SNIP'` (or a snipped
    // transcoding) is the 30-second preview some major-label uploads get.
    const blocked = raw.policy === 'BLOCK'
    const snipped = raw.policy === 'SNIP' || transcodings.some((t) => t.snipped === true)
    const aacOnly = !progressive && !hlsMp3 && Boolean(hlsAac)

    return {
      source: 'soundcloud',
      id: `sc:${raw.id}`,
      title: raw.title ?? 'Unknown',
      artist: raw.user?.username ?? raw.publisher_metadata?.artist ?? 'Unknown artist',
      album: raw.publisher_metadata?.album_title ?? null,
      duration: raw.duration ?? raw.full_duration ?? 0,
      artwork,
      url: raw.permalink_url,
      pageUrl: raw.permalink_url,
      genre: raw.genre || null,
      playbackCount: raw.playback_count ?? 0,
      likes: raw.likes_count ?? 0,
      bitrate: aacOnly ? 160 : 128,
      transcode: aacOnly,
      streamable: !blocked && !snipped && !encrypted && Boolean(progressive || hlsMp3 || hlsAac),
      ...(blocked ? { blocked: 'geo' } : snipped ? { preview: true } : encrypted ? { drm: true } : {}),
      _transcodings: {
        progressive: progressive?.url ?? null,
        hls: hlsMp3?.url ?? null,
        hlsAac: hlsAac?.url ?? null,
        trackAuth: raw.track_authorization ?? null
      }
    }
  }

  /* ----------------------------- streaming -------------------------- */

  /**
   * The direct CDN URL for a track, for `<audio src>` in the console. This is
   * the same request stream() makes, minus opening the socket.
   */
  async getTrackUrl(track) {
    const t = track._transcodings ?? {}
    if (!t.progressive) return null
    const { url } = await this.#api(t.progressive, { track_authorization: t.trackAuth })
    return url
  }

  /**
   * Recover `_transcodings` when a track lost its private handles (e.g. after
   * crossing the REST API, SQLite store, or station memory).
   */
  async #recoverTranscodings(track) {
    const numericId = /^sc:(\d+)$/.exec(String(track?.id ?? ''))?.[1]
    if (numericId) {
      try {
        const raw = await this.#api(`/tracks/${numericId}`)
        const hydrated = this.#track(raw)
        if (hydrated?._transcodings) {
          track._transcodings = hydrated._transcodings
          return hydrated._transcodings
        }
      } catch {
        /* fall through to permalink resolve */
      }
    }
    const hint = track?.url ?? track?.pageUrl ?? track?.link
    if (hint && /^https?:/i.test(String(hint))) {
      try {
        const raw = await this.#api('/resolve', { url: hint })
        const hydrated = this.#track(raw)
        if (hydrated?._transcodings) {
          track._transcodings = hydrated._transcodings
          return hydrated._transcodings
        }
      } catch {
        /* ignore */
      }
    }
    return {}
  }

  /** @returns {Promise<{stream?: Readable, url?: string, hls?: boolean, transcode?: boolean, contentType: string, mode: string}>} */
  async stream(track, { signal }: any = {}) {
    let t = track._transcodings ?? {}
    if (!t.progressive && !t.hls && !t.hlsAac) {
      t = await this.#recoverTranscodings(track)
    }

    if (t.progressive) {
      const { url } = await this.#api(t.progressive, { track_authorization: t.trackAuth })
      const res = await fetchWithConnectTimeout(url, {
        headers: { 'user-agent': UA },
        connectTimeoutMs: 20_000,
        signal
      })
      if (!res.ok || !res.body) throw new Error(`Progressive fetch failed (${res.status})`)
      return {
        stream: responseToNodeStream(res, { signal }),
        contentType: res.headers.get('content-type') || 'audio/mpeg',
        mode: 'progressive'
      }
    }

    if (t.hls) {
      const { url } = await this.#api(t.hls, { track_authorization: t.trackAuth })
      return { stream: hlsMp3Stream(url, { signal }), contentType: 'audio/mpeg', mode: 'hls' }
    }

    if (t.hlsAac) {
      const { url } = await this.#api(t.hlsAac, { track_authorization: t.trackAuth })
      return { url, hls: true, transcode: true, contentType: 'application/vnd.apple.mpegurl', mode: 'hls-aac' }
    }

    throw new Error(`Track "${track.title}" has no playable transcoding`)
  }
}

/**
 * Sequentially fetch HLS MP3 segments and emit them as one continuous MP3.
 *
 * Errors are *retried once* and then fatal: a single 503 on segment 40 of 60
 * should not cost the station the song, and a genuinely dead playlist should
 * not hang the reader forever.
 */
export function hlsMp3Stream(playlistUrl, { retries = 1, signal }: any = {}) {
  return Readable.from(
    (async function* () {
      const playlistRes = await fetchWithConnectTimeout(playlistUrl, {
        headers: { 'user-agent': UA },
        connectTimeoutMs: 15_000,
        signal
      })
      if (!playlistRes.ok) throw new Error(`HLS playlist ${playlistRes.status}`)
      const text = await playlistRes.text()
      const segments = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => new URL(l, playlistUrl).toString())

      if (segments.length === 0) throw new Error('HLS playlist had no segments')

      for (const segment of segments) {
        if (signal?.aborted) return
        let lastError
        for (let attempt = 0; attempt <= retries; attempt += 1) {
          if (signal?.aborted) return
          try {
            const res = await fetchWithConnectTimeout(segment, {
              headers: { 'user-agent': UA },
              connectTimeoutMs: 15_000,
              signal
            })
            if (!res.ok) throw new Error(`HLS segment ${res.status}`)
            yield Buffer.from(await res.arrayBuffer())
            lastError = null
            break
          } catch (error) {
            if (signal?.aborted) return
            lastError = error
          }
        }
        if (lastError) throw lastError
      }
    })(),
    { objectMode: false }
  )
}

export default SoundCloudSource
