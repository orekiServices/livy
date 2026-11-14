/**
 * Station directories hand out .pls / .m3u / .m3u8 / .asx files instead of raw
 * streams. This resolves such a URL down to a playable audio endpoint.
 */
import { connectStream } from './icyClient.ts'

const PLAYLIST_EXT = /\.(pls|m3u|m3u8|asx|xspf)(\?|$)/i
const PLAYLIST_MIME =
  /(audio\/x-scpls|audio\/x-mpegurl|audio\/mpegurl|application\/x-mpegurl|application\/pls|video\/x-ms-asf|application\/xspf)/i

function looksLikePlaylistUrl(url) {
  return PLAYLIST_EXT.test(url)
}

function extractEntries(text, contentType = '') {
  const urls = []

  if (/x-scpls|\[playlist\]/i.test(`${contentType}\n${text.slice(0, 200)}`)) {
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*File\d*\s*=\s*(.+)$/i.exec(line)
      if (m) urls.push(m[1].trim())
    }
  }

  if (urls.length === 0 && /<(asx|entry|ref|track|location)/i.test(text)) {
    const re = /(?:href|HREF)\s*=\s*"([^"]+)"|<location>\s*([^<\s]+)\s*<\/location>/g
    let m
    while ((m = re.exec(text)) !== null) urls.push((m[1] ?? m[2]).trim())
  }

  if (urls.length === 0) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      urls.push(trimmed)
    }
  }

  return urls.filter((u) => /^https?:\/\//i.test(u) || /^icecast|^icy/i.test(u))
}

async function readSome(body, maxBytes = 64 * 1024, maxMs = 8000) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    const done = () => {
      clearTimeout(timer)
      body.destroy()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const timer = setTimeout(done, maxMs)
    body.on('data', (chunk) => {
      chunks.push(chunk)
      size += chunk.length
      if (size >= maxBytes) done()
    })
    body.once('end', done)
    body.once('error', done)
  })
}

/**
 * @returns {Promise<{url: string, playlist: boolean, entries: string[]}>}
 */
export async function resolveStreamUrl(url, { depth = 0, maxDepth = 3, timeout = 10_000 }: any = {}) {
  if (depth >= maxDepth) return { url, playlist: false, entries: [] }

  // Only pay for a probe request when it smells like a playlist.
  if (!looksLikePlaylistUrl(url)) {
    return { url, playlist: false, entries: [] }
  }

  const res = await connectStream(url, { metadata: false, timeout })
  const contentType = res.headers['content-type'] ?? ''

  if (!PLAYLIST_MIME.test(contentType) && !looksLikePlaylistUrl(res.url)) {
    res.body.destroy()
    return { url: res.url, playlist: false, entries: [] }
  }

  const text = await readSome(res.body)
  const entries = extractEntries(text, contentType)
  if (entries.length === 0) return { url: res.url, playlist: true, entries: [] }

  const first = new URL(entries[0], res.url).toString()
  const nested = await resolveStreamUrl(first, { depth: depth + 1, maxDepth, timeout })
  return { url: nested.url, playlist: true, entries }
}

export default { resolveStreamUrl }
