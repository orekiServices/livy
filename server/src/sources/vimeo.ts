/**
 * Vimeo — the audio of a Vimeo video, which is where a surprising amount of
 * live-session and label material lives.
 *
 * The player's own config endpoint describes every rendition of a video
 * without a key or an account: progressive MP4 when the uploader allowed it,
 * and an HLS playlist otherwise. When `/config` refuses an unembedded request
 * (403/401), this falls back to the embed page's `window.playerConfig` and
 * then to Vimeo's anonymous Next.js bootstrap (`vimeo.com/watch` →
 * `/_next/data/...` → `api.vimeo.com/videos/<id>` → `embed_player_config_url`),
 * preserving unlisted `?h=` / `/<id>/<hash>` hashes throughout.
 *
 * Either way the audio is AAC, so this source hands the station an `.m3u8`
 * (followed segment by segment) or an MP4 (decoded whole) and lets MetroS do
 * the rest.
 *
 *   vimeo:76979871
 *   https://vimeo.com/76979871
 *   https://vimeo.com/76979871/abcdef1234
 *   https://player.vimeo.com/video/76979871?h=abcdef1234
 */
import { fetchWithConnectTimeout, responseToNodeStream } from '../util/fetchStream.ts'

const VIMEO_BASE = 'https://vimeo.com'
const VIMEO_API_BASE = 'https://api.vimeo.com'
const CONFIG = (id, hash) => `https://player.vimeo.com/video/${id}/config${hash ? `?h=${encodeURIComponent(hash)}` : ''}`
const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

const VIMEO_PATTERNS = [
  /vimeo\.com\/channels\/[^/]+\/(\d+)(?:\/([a-f0-9]{6,}))?/i,
  /vimeo\.com\/groups\/[^/]+\/videos\/(\d+)(?:\/([a-f0-9]{6,}))?/i,
  /vimeo\.com\/(?:album|showcase)\/\d+\/video\/(\d+)(?:\/([a-f0-9]{6,}))?/i,
  /player\.vimeo\.com\/video\/(\d+)/i,
  /vimeo\.com\/(\d+)(?:\/([a-f0-9]{6,}))?/i
]

function parseNextData(html) {
  const json = /<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1]
  if (!json) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

export class VimeoSource {
  declare fetch: any

  name = 'vimeo'
  prefixes = ['vimeo:', 'vmsearch:']

  constructor({ fetchImpl = fetch }: any = {}) {
    this.fetch = fetchImpl
  }

  canResolve(query) {
    const q = String(query).trim().toLowerCase()
    return this.prefixes.some((p) => q.startsWith(p)) || /(^|\/\/)(www\.)?(player\.)?vimeo\.com\//.test(q)
  }

  /** Pull the numeric id and optional unlisted hash out of anything a user might paste. */
  #parse(query) {
    let q = String(query).trim()
    for (const prefix of this.prefixes) {
      if (q.toLowerCase().startsWith(prefix)) q = q.slice(prefix.length).trim()
    }

    let hash = null
    try {
      if (/^https?:\/\//i.test(q)) hash = new URL(q).searchParams.get('h')
    } catch {
      /* ignore malformed URL */
    }

    for (const pattern of VIMEO_PATTERNS) {
      const match = pattern.exec(q)
      if (match?.[1]) return { id: match[1], hash: hash ?? match[2] ?? null }
    }

    const digits = q.replace(/\D/g, '')
    return { id: digits || '', hash }
  }

  /** Anonymous Next.js bootstrap → api.vimeo.com → embed_player_config_url. */
  async #anonymousConfig(id, hash) {
    const watch = await this.fetch(`${VIMEO_BASE}/watch`, {
      headers: { 'user-agent': AGENT, accept: 'text/html,application/xhtml+xml' }
    })
    if (!watch.ok) return null
    const nextData = parseNextData(await watch.text())
    if (!nextData?.buildId || !nextData?.locale) return null

    const dataUrl = new URL(
      `/_next/data/${encodeURIComponent(nextData.buildId)}/${encodeURIComponent(nextData.locale)}/${encodeURIComponent(id)}.json`,
      VIMEO_BASE
    )
    if (hash) dataUrl.searchParams.set('h', hash)

    const page = await this.fetch(dataUrl.toString(), {
      headers: {
        'user-agent': AGENT,
        accept: 'application/json',
        'accept-language': nextData.locale,
        'x-nextjs-data': '1',
        referer: `${VIMEO_BASE}/watch`
      }
    })
    if (!page.ok) return null
    const props = (await page.json())?.pageProps
    const clipId = props?.clipId ?? id
    const signature = props?.pageMetadata?.clipSignature
    const jwt = props?.viewerBootstrap?.jwt
    if (!signature || !jwt) return null

    const apiUrl = new URL(`/videos/${encodeURIComponent(String(clipId))}`, VIMEO_API_BASE)
    apiUrl.searchParams.set('anon_signature', signature)
    apiUrl.searchParams.set('fields', 'type,embed_player_config_url,player_embed_url')
    if (hash) apiUrl.searchParams.set('h', hash)

    const api = await this.fetch(apiUrl.toString(), {
      headers: {
        'user-agent': AGENT,
        accept: 'application/vnd.vimeo.*+json;version=3.4.12',
        authorization: `jwt ${jwt}`,
        'content-type': 'application/json',
        'vimeo-page': '/video/[clipId]',
        referer: `${VIMEO_BASE}/`
      }
    })
    if (!api.ok) return null
    const apiData = await api.json()
    if (!apiData?.embed_player_config_url) return null

    const config = await this.fetch(apiData.embed_player_config_url, {
      headers: {
        'user-agent': AGENT,
        accept: 'application/json',
        referer: `${VIMEO_BASE}/${id}${hash ? `?h=${encodeURIComponent(hash)}` : ''}`,
        origin: VIMEO_BASE
      }
    })
    if (!config.ok) return null
    return config.json()
  }

  /**
   * The player config, with fallbacks for embed-restricted and modern
   * signature-gated Vimeo videos.
   */
  async #config(id, hash) {
    const res = await this.fetch(CONFIG(id, hash), {
      headers: { 'user-agent': AGENT, referer: `${VIMEO_BASE}/`, accept: 'application/json' }
    })
    if (res.ok) return res.json()

    if (res.status === 403 || res.status === 401) {
      const playerUrl = `https://player.vimeo.com/video/${id}${hash ? `?h=${encodeURIComponent(hash)}` : ''}`
      const page = await this.fetch(playerUrl, {
        headers: { 'user-agent': AGENT, referer: `${VIMEO_BASE}/` }
      })
      if (page.ok) {
        const html = await page.text()
        const blob = /window\.playerConfig\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/.exec(html)?.[1]
        if (blob) {
          try {
            return JSON.parse(blob)
          } catch {
            /* fall through to anonymous API */
          }
        }
      }

      try {
        const anon = await this.#anonymousConfig(id, hash)
        if (anon) return anon
      } catch {
        /* fall through to the honest error */
      }

      throw new Error('This Vimeo video does not allow embedding')
    }
    throw new Error(`Vimeo answered ${res.status}`)
  }

  async resolve(query) {
    const { id, hash } = this.#parse(query)
    if (!id) throw new Error('No Vimeo id in that link')

    const config = await this.#config(id, hash)
    const video = config.video ?? {}
    const files = config.request?.files ?? config.video?.files ?? config.files ?? {}

    // Prefer a progressive MP4 (one file, decoded whole, no playlist to
    // follow); fall back to the HLS rendition, which every video has.
    const progressive = [...(files.progressive ?? [])].sort((a, b) => (a.width ?? 0) - (b.width ?? 0))[0]
    const defaultHls = files.hls?.cdns?.[files.hls?.default_cdn]
    const firstHls = Object.values(files.hls?.cdns ?? {})[0] as any
    const hls = defaultHls?.url ?? defaultHls?.avc_url ?? firstHls?.url ?? firstHls?.avc_url ?? null

    const url = progressive?.url ?? hls
    if (!url) throw new Error('Vimeo gave no playable rendition')

    const artwork = [...(video.thumbs ? Object.entries(video.thumbs) : [])]
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([, value]) => value)[0]

    return {
      type: 'track',
      name: video.title ?? `Vimeo ${id}`,
      tracks: [
        {
          source: 'vimeo',
          id: `vimeo:${id}`,
          title: video.title ?? `Vimeo ${id}`,
          artist: video.owner?.name ?? 'Vimeo',
          duration: Number(video.duration ?? 0) * 1000,
          artwork: artwork ?? null,
          url,
          format: progressive ? 'mp4' : 'hls',
          // AAC either way: MetroS turns it into MP3 on the way out.
          transcode: true,
          live: false,
          streamable: true,
          link: video.url ?? `${VIMEO_BASE}/${id}${hash ? `?h=${encodeURIComponent(hash)}` : ''}`
        }
      ]
    }
  }

  getTrackUrl(track) {
    return /^https?:/i.test(track.url ?? '') ? track.url : null
  }

  async stream(track, { signal }: any = {}) {
    if (!track.url) throw new Error('vimeo: missing stream url')
    // An HLS rendition is followed by the station's relay machinery, which
    // knows about playlists; a progressive file is just bytes.
    if (track.format === 'hls' || /\.m3u8(\?|$)/i.test(track.url)) {
      return { url: track.url, hls: true, transcode: true, contentType: 'application/vnd.apple.mpegurl', mode: 'hls' }
    }
    const res = await fetchWithConnectTimeout(track.url, {
      headers: { 'user-agent': AGENT, referer: `${VIMEO_BASE}/` },
      connectTimeoutMs: 20_000,
      signal,
      fetchImpl: this.fetch
    })
    if (!res.ok || !res.body) throw new Error(`Vimeo file ${res.status}`)
    const stream = responseToNodeStream(res, { signal })
    return { stream, contentType: res.headers.get('content-type') ?? 'video/mp4', transcode: true, mode: 'mp4' }
  }
}

export default VimeoSource
