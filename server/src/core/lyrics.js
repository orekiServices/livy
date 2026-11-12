/**
 * Lyrics — words, in time, for whatever is on air.
 *
 * The console shows Apple-Music-style word-synced lyrics with the
 * `<am-lyrics>` web component. That component can fetch lyrics itself, but
 * Nodecast fetches them **here**, on the server, for three reasons:
 *
 *   • a listener's browser never talks to a third party on our behalf — no
 *     leaked listening habits, no keys, nothing to block;
 *   • a node on a LAN with one internet connection fetches a song's lyrics
 *     once, not once per listener;
 *   • the result is cached with the track, so the seventh play of the
 *     station ident costs nothing.
 *
 * Source: [LRCLIB](https://lrclib.net) — no key, no account, LRC in and out.
 * Exact match first (artist + title + duration), then a search, and a plain
 * unsynced fallback so a listener at least gets the words.
 */
import { createHash } from 'node:crypto'

import createLogger from '../util/logger.js'

const log = createLogger('lyrics')

const API = 'https://lrclib.net/api'
const AGENT = 'Nodecast/3 (https://github.com/nodecast)'

/** Strip the noise that stops a search matching: "(Official Video)" etc. */
export function cleanTitle(title = '') {
  return String(title)
    .replace(/\([^)]*(official|video|audio|lyric|remaster|explicit|hd|hq|mv)[^)]*\)/gi, ' ')
    .replace(/\[[^\]]*(official|video|audio|lyric|remaster|explicit|hd|hq|mv)[^\]]*\]/gi, ' ')
    .replace(/\s*[-–—]\s*(official\s+)?(music\s+)?(video|audio|lyrics?)\s*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The same title with *every* bracketed aside removed.
 *
 * Radio metadata is full of them — "(w/ Sinéad O'Connor)", "(feat. …)",
 * "(Radio Edit)" — and a lyrics database rarely files the song under any of
 * them. Used as the second attempt, never the first: the parenthetical is
 * sometimes the only thing distinguishing two versions.
 */
export function bareTitle(title = '') {
  return cleanTitle(title)
    .replace(/[([][^)\]]*[)\]]/g, ' ')
    .replace(/\s+(feat|ft|with|w)\.?\s+.+$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "Artist - Title" in one field is common on radio; split it when we can. */
export function splitArtistTitle(track = {}) {
  let artist = String(track.artist ?? '').trim()
  let title = cleanTitle(track.title ?? '')

  if (!artist && title.includes(' - ')) {
    const [first, ...rest] = title.split(' - ')
    artist = first.trim()
    title = rest.join(' - ').trim()
  }
  // Some stations send "Artist - Title" in *both* fields.
  if (artist && title.toLowerCase().startsWith(`${artist.toLowerCase()} - `)) {
    title = title.slice(artist.length + 3).trim()
  }
  return { artist, title }
}

/**
 * Parse an LRC into lines the UI can scroll.
 * `[00:12.34] words` → `{ at: 12340, text: 'words' }`, in order.
 */
export function parseLrc(lrc = '') {
  const lines = []
  for (const raw of String(lrc).split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)]
    if (stamps.length === 0) continue
    const text = raw.replace(/\[[^\]]*\]/g, '').trim()
    for (const stamp of stamps) {
      const minutes = Number(stamp[1])
      const seconds = Number(stamp[2])
      const fraction = stamp[3] ? Number(stamp[3].padEnd(3, '0')) : 0
      lines.push({ at: minutes * 60_000 + seconds * 1000 + fraction, text })
    }
  }
  return lines.sort((a, b) => a.at - b.at)
}

/**
 * Turn line-synced lyrics into the TTML `<am-lyrics>` renders.
 *
 * LRCLIB gives us a timestamp per *line*; Apple's format wants one per
 * *word*, which is what produces the word-by-word sweep. We do not have that
 * data, so each line's words are spread across its duration in proportion to
 * their length — long words take longer, which is true often enough to look
 * right and is honest about what it is: an interpolation, not a transcript.
 *
 * Generating it here means the browser never calls a lyrics API itself: the
 * component is handed finished TTML and makes no network requests at all.
 */
export function toTtml(lines = [], { durationMs = null, title = null, artist = null } = {}) {
  if (!lines.length) return null

  const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const stamp = (ms) => {
    const total = Math.max(0, ms) / 1000
    const minutes = Math.floor(total / 60)
    const seconds = total - minutes * 60
    return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(3).padStart(6, '0')}`
  }

  const parts = ['<?xml version="1.0" encoding="UTF-8"?>']
  parts.push('<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyrics">')
  parts.push('  <body>')
  parts.push('    <div>')

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const text = String(line.text ?? '').trim()
    // An empty LRC line is an instrumental gap: it ends the line before it
    // rather than becoming a blank lyric.
    if (!text) continue

    const next = lines.slice(i + 1).find((entry) => String(entry.text ?? '').trim())
    const end = Math.min(next?.at ?? line.at + 4000, durationMs ?? Number.MAX_SAFE_INTEGER, line.at + 12_000)
    const span = Math.max(400, end - line.at)

    const words = text.split(/\s+/).filter(Boolean)
    const weight = words.reduce((sum, word) => sum + word.length + 1, 0) || 1

    parts.push(`      <p begin="${stamp(line.at)}" end="${stamp(line.at + span)}">`)
    let at = line.at
    for (const word of words) {
      const share = ((word.length + 1) / weight) * span
      parts.push(`        <span begin="${stamp(at)}" end="${stamp(at + share)}">${escape(word)}</span>`)
      at += share
    }
    parts.push('      </p>')
  }

  parts.push('    </div>')
  parts.push('  </body>')
  parts.push('</tt>')
  return parts.join('\n')
}

/** Which line is playing at `positionMs`, for a console that renders its own. */
export function lineAt(lines = [], positionMs = 0) {
  let index = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].at <= positionMs) index = i
    else break
  }
  return index
}

const key = (artist, title, duration) =>
  createHash('sha1').update(`${artist}|${title}|${Math.round((duration ?? 0) / 5)}`.toLowerCase()).digest('hex').slice(0, 20)

/** How close two durations are, in seconds — LRCLIB wants ±2 s. */
const near = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) <= 4

export class Lyrics {
  /** @param {{store?: object, ttlMs?: number, enabled?: boolean, timeoutMs?: number}} options */
  constructor({ store = null, ttlMs = 7 * 24 * 3600_000, enabled = true, timeoutMs = 6000 } = {}) {
    this.store = store
    this.ttlMs = ttlMs
    this.enabled = enabled !== false
    this.timeoutMs = timeoutMs
    this.memory = new Map() // id → record
    this.inflight = new Map()
    this.hits = 0
    this.misses = 0
  }

  #remember(id, record) {
    this.memory.set(id, record)
    // Keep the in-memory table small; SQLite is the real cache.
    if (this.memory.size > 256) this.memory.delete(this.memory.keys().next().value)
    try {
      this.store?.set?.(`lyrics:${id}`, { ...record, at: Date.now() })
    } catch (error) {
      log.debug(`could not cache lyrics: ${error.message}`)
    }
    return record
  }

  #cached(id) {
    const hot = this.memory.get(id)
    if (hot) return hot
    const stored = this.store?.get?.(`lyrics:${id}`)
    if (!stored) return null
    if (stored.at && Date.now() - stored.at > this.ttlMs) return null
    this.memory.set(id, stored)
    return stored
  }

  async #get(path) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${API}${path}`, {
        headers: { 'user-agent': AGENT, accept: 'application/json' },
        signal: controller.signal
      })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`lrclib ${res.status}`)
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Find lyrics for a track.
   *
   * @returns {Promise<{found: boolean, synced: boolean, lrc: string|null, plain: string|null,
   *   lines: Array<{at: number, text: string}>, provider: string, instrumental: boolean,
   *   artist: string, title: string, album: string|null, durationMs: number|null}>}
   */
  async find(track = {}) {
    const { artist, title } = splitArtistTitle(track)
    const durationSec = track.duration ? Math.round(track.duration / 1000) : null
    const id = key(artist, title, durationSec)

    const empty = {
      found: false,
      synced: false,
      lrc: null,
      ttml: null,
      plain: null,
      lines: [],
      provider: 'lrclib',
      instrumental: false,
      artist,
      title,
      album: track.album ?? null,
      durationMs: track.duration ?? null
    }

    if (!this.enabled || !title) return empty
    // A spoken ident or a live relay has no lyrics worth looking for.
    if (track.announcement || track.source === 'tts' || track.live) return empty

    const cached = this.#cached(id)
    if (cached) {
      this.hits += 1
      return { ...cached, cached: true }
    }
    if (this.inflight.has(id)) return this.inflight.get(id)

    const work = (async () => {
      this.misses += 1
      try {
        const params = new URLSearchParams({ artist_name: artist || title, track_name: title })
        if (track.album) params.set('album_name', track.album)
        if (durationSec) params.set('duration', String(durationSec))

        let hit = await this.#get(`/get?${params}`)

        // Second try without the parentheses: "Tears From The Moon (w/ …)"
        // is filed as "Tears From The Moon" almost everywhere.
        const bare = bareTitle(title)
        if (!hit && bare && bare.toLowerCase() !== title.toLowerCase()) {
          const retry = new URLSearchParams({ artist_name: artist || bare, track_name: bare })
          if (durationSec) retry.set('duration', String(durationSec))
          hit = await this.#get(`/get?${retry}`)
        }

        // Still nothing: search, then take the closest duration that has
        // synced words. A remix of the right length beats an exact title.
        if (!hit) {
          const results = (await this.#get(`/search?q=${encodeURIComponent(`${artist} ${bare || title}`.trim())}`)) ?? []
          const scored = results
            .filter((entry) => entry.syncedLyrics || entry.plainLyrics)
            .sort((a, b) => {
              const synced = Number(Boolean(b.syncedLyrics)) - Number(Boolean(a.syncedLyrics))
              if (synced !== 0) return synced
              if (durationSec) return Math.abs(a.duration - durationSec) - Math.abs(b.duration - durationSec)
              return 0
            })
          hit = scored.find((entry) => !durationSec || near(entry.duration, durationSec)) ?? scored[0] ?? null
        }

        if (!hit) return this.#remember(id, empty)

        const lrc = hit.syncedLyrics ?? null
        const record = {
          ...empty,
          found: Boolean(lrc || hit.plainLyrics || hit.instrumental),
          synced: Boolean(lrc),
          lrc,
          plain: hit.plainLyrics ?? null,
          lines: lrc ? parseLrc(lrc) : [],
          ttml: lrc ? toTtml(parseLrc(lrc), { durationMs: hit.duration ? hit.duration * 1000 : null }) : null,
          instrumental: Boolean(hit.instrumental),
          artist: hit.artistName ?? artist,
          title: hit.trackName ?? title,
          album: hit.albumName ?? track.album ?? null,
          durationMs: hit.duration ? Math.round(hit.duration * 1000) : (track.duration ?? null),
          lrclibId: hit.id ?? null
        }

        log.debug(`${record.synced ? 'synced' : record.found ? 'plain' : 'no'} lyrics for "${artist} — ${title}"`)
        return this.#remember(id, record)
      } catch (error) {
        // Lyrics are a nicety; a station never waits on them and never fails
        // because of them.
        log.debug(`lookup failed for "${artist} — ${title}": ${error.message}`)
        return empty
      } finally {
        this.inflight.delete(id)
      }
    })()

    this.inflight.set(id, work)
    return work
  }

  stats() {
    return { enabled: this.enabled, cached: this.memory.size, hits: this.hits, misses: this.misses, provider: 'lrclib' }
  }
}

export default Lyrics
