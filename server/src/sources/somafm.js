/**
 * SomaFM source — 30-odd hand-curated, listener-supported channels served as
 * plain MP3 ICY streams. No key, no ads, and the station metadata is good
 * enough to pass straight through to our own ICY output.
 *
 * Queries: soma:<channel|terms> | somafm: | https://somafm.com/<channel>
 *
 * Channels are *live* streams: the station engine treats them like any other
 * endless source (no automix seam, ICY title updates flow through).
 */
import createLogger from '../util/logger.js'

const log = createLogger('src:somafm')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const DIRECTORY = 'https://somafm.com/channels.json'

export class SomaFmSource {
  name = 'somafm'
  prefixes = ['soma:', 'somafm:']

  #channels = null
  #fetchedAt = 0

  constructor({ http = null } = {}) {
    this.http = http // the ICY-capable HTTP source does the actual streaming
  }

  canResolve(query) {
    const q = String(query).trim().toLowerCase()
    return this.prefixes.some((p) => q.startsWith(p)) || /^https?:\/\/(www\.)?somafm\.com\//.test(q)
  }

  async #directory() {
    if (this.#channels && Date.now() - this.#fetchedAt < 60 * 60_000) return this.#channels
    const res = await fetch(DIRECTORY, { headers: { 'user-agent': UA } })
    if (!res.ok) throw new Error(`somafm ${res.status}`)
    const data = await res.json()
    this.#channels = data.channels ?? []
    this.#fetchedAt = Date.now()
    return this.#channels
  }

  /** The highest-quality MP3 playlist, resolved through its .pls file. */
  async #streamUrl(channel) {
    const playlist =
      channel.playlists?.find((p) => p.format === 'mp3' && p.quality === 'highest') ??
      channel.playlists?.find((p) => p.format === 'mp3')
    if (!playlist) throw new Error(`${channel.id} has no MP3 stream`)

    const res = await fetch(playlist.url, { headers: { 'user-agent': UA } })
    if (!res.ok) throw new Error(`somafm playlist ${res.status}`)
    const body = await res.text()
    const url = /^File\d+=(.+)$/m.exec(body)?.[1]?.trim()
    if (!url) throw new Error(`${channel.id} playlist had no stream URL`)
    return url
  }

  #track(channel, url) {
    return {
      source: 'somafm',
      id: `somafm:${channel.id}`,
      title: channel.title ?? channel.id,
      artist: 'SomaFM',
      description: channel.description ?? null,
      genre: channel.genre ?? null,
      artwork: channel.xlimage ?? channel.largeimage ?? channel.image ?? null,
      url,
      pageUrl: `https://somafm.com/${channel.id}/`,
      listeners: Number(channel.listeners ?? 0),
      live: true,
      duration: 0,
      bitrate: 128,
      streamable: true
    }
  }

  async search(term, limit = 10) {
    const channels = await this.#directory()
    const q = String(term ?? '').trim().toLowerCase()
    const hits = q
      ? channels.filter((c) =>
          [c.id, c.title, c.genre, c.description].filter(Boolean).some((field) => String(field).toLowerCase().includes(q))
        )
      : [...channels].sort((a, b) => Number(b.listeners ?? 0) - Number(a.listeners ?? 0))

    const chosen = hits.slice(0, limit)
    const urls = await Promise.allSettled(chosen.map((c) => this.#streamUrl(c)))
    const tracks = chosen
      .map((channel, i) => (urls[i].status === 'fulfilled' ? this.#track(channel, urls[i].value) : null))
      .filter(Boolean)
    log.debug(`search "${term}" -> ${tracks.length} channel(s)`)
    return tracks
  }

  async resolve(query, { limit = 20 } = {}) {
    let q = String(query).trim()
    for (const p of this.prefixes) if (q.toLowerCase().startsWith(p)) q = q.slice(p.length).trim()
    if (/^https?:\/\//i.test(q)) q = new URL(q).pathname.split('/').filter(Boolean)[0] ?? ''

    const channels = await this.#directory()
    const exact = channels.find((c) => c.id.toLowerCase() === q.toLowerCase())
    if (exact) {
      const track = this.#track(exact, await this.#streamUrl(exact))
      return { type: 'track', name: track.title, tracks: [track] }
    }

    const tracks = await this.search(q, limit)
    if (!tracks.length) throw new Error(`No SomaFM channel matches "${q}"`)
    return { type: q ? 'search' : 'playlist', name: q || 'SomaFM', tracks }
  }

  /** Streaming is plain ICY MP3 — the HTTP source already speaks it. */
  async stream(track, options = {}) {
    if (!this.http) throw new Error('somafm needs the http source to stream')
    return this.http.stream({ ...track, source: 'http' }, options)
  }
}

export default SomaFmSource
