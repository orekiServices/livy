/**
 * Radio Paradise — listener-supported radio, and the best argument for
 * having a decoder at all: its lossless channels are served as **FLAC
 * blocks**, not as an MP3 stream.
 *
 * The API hands out one "block" at a time: a ~10 minute FLAC file plus the
 * songs inside it and the millisecond each one starts. We turn a block into
 * tracks so the station can announce them properly, and MetroS transcodes
 * the FLAC to MP3 on the way to the pacer.
 *
 *   rp:mellow          one of the channels by name
 *   rp:0               …or by id
 *   https://radioparadise.com/…   pasted links
 *
 * No key, no account. `chan=0` main mix, 1 mellow, 2 rock, 3 global, 4 eclectic.
 */
import { createHash } from 'node:crypto'

const API = 'https://api.radioparadise.com/api'
const AGENT = 'Livy/1 (+https://github.com/orekiServices/livy)'

/** The channels the API exposes, with the names people actually use. */
const CHANNELS = [
  { id: 0, slug: 'main', name: 'Radio Paradise — Main Mix', aliases: ['main', 'mix', 'rp'] },
  { id: 1, slug: 'mellow', name: 'Radio Paradise — Mellow Mix', aliases: ['mellow', 'chill'] },
  { id: 2, slug: 'rock', name: 'Radio Paradise — Rock Mix', aliases: ['rock'] },
  { id: 3, slug: 'global', name: 'Radio Paradise — Global Mix', aliases: ['global', 'world'] },
  { id: 4, slug: 'eclectic', name: 'Radio Paradise — Eclectic Mix', aliases: ['eclectic', 'beyond'] }
]

export class RadioParadiseSource {
  name = 'radioparadise'
  prefixes = ['rp:', 'radioparadise:']

  constructor({ fetchImpl = fetch } = {}) {
    this.fetch = fetchImpl
  }

  canResolve(query) {
    const q = String(query).trim().toLowerCase()
    return this.prefixes.some((p) => q.startsWith(p)) || /radioparadise\.com/.test(q)
  }

  /** Name, id or URL → one of the five channels (main mix by default). */
  #channel(query) {
    const q = String(query).trim().toLowerCase()
    const cleaned = this.prefixes.reduce((value, prefix) => (value.startsWith(prefix) ? value.slice(prefix.length) : value), q)
    const fromUrl = /radioparadise\.com\/?([a-z-]+)?/.exec(cleaned)?.[1]
    const key = (cleaned || fromUrl || 'main').replace(/[^a-z0-9]/g, '')
    if (/^\d$/.test(key)) return CHANNELS.find((c) => c.id === Number(key)) ?? CHANNELS[0]
    return CHANNELS.find((c) => c.slug === key || c.aliases.includes(key)) ?? CHANNELS[0]
  }

  /**
   * One block = one FLAC file plus its running order.
   *
   * `bitrate=4` is the lossless tier; the songs come back with their offset
   * inside the block, which is exactly what a station needs to announce the
   * right title at the right moment.
   */
  async #block(channel, event) {
    const url = new URL(`${API}/get_block`)
    url.searchParams.set('bitrate', '4') // 0=aac 32k … 4=flac
    url.searchParams.set('info', 'true')
    url.searchParams.set('chan', String(channel.id))
    if (event) url.searchParams.set('event', event)

    const res = await this.fetch(url, { headers: { 'user-agent': AGENT, accept: 'application/json' } })
    if (!res.ok) throw new Error(`Radio Paradise answered ${res.status}`)
    const block = await res.json()
    if (!block?.url) throw new Error('Radio Paradise returned no audio block')
    return block
  }

  #tracks(channel, block) {
    const audio = block.url.startsWith('http') ? block.url : `https://audio.radioparadise.com/${block.url.replace(/^\/+/, '')}`
    const songs = Object.values(block.song ?? {})

    // The whole block is one file; each song is a cue point inside it. The
    // first track carries the audio, the rest are announced as it plays.
    return songs.map((song, index) => ({
      source: 'radioparadise',
      id: `rp:${block.event}:${index}`,
      title: song.title ?? 'Radio Paradise',
      artist: song.artist ?? channel.name,
      album: song.album ?? null,
      duration: Number(song.duration ?? 0),
      artwork: song.cover ? `https://img.radioparadise.com/${song.cover}` : null,
      url: audio,
      // Everything after the first song is already inside the same file.
      offsetMs: Number(song.elapsed ?? 0),
      blockEvent: block.end_event ?? block.event,
      channel: channel.slug,
      format: 'flac',
      transcode: true, // MetroS: FLAC → MP3
      bitrate: 1000, // lossless; the hi-res policy should never "upgrade" this
      streamable: index === 0,
      link: song.slug ? `https://radioparadise.com/track/${song.slug}` : 'https://radioparadise.com'
    }))
  }

  async resolve(query) {
    const channel = this.#channel(query)
    const block = await this.#block(channel)
    const tracks = this.#tracks(channel, block)
    if (tracks.length === 0) throw new Error('Radio Paradise block had no songs')

    return {
      type: 'playlist',
      name: channel.name,
      // Only the first track carries the audio; the others are its songs.
      tracks: [{ ...tracks[0], blockSongs: tracks.slice(1).map(({ title, artist, offsetMs }) => ({ title, artist, offsetMs })) }]
    }
  }

  async search(query, limit = 5) {
    const q = String(query).toLowerCase()
    return CHANNELS.filter((channel) => !q || channel.name.toLowerCase().includes(q) || channel.aliases.some((a) => q.includes(a)))
      .slice(0, limit)
      .map((channel) => ({
        source: 'radioparadise',
        id: `rp:${channel.slug}`,
        title: channel.name,
        artist: 'Radio Paradise',
        duration: 0,
        artwork: null,
        url: `rp:${channel.slug}`,
        query: `rp:${channel.slug}`,
        streamable: true,
        lossless: true
      }))
  }

  async stream(track) {
    const res = await this.fetch(track.url, { headers: { 'user-agent': AGENT } })
    if (!res.ok || !res.body) throw new Error(`Radio Paradise block ${res.status}`)
    return {
      stream: res.body,
      contentType: res.headers.get('content-type') ?? 'audio/flac',
      // The station hands this to MetroS instead of airing it directly.
      transcode: true,
      mode: 'flac'
    }
  }

  /** Follow the channel: the next block continues where this one stopped. */
  async next(track) {
    const channel = CHANNELS.find((c) => c.slug === track.channel) ?? CHANNELS[0]
    const block = await this.#block(channel, track.blockEvent)
    const tracks = this.#tracks(channel, block)
    return tracks[0] ?? null
  }

  static get channels() {
    return CHANNELS.map(({ id, slug, name }) => ({ id, slug, name }))
  }
}

export const hashUrl = (url) => createHash('sha1').update(String(url)).digest('hex').slice(0, 16)

export default RadioParadiseSource
