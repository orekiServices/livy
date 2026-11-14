/**
 * Song.link → a real platform.
 *
 * A `song.link` (or `album.link`, `odesli.co`) URL is a *promise of a
 * recording*, not audio: it is Odesli's universal resolver, the thing Spotify
 * and Apple Music share to say "here is that song everywhere else". What
 * makes it useful to a radio node is the exact opposite of what makes it
 * useful to a listener — the page lists where the same track exists, and one
 * of those places is a provider that will actually stream it.
 *
 * How NodeLink does it, and why this does not: NodeLink sends the link to
 * Odesli's key-free API when one is available and otherwise scrapes the
 * page's Next.js `pageData` blob. The scrape is the interesting one, because
 * Odesli rate-limits anonymous API callers hard. Both are implemented here:
 *
 *   1. `api.song.link/v1-alpha.1/links?url=…` (or with a key, if configured),
 *   2. the page's own embedded JSON, read without executing any JavaScript.
 *
 * The resulting *platform links* are handed to the `mirror` source, which
 * turns a Spotify/Apple link into metadata and then into a playable clone —
 * so a Song.link URL picks up the whole existing mirror machinery instead of
 * reimplementing it.
 *
 *   https://song.link/s/4eoOQgFQ0rLMKNP8KcUNWc
 *   https://album.link/i/1440833098
 *   songlink:<artist> <title>
 */
import createLogger from '../util/logger.ts'

const log = createLogger('src:songlink')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const API = 'https://api.song.link/v1-alpha.1/links'

/** Hosts that *are* a Song.link link. */
const LINK_HOSTS = /^https?:\/\/(?:www\.)?(song\.link|album\.link|artist\.link|pods\.link|odesli\.co)\//i

/**
 * Platform key → the URL that platform's own resolver understands.
 *
 * Only the platforms `mirror` or the registry can actually play are listed:
 * a Tidal link is useful, a Pandora link is not.
 */
const PLAYABLE_PLATFORMS = {
  spotify: (id) => `https://open.spotify.com/track/${id}`,
  itunes: (id) => `https://music.apple.com/us/song/${id}`,
  appleMusic: (id) => `https://music.apple.com/us/song/${id}`,
  youtube: (id) => `https://www.youtube.com/watch?v=${id}`,
  youtubeMusic: (id) => `https://music.youtube.com/watch?v=${id}`,
  deezer: (id) => `https://www.deezer.com/track/${id}`,
  tidal: (id) => `https://tidal.com/browse/track/${id}`,
  soundcloud: (id) => `https://soundcloud.com/${id}`,
  audius: (id) => `https://audius.co/${id}`,
  bandcamp: (id) => id,
  amazonMusic: (id) => `https://music.amazon.com/tracks/${id}`
}

const bestOf = (links: any = {}) => {
  for (const platform of Object.keys(PLAYABLE_PLATFORMS)) {
    const entry = links[platform]
    const url = typeof entry === 'string' ? entry : entry?.url
    if (url) return { platform, url }
  }
  return null
}

export class SongLinkSource {
  declare apiKey: any
  declare mirror: any
  declare resolveUrl: any

  name = 'songlink'
  prefixes = ['songlink:', 'songlinksearch:', 'slsearch:']
  /** Nothing here can be played directly: resolve() returns mirrored tracks. */
  metadataOnly = true

  constructor({ mirror = null, resolve = null, apiKey = null }: any = {}) {
    this.mirror = mirror
    this.resolveUrl = resolve
    this.apiKey = apiKey
  }

  canResolve(query) {
    const q = String(query).trim()
    return this.prefixes.some((p) => q.toLowerCase().startsWith(p)) || LINK_HOSTS.test(q)
  }

  /* ---------------------------- metadata ---------------------------- */

  /**
   * The API first (it is authoritative and cheap), the page as the fallback
   * for when anonymous API access is rate-limited.
   */
  async resolveLink(url) {
    const fromApi = await this.#viaApi(url)
    if (fromApi) return fromApi
    const fromPage = await this.#viaPage(url)
    if (fromPage) return fromPage
    throw new Error('Song.link did not describe that link')
  }

  async #viaApi(url) {
    try {
      const api = new URL(API)
      api.searchParams.set('url', url)
      api.searchParams.set('userCountry', 'US')
      if (this.apiKey) api.searchParams.set('key', this.apiKey)

      const res = await fetch(api, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(12_000) })
      if (!res.ok) return null
      const data = await res.json()
      const links = data.linksByPlatform ?? {}
      const entity = data.entitiesByUniqueId?.[data.entityUniqueId] ?? {}

      const best = bestOf(links)
      if (!best) return null

      return {
        title: entity.title ?? null,
        artist: entity.artistName ?? null,
        artwork: entity.thumbnailUrl ?? null,
        isrc: entity.isrc ?? null,
        links
      }
    } catch (error) {
      log.debug(`api lookup failed: ${error.message}`)
      return null
    }
  }

  /**
   * Read the Next.js `pageData` blob out of the page without executing it.
   * The shape is `props.pageProps.pageData.sections[].links[]`.
   */
  async #viaPage(url) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000), redirect: 'follow' })
      if (!res.ok) throw new Error(`song.link ${res.status}`)
      const html = await res.text()

      const data = pageDataFrom(html)
      if (!data) throw new Error('no page data')

      // The page lists links as an array of `{ platform, url }`; keep them
      // flat and let `platformLinks` order them.
      const links = (data.sections ?? [])
        .flatMap((section) => section?.links ?? [])
        .filter((link) => link?.platform && link?.url && link.show !== false)

      const entity = data.entitiesByUniqueId?.[data.entityUniqueId] ?? {}
      if (links.length === 0 && !entity.title) return null

      return {
        title: entity.title ?? null,
        artist: entity.artistName ?? null,
        artwork: entity.thumbnailUrl ?? null,
        isrc: entity.isrc ?? null,
        links
      }
    } catch (error) {
      log.debug(`page lookup failed: ${error.message}`)
      return null
    }
  }

  /* --------------------------- resolving ---------------------------- */

  /**
   * A Song.link URL → playable tracks.
   *
   * The platform links are handed to `mirror` one at a time, best first, so
   * that "Spotify version unavailable" still leaves the Apple Music and
   * YouTube versions to try.
   */
  async resolve(query, { limit = 5 }: any = {}) {
    let q = String(query).trim()
    for (const p of this.prefixes) if (q.toLowerCase().startsWith(p)) q = q.slice(p.length).trim()

    // `songlink:<artist> <title>` has no link to read; it is a search.
    if (!/^https?:\/\//i.test(q)) {
      const tracks = await this.search(q, limit)
      if (!tracks.length) throw new Error(`Nothing playable for "${q}"`)
      return { type: 'search', name: q, tracks }
    }

    const meta = await this.resolveLink(q)
    if (!this.resolveUrl && !this.mirror) throw new Error('songlink needs a resolver or mirror source to play anything')

    const candidates = platformLinks(meta.links)
    const errors = []
    const tracks = []

    for (const { platform, url } of candidates) {
      if (LINK_HOSTS.test(url)) continue
      try {
        const remaining = Math.max(1, limit - tracks.length)
        // Prefer direct resolution through the registry (so SoundCloud,
        // Bandcamp, Audius links play natively instead of failing in mirror);
        // fall back to `mirror` when standalone or when a URL isn't directly playable.
        let resolved = null
        if (this.resolveUrl) {
          try {
            resolved = await this.resolveUrl(url, { limit: remaining })
          } catch (directError) {
            if (this.mirror?.canResolve?.(url)) resolved = await this.mirror.resolve(url, { limit: remaining })
            else throw directError
          }
        } else {
          resolved = await this.mirror.resolve(url, { limit: remaining })
        }
        for (const track of resolved?.tracks ?? []) {
          if (track.streamable === false) continue
          // The authoritative answer from Odesli stays on the track, so the
          // station announces the right song even when the clone's title is
          // decorated.
          tracks.push({
            ...track,
            title: meta.title ?? track.title,
            artist: meta.artist ?? track.artist,
            artwork: track.artwork ?? meta.artwork,
            isrc: track.isrc ?? meta.isrc,
            mirroredFrom: `song.link → ${platform}`
          })
        }
      } catch (error) {
        errors.push(`${platform}: ${error.message}`)
      }
      if (tracks.length >= limit) break
    }

    if (tracks.length === 0) {
      throw new Error(`Song.link knew the recording but nothing would play it${errors.length ? ` → ${errors.join(' | ')}` : ''}`)
    }

    // One row per provider is enough; anything else is a duplicate.
    const seen = new Set()
    return {
      type: 'track',
      name: tracks[0].title,
      mirroredFrom: 'song.link',
      tracks: tracks.filter((track) => {
        const key = `${track.source}:${track.id}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }).slice(0, limit)
    }
  }

  /**
   * `songlink:<artist> <title>` — find the recording through iTunes (key-free),
   * then let `resolve()` mirror it like any other Song.link link.
   */
  async search(term, limit = 5) {
    const data = await itunesLookup(term)
    if (!data) return []
    return (await this.resolve(`https://song.link/i/${data.trackId}`, { limit })).tracks
  }
}

/* ------------------------------ helpers ------------------------------ */

/**
 * Song.link's page JSON, however deeply it is escape-quoted.
 *
 * The page embeds its state as a JSON *string* inside a JSON payload inside a
 * `<script>`, so by the time it reaches us the quotes are `\"` and the
 * backslashes are doubled. Rather than guess at a regex, this finds the
 * `pageData` key, scans to the matching brace (string-aware), and then tries
 * the object both as it stands and after undoing one level of escaping.
 */
export function pageDataFrom(html) {
  // Two very different containers hold the same object:
  //   • a plain `<script type="application/json">` blob, where it is literal;
  //   • a `self.__next_f.push([1, "…"])` chunk, where the whole JSON document
  //     is *a string* inside a string, so every quote is `\"` (or `\\\"`).
  //
  // The reliable way to handle both is to peel the escaping off the script
  // body first and only then look for the object — scanning braces through a
  // wall of backslashes cannot tell a structural brace from a quoted one.
  for (const body of scriptBodies(html)) {
    let text = body
    for (let depth = 0; depth < 5; depth += 1) {
      const found = findPageData(text)
      if (found) return found
      const next = unescapeJsonText(text)
      if (next === text) break
      text = next
    }
  }
  return null
}

/** The text of every `<script>` in the page, plus the whole page itself. */
function* scriptBodies(html) {
  yield html
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) yield match[1]
}

/** Find a `pageData` object in already-decoded text. */
function findPageData(text) {
  const at = text.indexOf('"pageData"')
  if (at === -1) return null
  const open = text.indexOf('{', at)
  if (open === -1) return null
  const body = sliceObject(text, open)
  if (!body) return null

  const parsed = tryParse(body)
  if (!parsed) return null
  const data = parsed.pageData ?? parsed
  if (data.sections || data.entitiesByUniqueId) return data
  return null
}

/** JSON.parse, following one level of "the value is itself a JSON string". */
function tryParse(text) {
  try {
    let value = JSON.parse(text)
    if (typeof value === 'string') value = JSON.parse(value)
    return value ?? null
  } catch {
    return null
  }
}

/** The balanced `{…}` starting at `start`, ignoring braces inside strings. */
function sliceObject(text, start) {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (char === '"') {
        let backslashes = 0
        for (let j = i - 1; j >= start && text[j] === '\\'; j -= 1) backslashes += 1
        if (backslashes % 2 === 0) inString = false
      }
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** Undo one level of JavaScript string escaping. */
function unescapeJsonText(text) {
  return text.replace(/\\(["\\/bfnrt])/g, (_, char) =>
    ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[char]
  )
}

/** Song.link nests links as `{ url }` or strings; flatten to strings. */
const flatLinks = (links: any = {}): Record<string, string> =>
  Object.fromEntries(
    Object.entries(links as Record<string, any>)
      .map(([platform, value]) => [platform, typeof value === 'string' ? value : value?.url])
      .filter(([, url]) => Boolean(url))
  )

/**
 * The candidate platform URLs in a useful order.
 *
 * Playability first: a SoundCloud or Bandcamp link is a stream, a Spotify
 * link is metadata that has to be mirrored. Deezer is last among the
 * metadata sources because its ISRC is the only thing worth keeping.
 */
const ORDER = ['soundcloud', 'bandcamp', 'audius', 'youtube', 'youtubeMusic', 'spotify', 'appleMusic', 'itunes', 'deezer', 'tidal', 'amazonMusic']

export function platformLinks(links: any = {}) {
  // Two shapes reach this function: the API's `{ platform: { url } }` map and
  // the page's `[{ platform, url }]` array. Normalise both.
  const flat = Array.isArray(links)
    ? Object.fromEntries(links.filter((link) => link?.platform && link?.url).map((link) => [link.platform, link.url]))
    : flatLinks(links)

  const out = []
  for (const platform of ORDER) {
    const url = flat[platform]
    if (url) out.push({ platform, url })
  }
  // Anything Odesli knows that is not in ORDER is still worth trying, as long
  // as it looks like a link rather than an app URI.
  for (const [platform, url] of Object.entries(flat as Record<string, string>)) {
    if (ORDER.includes(platform) || !/^https?:/i.test(url)) continue
    out.push({ platform, url })
  }
  return out
}

/** iTunes search: title/artist → the exact track id (used by search()). */
async function itunesLookup(term) {
  try {
    const url = new URL('https://itunes.apple.com/search')
    url.searchParams.set('term', term)
    url.searchParams.set('entity', 'song')
    url.searchParams.set('limit', '1')
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    return (await res.json())?.results?.[0] ?? null
  } catch {
    return null
  }
}

export default SongLinkSource
