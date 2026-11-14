/**
 * Lyrics — words, in time, for whatever is on air.
 *
 * The console shows Apple-Music-style word-synced lyrics with the
 * `<am-lyrics>` web component. That component can fetch lyrics itself, but
 * Livy fetches them **here**, on the server, for three reasons:
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
const AGENT = 'Livy/3 (https://github.com/livy)'

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
 * The tuning the file asks for: `[offset:+250]` means the words are a quarter
 * of a second late in the timestamps and should be shown 250 ms earlier.
 *
 * Real LRC files carry it — hand-tuned lyric files almost always do — and
 * ignoring it is the difference between lyrics that sit on the beat and lyrics
 * that are visibly a line behind for the whole song.
 */
export function lrcOffset(lrc = '') {
  const match = String(lrc).match(/\[offset:\s*([+-]?\d+)\]/i)
  if (!match) return 0
  const value = Number(match[1])
  return Number.isFinite(value) ? value : 0
}

/**
 * Parse an LRC into lines the UI can scroll.
 * `[00:12.34] words` → `{ at: 12340, text: 'words' }`, in order.
 *
 * `[offset:…]` is applied (and clamped at zero, because a negative timestamp is
 * not a time). `[ar:]`, `[ti:]` and the other ID tags are not times and are
 * skipped by the timestamp match itself.
 */
export function parseLrc(lrc = '') {
  const offset = lrcOffset(lrc)
  const lines = []
  for (const raw of String(lrc).split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)]
    if (stamps.length === 0) continue
    const text = raw.replace(/\[[^\]]*\]/g, '').trim()
    for (const stamp of stamps) {
      const minutes = Number(stamp[1])
      const seconds = Number(stamp[2])
      const fraction = stamp[3] ? Number(stamp[3].padEnd(3, '0')) : 0
      lines.push({ at: Math.max(0, minutes * 60_000 + seconds * 1000 + fraction - offset), text })
    }
  }
  return lines.sort((a, b) => a.at - b.at)
}

/**
 * Do two titles name the same song?
 *
 * Used to refuse a search result: LRCLIB's search happily returns a different
 * song by the same artist, and handing a listener the wrong words is worse
 * than handing them none. Normalised equality on the *bare* title (both sides
 * stripped of brackets and `feat.`), so "Song (Remastered)" still matches.
 */
export function titlesMatch(a = '', b = '') {
  const left = bareTitle(a)
  const right = bareTitle(b)
  if (!left || !right) return false
  return left === right
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
    // The line keeps the whole slot to the next one — that is what keeps it
    // lit on screen through the pause. The *words* inside it do not: LRC has
    // no word timings, so tiling the slot proportionally smeared a three-word
    // line across ten seconds when the singer simply stopped. Words get a
    // sane share of the slot and the rest of it is silence.
    const span = Math.max(400, end - line.at)
    const spoken = Math.min(span, Math.max(800, text.length * 45))

    const words = text.split(/\s+/).filter(Boolean)
    const weight = words.reduce((sum, word) => sum + word.length + 1, 0) || 1

    parts.push(`      <p begin="${stamp(line.at)}" end="${stamp(line.at + span)}">`)
    let at = line.at
    for (const word of words) {
      const share = ((word.length + 1) / weight) * spoken
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
  constructor({ store = null, ttlMs = 7 * 24 * 3600_000, missTtlMs = 6 * 3600_000, enabled = true, timeoutMs = 6000 } = {}) {
    this.store = store
    this.ttlMs = ttlMs
    // A miss is a fact about *now*, not a fact about the song: lyrics get added
    // to LRCLIB constantly, and a week-long negative cache means a song that
    // appears on Tuesday still shows nothing on Sunday.
    this.missTtlMs = missTtlMs
    this.enabled = enabled !== false
    this.timeoutMs = timeoutMs
    this.memory = new Map() // id → record
    this.inflight = new Map()
    this.hits = 0
    this.misses = 0
  }

  #remember(id, record) {
    // Both caches need the timestamp: it is what makes a miss expire sooner
    // than a hit, and a record without one never goes stale.
    const entry = { ...record, at: Date.now() }
    this.memory.set(id, entry)
    // Keep the in-memory table small; SQLite is the real cache.
    if (this.memory.size > 256) this.memory.delete(this.memory.keys().next().value)
    try {
      this.store?.set?.(`lyrics:${id}`, entry)
    } catch (error) {
      log.debug(`could not cache lyrics: ${error.message}`)
    }
    return entry
  }

  #cached(id) {
    const fresh = (record) => {
      if (!record?.at) return true
      const ttl = record.found === false ? this.missTtlMs : this.ttlMs
      // `<` and not `<=`: a TTL of zero means "do not cache this", which is how
      // a node that wants to retry a miss on the very next play configures it.
      return Date.now() - record.at < ttl
    }
    const hot = this.memory.get(id)
    if (hot) return fresh(hot) ? hot : (this.memory.delete(id), null)
    const stored = this.store?.get?.(`lyrics:${id}`)
    if (!stored) return null
    if (!fresh(stored)) return null
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
      offsetMs: 0,
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

        // Third try without a duration: `/get` only answers within ±2 s of the
        // number it was given, and the duration we have came from a provider's
        // metadata, not from the recording. The commonest reason for "no
        // lyrics for a song that obviously has them" was a duration that was
        // three seconds out.
        if (!hit && durationSec) {
          const loose = new URLSearchParams({ artist_name: artist || title, track_name: title })
          if (track.album) loose.set('album_name', track.album)
          hit = await this.#get(`/get?${loose}`)
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
          // Right length, or — when the lengths disagree, which they often do —
          // the exact same title. Never merely "the first result": a listener
          // reading another song's words is worse than reading none.
          // Right length when there is a length to compare, otherwise the exact
          // same title. Never merely "the first result": a listener reading
          // another song's words is worse than reading none.
          const sameLength = durationSec ? scored.find((entry) => near(entry.duration, durationSec)) : null
          hit = sameLength ?? scored.find((entry) => titlesMatch(entry.trackName, bare || title)) ?? null
        }

        if (!hit) return this.#remember(id, empty)

        const lrc = hit.syncedLyrics ?? null
        // Parsed once: the lines, the offset and the TTML all come from the
        // same reading of the file.
        const lines = lrc ? parseLrc(lrc) : []
        const record = {
          ...empty,
          found: Boolean(lrc || hit.plainLyrics || hit.instrumental),
          synced: Boolean(lrc),
          lrc,
          plain: hit.plainLyrics ?? null,
          lines,
          offsetMs: lrc ? lrcOffset(lrc) : 0,
          ttml: lines.length ? toTtml(lines, { durationMs: hit.duration ? hit.duration * 1000 : null }) : null,
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
