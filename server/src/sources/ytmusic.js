/**
 * YouTube Music — the best catalogue on the internet, used as a *card index*.
 *
 * YouTube Music knows what a song is called, who is on it, which album it
 * came from and how long it runs, for essentially every recording ever
 * released. What it will not do is hand a radio station the audio: playback
 * now needs a signed player token, and building one is both fragile and
 * rude.
 *
 * So this source does what NodeLink's `spotify`/`ytmusic` resolvers do for
 * anything they cannot stream — it resolves *metadata*, and hands the
 * result to the registry, which finds a copy on a provider that genuinely
 * serves audio (SoundCloud, Audius, archive.org…). A listener searching
 * "get lucky" gets the right song with the right title, artist and artwork,
 * playing from somewhere that is happy to be played.
 *
 *   ytm:daft punk get lucky
 *   ytmsearch:lofi beats
 *   https://music.youtube.com/watch?v=5NV6Rdv1a3I
 *
 * No key, no account: the same InnerTube search endpoint the web player
 * uses, with its public WEB_REMIX client.
 */
import createLogger from '../util/logger.js'

const log = createLogger('src:ytmusic')

const ENDPOINT = 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
/** "songs only", so albums, videos and playlists stay out of the results. */
const SONGS_ONLY = 'EgWKAQIIAWoKEAoQCRADEAQQBQ%3D%3D'
/** WEB_REMIX answers in this shape; the version matters more than the date. */
const CLIENT = { clientName: 'WEB_REMIX', clientVersion: '1.20240101.01.00', hl: 'en', gl: 'US' }

/** Pull every `text` leaf out of a renderer, in order. */
function texts(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) texts(item, out)
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'text' && typeof value === 'string') out.push(value)
      else if (key === 'simpleText' && typeof value === 'string') out.push(value)
      else texts(value, out)
    }
  }
  return out
}

/** Find every node with a given key, however deep. */
function collect(node, key, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, key, out)
  } else if (node && typeof node === 'object') {
    for (const [name, value] of Object.entries(node)) {
      if (name === key) out.push(value)
      collect(value, key, out)
    }
  }
  return out
}

const isDuration = (value) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(value)

const durationMs = (value) => {
  const parts = value.split(':').map(Number)
  const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]
  return seconds * 1000
}

/** The best artwork YouTube offers for a result. */
function artworkOf(renderer) {
  const thumbs = collect(renderer, 'thumbnails').flat()
  if (!thumbs.length) return null
  const best = thumbs
    .filter((thumb) => thumb?.url)
    .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0]
  // The URL carries its own size; ask for something a phone can use.
  return best?.url?.replace(/=w\d+-h\d+/, '=w544-h544') ?? null
}

/**
 * One result row → a track, or null.
 *
 * The row's flex columns are [title, "Artist • Album • Duration"], but the
 * separators are their own runs, so the filtered text list is
 * [title, artist, album?, duration?]. Anything that does not look like a song
 * (a video, a playlist row) is dropped rather than guessed at.
 */
function trackFrom(row) {
  const fields = texts(row).filter((value) => value.trim() && !/^[•·,]+\s*$/.test(value.trim()))
  if (fields.length < 2) return null

  const videoId = collect(row, 'videoId')[0] ?? null
  const durationField = fields.find(isDuration)
  const title = fields[0]
  const artist = fields[1] === title ? fields[2] : fields[1]
  if (!title || !artist) return null

  const between = fields.slice(2, durationField ? fields.indexOf(durationField) : undefined)
  return {
    source: 'ytmusic',
    id: videoId ? `ytmusic:${videoId}` : `ytmusic:${title}:${artist}`.toLowerCase(),
    title,
    artist,
    album: between.find((value) => value !== 'Song' && value !== 'Video') ?? null,
    duration: durationField ? durationMs(durationField) : 0,
    artwork: artworkOf(row),
    link: videoId ? `https://music.youtube.com/watch?v=${videoId}` : null,
    // The catalogue knows the song; somebody else has to play it.
    streamable: false,
    metadataOnly: true,
    query: `${artist} ${title}`
  }
}

export class YtMusicSource {
  name = 'ytmusic'
  prefixes = ['ytm:', 'ytmsearch:', 'ytmusic:']

  /**
   * @param {object} deps
   * @param {Function} deps.search     the registry's search, for mirroring
   * @param {Function} deps.similarity title/artist similarity scorer
   */
  constructor({ search = null, similarity = null, fetchImpl = fetch } = {}) {
    this.searchAll = search
    this.similarity = similarity
    this.fetch = fetchImpl
  }

  canResolve(query) {
    const q = String(query).trim().toLowerCase()
    return this.prefixes.some((prefix) => q.startsWith(prefix)) || /music\.youtube\.com\//.test(q)
  }

  #term(query) {
    let term = String(query).trim()
    for (const prefix of this.prefixes) {
      if (term.toLowerCase().startsWith(prefix)) term = term.slice(prefix.length).trim()
    }
    // A pasted watch link is useless as a search term. The title of the
    // video is public through oEmbed, so read it rather than searching "v=".
    return term
  }

  /** The watch id inside a pasted link, if that is what this is. */
  #videoId(query) {
    const q = String(query).trim()
    return /[?&]v=([\w-]{6,})/.exec(q)?.[1] ?? /youtu\.be\/([\w-]{6,})/.exec(q)?.[1] ?? null
  }

  /** Ask oEmbed what a pasted video is called. Key-free and public. */
  async #titleOfLink(query) {
    const id = this.#videoId(query)
    if (!id) return null
    try {
      const res = await this.fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`, {
        headers: { 'user-agent': UA }
      })
      if (!res.ok) return null
      const data = await res.json()
      return { id, title: data.title, artist: data.author_name }
    } catch {
      return null
    }
  }

  /** Ask InnerTube. Returns tracks with metadata but no audio. */
  async search(query, limit = 10) {
    const term = this.#term(query)
    if (!term) return []

    let payload
    try {
      const res = await this.fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': UA, origin: 'https://music.youtube.com' },
        body: JSON.stringify({ query: term, params: SONGS_ONLY, context: { client: CLIENT } }),
        signal: AbortSignal.timeout(12_000)
      })
      if (!res.ok) throw new Error(`innertube ${res.status}`)
      payload = await res.json()
    } catch (error) {
      log.debug(`search failed: ${error.message}`)
      return []
    }

    const rows = collect(payload, 'musicResponsiveListItemRenderer')
    const tracks = []
    for (const row of rows.slice(0, limit * 2)) {
      const track = trackFrom(row)
      if (!track) continue
      tracks.push(track)
      if (tracks.length >= limit) break
    }
    return tracks
  }

  /**
   * Resolve to something playable: find the recording here, then find a copy
   * that streams. The YouTube Music metadata stays on the track, so the
   * station announces the right title and shows the right artwork.
   */
  async resolve(query, { limit = 1 } = {}) {
    const term = this.#term(query)

    // A pasted link: oEmbed names it, then it is treated like a search hit.
    if (this.#videoId(term)) {
      const info = await this.#titleOfLink(term)
      if (info) {
        const [title, artist] = splitTitle(info.title)
        const wanted = {
          source: 'ytmusic',
          id: `ytmusic:${info.id}`,
          title,
          artist: artist ?? info.artist ?? 'YouTube',
          duration: 0,
          streamable: false,
          metadataOnly: true,
          link: `https://music.youtube.com/watch?v=${info.id}`
        }
        const playable = this.searchAll ? await this.#mirror(wanted) : null
        if (playable) return { type: 'track', name: playable.title, tracks: [playable] }
        throw new Error(`nothing playable for "${wanted.artist} — ${wanted.title}"`)
      }
    }

    const found = await this.search(query, Math.max(3, limit * 3))
    if (found.length === 0) throw new Error(`YouTube Music found nothing for "${term}"`)

    if (!this.searchAll) return { type: 'track', name: found[0].title, tracks: found.slice(0, limit) }

    const tracks = []
    for (const wanted of found.slice(0, Math.max(limit, 3))) {
      const playable = await this.#mirror(wanted)
      if (playable) tracks.push(playable)
      if (tracks.length >= limit) break
    }
    if (tracks.length === 0) throw new Error(`nothing playable for "${found[0].artist} — ${found[0].title}"`)
    return { type: 'track', name: tracks[0].title, tracks }
  }

  /** The same recording, on a provider that serves audio. */
  async #mirror(wanted) {
    if (!this.searchAll) return null
    const candidates = await this.searchAll(`${wanted.artist} ${wanted.title}`, 8).catch(() => [])
    const scored = candidates
      .filter((candidate) => candidate.streamable !== false && !candidate.metadataOnly && candidate.source !== 'ytmusic')
      .map((candidate) => ({
        candidate,
        score:
          (this.similarity?.(wanted, candidate) ?? 0) +
          // A duration within five seconds is strong evidence it is the
          // same recording rather than a cover or a live version.
          (wanted.duration && candidate.duration && Math.abs(wanted.duration - candidate.duration) < 5000 ? 0.25 : 0)
      }))
      .sort((a, b) => b.score - a.score)

    const best = scored[0]
    if (!best || best.score < 0.45) return null

    log.debug(`"${wanted.artist} — ${wanted.title}" → ${best.candidate.source} (${best.score.toFixed(2)})`)
    return {
      ...best.candidate,
      // Keep the catalogue's idea of what this song is.
      title: wanted.title,
      artist: wanted.artist,
      album: wanted.album ?? best.candidate.album ?? null,
      artwork: wanted.artwork ?? best.candidate.artwork,
      mirroredFrom: 'ytmusic',
      link: wanted.link ?? best.candidate.link
    }
  }
}

/** "Artist - Title" is the usual shape of a music upload. */
export function splitTitle(value) {
  const cleaned = String(value ?? '')
    .replace(/\((official|lyric|audio|visuali[sz]er|music)?\s*video\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // Split on the *first* separator: "Artist - Title - Live" is an artist
  // called Artist and a title called "Title - Live". Hyphen, en dash and em
  // dash are all used for this by different uploaders.
  // Split at the *first* separator, so "Artist - Title - Live" keeps its
  // "Title - Live" intact. Hyphen, en dash and em dash are all used for this
  // by different uploaders.
  // `at` is the index of the space *before* the dash: [space][dash][space].
  const at = cleaned.search(/\s[-–—]\s/)
  if (at < 1) return [cleaned, null]
  const artist = cleaned.slice(0, at).trim()
  const title = cleaned.slice(at + 3).trim()
  return title.length >= 2 ? [title, artist] : [cleaned, null]
}

export default YtMusicSource
