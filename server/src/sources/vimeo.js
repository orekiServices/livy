/**
 * Vimeo — the audio of a Vimeo video, which is where a surprising amount of
 * live-session and label material lives.
 *
 * The player's own config endpoint describes every rendition of a video
 * without a key or an account: progressive MP4 when the uploader allowed it,
 * and an HLS playlist otherwise. Either way the audio is AAC, so this source
 * only became playable once MetroS could decode — it hands the station an
 * `.m3u8` (followed segment by segment) or an MP4 (decoded whole) and lets
 * the transcoder do the rest.
 *
 *   vimeo:76979871
 *   https://vimeo.com/76979871
 *   https://player.vimeo.com/video/76979871
 */
const CONFIG = (id) => `https://player.vimeo.com/video/${id}/config`

export class VimeoSource {
  name = 'vimeo'
  prefixes = ['vimeo:', 'vmsearch:']

  constructor({ fetchImpl = fetch } = {}) {
    this.fetch = fetchImpl
  }

  canResolve(query) {
    const q = String(query).trim().toLowerCase()
    return this.prefixes.some((p) => q.startsWith(p)) || /(^|\/\/)(www\.)?(player\.)?vimeo\.com\//.test(q)
  }

  /** Pull the numeric id out of anything a user might paste. */
  #id(query) {
    const q = String(query).trim()
    for (const prefix of this.prefixes) {
      if (q.toLowerCase().startsWith(prefix)) return q.slice(prefix.length).replace(/\D/g, '')
    }
    return /vimeo\.com\/(?:video\/)?(\d+)/.exec(q)?.[1] ?? q.replace(/\D/g, '')
  }

  async #config(id) {
    const res = await this.fetch(CONFIG(id), {
      headers: { 'user-agent': 'Nodecast/3', referer: 'https://vimeo.com/', accept: 'application/json' }
    })
    if (res.status === 403) throw new Error('This Vimeo video does not allow embedding')
    if (!res.ok) throw new Error(`Vimeo answered ${res.status}`)
    return res.json()
  }

  async resolve(query) {
    const id = this.#id(query)
    if (!id) throw new Error('No Vimeo id in that link')

    const config = await this.#config(id)
    const video = config.video ?? {}
    const files = config.request?.files ?? {}

    // Prefer a progressive MP4 (one file, decoded whole, no playlist to
    // follow); fall back to the HLS rendition, which every video has.
    const progressive = [...(files.progressive ?? [])].sort((a, b) => (a.width ?? 0) - (b.width ?? 0))[0]
    const hls = files.hls?.cdns?.[files.hls?.default_cdn]?.url ?? Object.values(files.hls?.cdns ?? {})[0]?.url ?? null

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
          link: video.url ?? `https://vimeo.com/${id}`
        }
      ]
    }
  }

  async stream(track) {
    // An HLS rendition is followed by the station's relay machinery, which
    // knows about playlists; a progressive file is just bytes.
    if (track.format === 'hls' || /\.m3u8(\?|$)/i.test(track.url)) {
      return { url: track.url, hls: true, transcode: true, contentType: 'application/vnd.apple.mpegurl', mode: 'hls' }
    }
    const res = await this.fetch(track.url, { headers: { 'user-agent': 'Nodecast/3', referer: 'https://vimeo.com/' } })
    if (!res.ok || !res.body) throw new Error(`Vimeo file ${res.status}`)
    return { stream: res.body, contentType: res.headers.get('content-type') ?? 'video/mp4', transcode: true, mode: 'mp4' }
  }
}

export default VimeoSource
