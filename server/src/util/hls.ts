/**
 * HLS — the other way a live stream arrives.
 *
 * Half the radio on the internet is no longer a single endless Icecast
 * socket: it is an `.m3u8` playlist that is re-fetched every few seconds,
 * listing short segments to download in order. This reads one, follows it
 * for as long as anybody is listening, and yields the segment bytes.
 *
 * It deliberately stops there. Turning AAC-in-MPEG-TS into MP3 is MetroS's
 * job (`util/metro.js`), and the station's job is to pace it; this file
 * knows about playlists, sequence numbers and discontinuities, nothing else.
 *
 * What it handles:
 *   • master playlists — picks a rendition by bandwidth (audio-only first)
 *   • live playlists — polls on `#EXT-X-TARGETDURATION`, tracks the media
 *     sequence so nothing is played twice and nothing is skipped
 *   • `#EXT-X-MAP` init segments — prepended to fMP4 segments so each one
 *     decodes on its own
 *   • VOD playlists — plays through once and ends (`#EXT-X-ENDLIST`)
 *   • redirects, relative URLs, gaps and 404s on individual segments
 */
import { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'

import createLogger from './logger.ts'

const log = createLogger('hls')

const AGENT = 'Livy/3 (+https://github.com/livy)'

/** Is this URL (or body) an HLS playlist? */
export function isHlsUrl(url = '') {
  return /\.m3u8(\?|#|$)/i.test(String(url))
}

export function isHlsBody(text = '') {
  return String(text).trimStart().startsWith('#EXTM3U')
}

/** Resolve a playlist line against the playlist's own URL. */
function absolute(base, line) {
  try {
    return new URL(line, base).toString()
  } catch {
    return line
  }
}

/**
 * Parse a playlist into something structured. One small function, because
 * the format is a line-oriented list of tags and URLs and nothing more.
 */
export function parsePlaylist(text, url) {
  const lines = String(text).split(/\r?\n/)
  const playlist = {
    master: false,
    variants: [],
    segments: [],
    targetDuration: 6,
    mediaSequence: 0,
    endList: false,
    map: null
  }

  let pending = null

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    if (!line.startsWith('#')) {
      if (playlist.master) {
        if (pending) {
          playlist.variants.push({ ...pending, url: absolute(url, line) })
          pending = null
        }
      } else {
        playlist.segments.push({
          url: absolute(url, line),
          duration: pending?.duration ?? playlist.targetDuration,
          discontinuity: pending?.discontinuity ?? false,
          map: playlist.map
        })
        pending = null
      }
      continue
    }

    const [tag, rest = ''] = line.slice(1).split(/:(.*)/s)
    switch (tag) {
      case 'EXT-X-STREAM-INF': {
        playlist.master = true
        const attrs = parseAttributes(rest)
        pending = {
          bandwidth: Number(attrs.BANDWIDTH ?? attrs['AVERAGE-BANDWIDTH'] ?? 0),
          codecs: attrs.CODECS ?? '',
          resolution: attrs.RESOLUTION ?? null
        }
        break
      }
      case 'EXT-X-MEDIA': {
        const attrs = parseAttributes(rest)
        // An audio rendition listed separately (common on TV-style feeds).
        if (attrs.TYPE === 'AUDIO' && attrs.URI) {
          playlist.master = true
          playlist.variants.push({
            bandwidth: 0,
            codecs: 'audio',
            audioOnly: true,
            name: attrs.NAME ?? 'audio',
            url: absolute(url, attrs.URI)
          })
        }
        break
      }
      case 'EXTINF':
        pending = { ...(pending ?? {}), duration: Number.parseFloat(rest) || 0 }
        break
      case 'EXT-X-TARGETDURATION':
        playlist.targetDuration = Number.parseFloat(rest) || 6
        break
      case 'EXT-X-MEDIA-SEQUENCE':
        playlist.mediaSequence = Number.parseInt(rest, 10) || 0
        break
      case 'EXT-X-DISCONTINUITY':
        pending = { ...(pending ?? {}), discontinuity: true }
        break
      case 'EXT-X-MAP': {
        const attrs = parseAttributes(rest)
        if (attrs.URI) playlist.map = absolute(url, attrs.URI)
        break
      }
      case 'EXT-X-ENDLIST':
        playlist.endList = true
        break
      default:
        break
    }
  }

  return playlist
}

/** `BANDWIDTH=128000,CODECS="mp4a.40.2"` → an object. */
function parseAttributes(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g
  let match
  while ((match = pattern.exec(text))) {
    out[match[1]] = match[2].replace(/^"|"$/g, '')
  }
  return out
}

async function fetchText(url, signal) {
  const res = await fetch(url, { headers: { 'user-agent': AGENT, accept: '*/*' }, signal, redirect: 'follow' })
  if (!res.ok) throw new Error(`playlist ${res.status} ${res.statusText}`)
  return { text: await res.text(), url: res.url || url }
}

async function fetchBytes(url, signal) {
  const res = await fetch(url, { headers: { 'user-agent': AGENT }, signal, redirect: 'follow' })
  if (!res.ok) throw new Error(`segment ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Choose a rendition. Audio-only first (a radio feed), then the *lowest*
 * bandwidth that is still audio: we are going to re-encode to a 128 kbps
 * MP3 anyway, so pulling a 5 Mbps video rendition would be silly.
 */
export function chooseVariant(variants, { maxBandwidth = 0 }: any = {}) {
  if (variants.length === 0) return null
  const audio = variants.filter((v) => v.audioOnly || /mp4a|opus|ec-3|ac-3/i.test(v.codecs))
  const pool = (audio.length ? audio : variants).filter((v) => !maxBandwidth || !v.bandwidth || v.bandwidth <= maxBandwidth)
  const candidates = pool.length ? pool : variants
  return candidates.slice().sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0))[0]
}

/**
 * Follow an HLS playlist and yield segment buffers in order.
 *
 * ```js
 * for await (const segment of hlsSegments(url, { signal })) transcoder.push(segment)
 * ```
 *
 * Live playlists never end on their own — stop by aborting the signal.
 */
export async function* hlsSegments(url, { signal, maxBandwidth = 0, onPlaylist }: any = {}) {
  let { text, url: resolved } = await fetchText(url, signal)
  let playlist = parsePlaylist(text, resolved)

  // A master playlist points at renditions; follow the one we want.
  if (playlist.master) {
    const variant = chooseVariant(playlist.variants, { maxBandwidth })
    if (!variant) throw new Error('master playlist has no usable rendition')
    log.debug(`variant: ${variant.codecs || 'audio'} ${variant.bandwidth || '?'} bps`)
    ;({ text, url: resolved } = await fetchText(variant.url, signal))
    playlist = parsePlaylist(text, resolved)
  }

  onPlaylist?.(playlist)

  let nextSequence = playlist.mediaSequence
  let lastMap = null
  let lastMapBytes = null
  let emptyPolls = 0

  while (!signal?.aborted) {
    const first = playlist.mediaSequence
    let sequence = first
    let aired = 0

    for (const segment of playlist.segments) {
      if (sequence >= nextSequence) {
        try {
          let bytes = await fetchBytes(segment.url, signal)

          // fMP4: the init segment has to lead every decode, and it only
          // changes at a discontinuity, so cache its bytes across segments.
          if (segment.map) {
            if (segment.map !== lastMap || !lastMapBytes) {
              lastMapBytes = await fetchBytes(segment.map, signal)
              lastMap = segment.map
            }
            bytes = Buffer.concat([lastMapBytes, bytes])
          }

          yield bytes
          aired += 1
        } catch (error) {
          if (signal?.aborted) return
          log.debug(`segment skipped: ${error.message}`)
        }
        nextSequence = sequence + 1
      }
      sequence += 1
    }

    if (playlist.endList) return // VOD: played to the end

    // Live: re-fetch on the target duration, which is how often the server
    // promises a new segment. Back off a little when nothing is appearing.
    emptyPolls = aired > 0 ? 0 : emptyPolls + 1
    const wait = Math.min(playlist.targetDuration * 1000 * (aired > 0 ? 0.5 : 1), 10_000) + Math.min(emptyPolls, 3) * 500
    await sleep(wait, undefined, { signal }).catch(() => {})
    if (signal?.aborted) return

    try {
      const next = await fetchText(resolved, signal)
      playlist = parsePlaylist(next.text, next.url)
      // The window slid past us (we were too slow, or the stream restarted).
      if (playlist.mediaSequence > nextSequence) {
        log.debug(`playlist jumped ${nextSequence} → ${playlist.mediaSequence}; catching up`)
        nextSequence = playlist.mediaSequence
      }
    } catch (error) {
      if (signal?.aborted) return
      log.warn(`playlist refresh failed: ${error.message}`)
      await sleep(2000, undefined, { signal }).catch(() => {})
    }
  }
}

/** A Node stream of the segments, for code that wants to pipe. */
export function hlsStream(url, options: any = {}) {
  return Readable.from(hlsSegments(url, options))
}

export default { hlsSegments, hlsStream, parsePlaylist, isHlsUrl, isHlsBody, chooseVariant }
