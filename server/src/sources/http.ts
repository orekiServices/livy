/**
 * Direct HTTP source: a plain audio file, a live Icecast/Shoutcast stream
 * (an endless "track" with live ICY metadata) or an HLS playlist.
 *
 * Since MetroS can decode, "audio" here is no longer only MP3: AAC, Ogg,
 * FLAC, MP4 and HLS/MPEG-TS all resolve, and the station transcodes them on
 * the way to the pacer.
 */
import { createHash } from 'node:crypto'
import { connectStream, IcyDeinterleaver, parseIcyMetadata } from '../util/icyClient.ts'
import { resolveStreamUrl } from '../util/playlist.ts'
import { isHlsUrl } from '../util/hls.ts'

/** Extensions we can play directly (no decoding). */
const PASSTHROUGH = /\.mp3(\?|$)/i
/** Extensions MetroS has to decode first. */
const DECODABLE = /\.(aac|m4a|mp4|ogg|oga|opus|flac|wav|aiff?|weba|webm|mka)(\?|$)/i

export class HttpSource {
  name = 'http'

  canResolve(query) {
    return /^https?:\/\//i.test(String(query).trim())
  }

  async resolve(query) {
    const url = String(query).trim()
    // .m3u/.pls point at a stream; .m3u8 *is* the stream (HLS) and must not
    // be unwrapped here.
    const { url: resolved } = isHlsUrl(url) ? { url } : await resolveStreamUrl(url)
    const name = decodeURIComponent(resolved.split('/').pop()?.split('?')[0] ?? 'stream').replace(
      /\.(mp3|aac|m4a|ogg|oga|opus|flac|wav|m3u8)$/i,
      ''
    )
    // A path of "/stream" or "/;listen" is a mount point, not a title.
    const title = name && !/^[;.]|^(stream|listen|live|radio)$/i.test(name) ? name : new URL(resolved).hostname

    const hls = isHlsUrl(resolved)
    const decodable = DECODABLE.test(resolved)

    return {
      type: 'track',
      name,
      tracks: [
        {
          source: 'http',
          id: `http:${createHash('sha1').update(resolved).digest('hex').slice(0, 16)}`,
          title,
          artist: new URL(resolved).hostname,
          duration: 0, // unknown / endless
          artwork: null,
          url: resolved,
          format: hls ? 'hls' : decodable ? resolved.split('.').pop()?.split('?')[0]?.toLowerCase() : 'mp3',
          // A playlist or a codec we have to decode: MetroS handles both.
          transcode: hls || decodable,
          live: hls || /\.(m3u|pls)$/i.test(url) || !PASSTHROUGH.test(resolved),
          streamable: true
        }
      ]
    }
  }

  getTrackUrl(track) {
    // HLS is a playlist a browser can play natively; a live ICY socket cannot
    // be handed to an <audio> tag, so only the playlist case answers.
    return track.format === 'hls' || isHlsUrl(track.url) ? track.url : null
  }

  async stream(track, { onMetadata, signal }: any = {}) {
    // HLS is a playlist, not a socket: hand the URL back and let the station
    // follow it segment by segment.
    if (track.format === 'hls' || isHlsUrl(track.url)) {
      return { url: track.url, hls: true, transcode: true, contentType: 'application/vnd.apple.mpegurl', mode: 'hls' }
    }

    const res = await connectStream(track.url, { metadata: true, timeout: 12_000, signal })
    const metaint = res.headers['icy-metaint'] ? Number(res.headers['icy-metaint']) : 0

    const contentType = res.headers['content-type'] ?? 'audio/mpeg'
    if (/text\/html|application\/json/i.test(contentType)) {
      res.body.destroy?.()
      throw new Error(`that URL is a web page, not audio (${contentType})`)
    }
    // Trust the header when it says something other than MP3 — and keep
    // trusting the bytes: MetroS sniffs the stream anyway.
    const transcode = Boolean(track.transcode) || !/mpeg|mp3/i.test(contentType)

    if (!metaint) return { stream: res.body, contentType, transcode, mode: 'http' }

    const de = new IcyDeinterleaver(metaint)
    de.on('metadata', (raw) => {
      const title = parseIcyMetadata(raw).StreamTitle
      if (title && onMetadata) onMetadata(title)
    })
    res.body.on('error', (error) => de.destroy(error))
    return { stream: res.body.pipe(de), contentType, transcode, mode: 'icy' }
  }
}

export default HttpSource
