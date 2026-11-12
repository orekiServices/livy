/**
 * Source registry: resolution, hi-res upgrading and streaming fallback.
 *
 * Providers implement { name, canResolve(q), resolve(q), stream(track) }.
 * On top of them the registry adds two things the stations rely on:
 *
 *   prepare(track)  "re-clone" a track at higher quality — if the chosen track
 *                   is a low-bitrate copy (SoundCloud is 128 kbps), look for
 *                   the same recording on a hi-res provider (archive.org
 *                   serves 192–320 kbps MP3) and swap it in when the match is
 *                   convincing (title/artist similarity + duration proximity).
 *
 *   stream(track)   never let one dead link kill the broadcast: try the track,
 *                   then its clones on every other provider, and finally a
 *                   themed live stream, before giving up.
 *
 * Providers (16): tts, local, soundcloud, audius, bandcamp, ccmixter,
 * archive, deezer, radioparadise, somafm, podcast, vimeo, ytmusic, mirror,
 * radiobrowser, http.
 *
 * Two of them only work because MetroS can decode: Radio Paradise serves
 * lossless FLAC blocks and Vimeo serves AAC (progressive MP4 or HLS). They
 * are transcoded to MP3 on the way to the pacer, like any other relay.
 *
 * Resolution order for a query: the first provider that recognises it wins
 * (prefix or URL shape); bare text goes to the default search provider.
 * `mirror` is the odd one out: it reads the public metadata of a Spotify /
 * Apple Music / YouTube / Mixcloud / TIDAL link and finds that recording on a
 * provider that actually serves audio.
 */
import SoundCloudSource from './soundcloud.js'
import AudiusSource from './audius.js'
import ArchiveSource from './archive.js'
import BandcampSource from './bandcamp.js'
import DeezerSource from './deezer.js'
import CcMixterSource from './ccmixter.js'
import RadioBrowserSource from './radiobrowser.js'
import SomaFmSource from './somafm.js'
import PodcastSource from './podcast.js'
import RadioParadiseSource from './radioparadise.js'
import VimeoSource from './vimeo.js'
import YtMusicSource from './ytmusic.js'
import MirrorSource from './mirror.js'
import TtsSource from './tts.js'
import HttpSource from './http.js'
import LocalSource from './local.js'
import createLogger from '../util/logger.js'

const log = createLogger('sources')

/* ------------------------------ matching ------------------------------ */

const normalise = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/(official|free|no copyright|royalty free|hd|hq|lyrics?|audio|video|remaster(ed)?|full album)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const tokens = (value) => new Set(normalise(value).split(' ').filter((t) => t.length > 2))

/** Jaccard similarity of title+artist, 0…1. */
/** Loose identity for a song, so the same track from two providers collapses. */
export function fingerprintOf(track) {
  const key = normalise(`${track?.artist ?? ''} ${track?.title ?? ''}`)
  return key || normalise(track?.title ?? '') || null
}

export function similarity(a, b) {
  const left = tokens(`${a.artist ?? ''} ${a.title ?? ''}`)
  const right = tokens(`${b.artist ?? ''} ${b.title ?? ''}`)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

function durationFit(a, b) {
  if (!a.duration || !b.duration) return 0.5 // unknown — neither reward nor punish
  const diff = Math.abs(a.duration - b.duration) / Math.max(a.duration, b.duration)
  return diff < 0.04 ? 1 : diff < 0.12 ? 0.6 : 0
}

/* ------------------------------ registry ------------------------------ */

const BUILT_IN_SOURCES = new Set([
  'tts', 'local', 'soundcloud', 'audius', 'bandcamp', 'ccmixter',
  'archive', 'deezer', 'somafm', 'podcast', 'mirror', 'radiobrowser', 'http'
])

export class SourceRegistry {
  constructor(config = {}, { tts } = {}) {
    this.config = config
    this.soundcloud = new SoundCloudSource({ clientId: config.soundcloudClientId })
    this.audius = new AudiusSource()
    this.archive = new ArchiveSource()
    this.bandcamp = new BandcampSource()
    this.deezer = new DeezerSource()
    this.ccmixter = new CcMixterSource()
    this.http = new HttpSource()
    this.radiobrowser = new RadioBrowserSource({ http: this.http })
    this.local = new LocalSource({ dir: config.mediaDir })
    this.somafm = new SomaFmSource({ http: this.http })
    this.podcast = new PodcastSource({ http: this.http })
    this.radioparadise = new RadioParadiseSource()
    this.vimeo = new VimeoSource()
    // The catalogue: it knows what every song is called, and hands the
    // actual playing to whoever can (see sources/ytmusic.js).
    this.ytmusic = new YtMusicSource({ search: (q, n) => this.search(q, n), similarity })
    this.mirror = new MirrorSource({ search: (q, n) => this.search(q, n), similarity })
    this.tts = tts ? new TtsSource({ engine: tts }) : null

    this.sources = [
      ...(this.tts ? [this.tts] : []),
      this.local,
      this.soundcloud,
      this.audius,
      this.bandcamp,
      this.ccmixter,
      this.archive,
      this.deezer,
      this.radioparadise,
      this.somafm,
      this.podcast,
      this.vimeo,
      // Both of these resolve metadata and mirror it onto a provider that
      // serves audio, so they must sit in front of http: their links are
      // URLs too.
      this.ytmusic,
      this.mirror,
      this.radiobrowser,
      this.http
    ]
    this.defaultSearch = config.defaultSearch ?? 'soundcloud'

    // Providers that should not be part of a general search: speech, live
    // station directories and URL-only resolvers would all answer "yes" to
    // every query and drown the music.
    this.noSearch = new Set(config.noSearch ?? ['tts', 'http', 'mirror', 'radiobrowser', 'somafm', 'radioparadise'])

    // A small thumb on the scale, applied after matching: taste, not truth.
    this.searchWeights = {
      local: 0.25,
      [this.defaultSearch]: 0.15,
      audius: 0.1,
      archive: 0.05,
      ccmixter: 0.05,
      ytmusic: -0.15, // it cannot play; it is here to name things
      ...(config.searchWeights ?? {})
    }

    // hi-res policy
    this.hiRes = config.hiRes ?? true
    this.hiResMinKbps = config.hiResMinKbps ?? 192
    this.hiResMinScore = config.hiResMinScore ?? 0.62

    // fallback policy
    this.fallbackOrder = config.fallbackOrder ?? ['archive', 'audius', 'soundcloud', 'bandcamp', 'ccmixter', 'radiobrowser']
    this.liveFallback = config.liveFallback ?? true

    this.altCache = new Map() // trackId -> { at, tracks }
    this.altTtl = config.altCacheTtl ?? 10 * 60_000
  }

  get(name) {
    return this.sources.find((s) => s.name === name)
  }

  /* ------------------------- runtime providers ------------------------ */

  /**
   * Add a provider at runtime — this is how a plugin contributes a source.
   * It is inserted in front of `http` (the catch-all) unless `before` names
   * another provider, so a plugin can claim URLs a built-in would otherwise
   * swallow.
   *
   * @param {{name:string, prefixes?:string[], canResolve:Function, resolve:Function, search?:Function, stream?:Function}} provider
   */
  register(provider, { before = 'http' } = {}) {
    if (!provider?.name || typeof provider.canResolve !== 'function' || typeof provider.resolve !== 'function') {
      throw new Error('A source needs { name, canResolve(), resolve() }')
    }
    if (this.get(provider.name)) throw new Error(`Source "${provider.name}" already exists`)

    provider.prefixes ??= []
    const at = this.sources.findIndex((s) => s.name === before)
    if (at === -1) this.sources.push(provider)
    else this.sources.splice(at, 0, provider)

    this[provider.name] ??= provider
    log.info(`source registered: ${provider.name}`, { prefixes: provider.prefixes.join(',') || 'none' })
    return provider
  }

  /** Remove a runtime provider (built-ins stay put). */
  unregister(name) {
    const at = this.sources.findIndex((s) => s.name === name)
    if (at === -1) return false
    this.sources.splice(at, 1)
    if (this[name] && !BUILT_IN_SOURCES.has(name)) delete this[name]
    log.info(`source removed: ${name}`)
    return true
  }

  /* ----------------------------- resolving ---------------------------- */

  async resolve(query, options = {}) {
    const q = String(query ?? '').trim()
    if (!q) throw new Error('Empty query')

    const source = this.sources.find((s) => s.canResolve(q))
    const started = Date.now()
    const result = source
      ? await source.resolve(q, options)
      : await this.get(this.defaultSearch).resolve(`scsearch:${q}`, options)

    log.debug(`resolved "${q.slice(0, 50)}" via ${source?.name ?? this.defaultSearch} → ${result.tracks.length} in ${Date.now() - started}ms`)
    return { ...result, source: source?.name ?? this.defaultSearch }
  }

  /**
   * Multi-provider search used by the request UI.
   * @param {string} query
   * @param {number} limit
   * @param {'all'|'soundcloud'|'audius'|'bandcamp'|'ccmixter'|'archive'|'deezer'|'somafm'|'podcast'|'mirror'|'radiobrowser'|'tts'} provider
   */
  /**
   * Search every provider that can, and return one ranked list.
   *
   * The old version asked five providers and sorted the pile by bitrate,
   * which meant a 320 kbps field recording of rain outranked the song you
   * actually typed. This one scores each candidate on
   *
   *   • **how well it matches what you asked for** (title + artist
   *     similarity, the same scorer the hi-res cloner uses) — by far the
   *     biggest term, because a search result that is not the song is
   *     worthless however good it sounds;
   *   • **whether it can actually be played** — metadata-only results from
   *     the catalogue sources sink;
   *   • **quality**, as a tie-breaker, not a ranking;
   *   • **a small nudge per provider**, so that with everything else equal
   *     the primary source wins.
   *
   * Duplicates are collapsed across providers by artist+title, keeping the
   * best-scoring copy, so one song appears once however many services have
   * it.
   *
   * @param {string} query
   * @param {number} [limit]
   * @param {string} [provider] one provider's name, or 'all'
   */
  async search(query, limit = 20, provider = 'all') {
    const term = String(query ?? '').trim()
    if (!term) return []

    if (provider !== 'all') {
      const source = this.get(provider)
      if (!source?.search) throw new Error(`Source "${provider}" cannot search`)
      return (await source.search(term, limit)) ?? []
    }

    // Everything that can search, in parallel, each asked for a share of
    // the result set plus a little headroom for the ranking to choose from.
    const searchable = this.sources.filter((source) => typeof source.search === 'function' && !this.noSearch.has(source.name))
    const per = Math.max(4, Math.ceil((limit * 1.5) / Math.max(1, searchable.length)))

    const settled = await Promise.allSettled(
      searchable.map(async (source) => {
        const started = Date.now()
        const found = (await source.search(term, per)) ?? []
        return found.map((track) => ({ ...track, source: track.source ?? source.name, searchMs: Date.now() - started }))
      })
    )

    const candidates = []
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') candidates.push(...result.value)
      else log.debug(`search failed on ${searchable[index].name}: ${result.reason?.message ?? result.reason}`)
    })

    return this.rank(term, candidates, limit)
  }

  /**
   * Score, dedupe and order. Exposed because it is the interesting half and
   * worth testing on its own.
   */
  rank(term, candidates, limit = 20) {
    const wanted = this.#asTrack(term)

    const scored = candidates.map((track) => {
      let score = similarity(wanted, track) * 2

      // Did they type the title (or the artist) more or less exactly?
      const haystack = `${track.artist ?? ''} ${track.title ?? ''}`.toLowerCase()
      if (haystack.includes(term.toLowerCase())) score += 0.5

      // Playable beats perfect: a metadata-only hit is a promise, not a song.
      if (track.streamable === false || track.metadataOnly) score -= 0.8

      // Quality as a tie-breaker, worth at most a fifth of a point.
      const bitrate = track.bitrate ?? 128
      score += Math.min(0.2, Math.max(0, (bitrate - 128) / 1000))

      // House preference, so that all else being equal the primary source
      // and the local library win.
      score += this.searchWeights[track.source] ?? 0

      return { track, score }
    })

    // One song, one row — whichever provider has the best copy of it.
    const best = new Map()
    for (const entry of scored.sort((a, b) => b.score - a.score)) {
      const key = fingerprintOf(entry.track)
      if (!key) continue
      if (!best.has(key)) best.set(key, entry)
    }

    return [...best.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => ({ ...entry.track, searchScore: Number(entry.score.toFixed(3)) }))
  }

  /** "artist - title" or just words: enough for the similarity scorer. */
  #asTrack(term) {
    const [first, ...rest] = term.split(/\s+[-–—]\s+/)
    return rest.length ? { artist: first, title: rest.join(' - ') } : { artist: '', title: term }
  }

  /* ------------------------ alternatives / clones --------------------- */

  /** Find the same recording on other providers, best match first. */
  async alternatives(track, { minScore = 0.5, limit = 4 } = {}) {
    const cached = this.altCache.get(track.id)
    if (cached && Date.now() - cached.at < this.altTtl) return cached.tracks

    const term = `${track.artist ?? ''} ${track.title ?? ''}`.trim().slice(0, 120)
    if (!term) return []

    const providers = this.fallbackOrder.filter(
      (name) => name !== track.source && name !== 'radiobrowser' && !this.get(name)?.metadataOnly
    )
    const settled = await Promise.allSettled(
      providers.map((name) => this.get(name)?.search?.(term, 6) ?? Promise.resolve([]))
    )

    const scored = []
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue
      for (const candidate of result.value) {
        if (candidate.id === track.id) continue
        const score = similarity(track, candidate) * 0.7 + durationFit(track, candidate) * 0.3
        if (score >= minScore) scored.push({ candidate, score })
      }
    }

    const tracks = scored
      .sort((a, b) => b.score - a.score || (b.candidate.bitrate ?? 128) - (a.candidate.bitrate ?? 128))
      .slice(0, limit)
      .map(({ candidate, score }) => ({ ...candidate, matchScore: Number(score.toFixed(3)), clonedFrom: track.id }))

    this.altCache.set(track.id, { at: Date.now(), tracks })
    if (this.altCache.size > 500) this.altCache.delete(this.altCache.keys().next().value)
    return tracks
  }

  /**
   * Hi-res "re-clone": swap a low-bitrate track for a better copy of the same
   * recording when one exists. Returns the track to actually play.
   */
  async prepare(track, { quality = this.hiRes ? 'high' : 'normal' } = {}) {
    // announcements and live streams are never "upgraded"
    if (quality !== 'high' || track.live || track.announcement || track.source === 'tts') return track
    const current = track.bitrate ?? (track.source === 'soundcloud' ? 128 : 0)
    if (current >= this.hiResMinKbps) return track

    try {
      const candidates = await this.alternatives(track, { minScore: this.hiResMinScore, limit: 3 })
      const better = candidates.find((c) => (c.bitrate ?? 0) > current && (c.bitrate ?? 0) >= this.hiResMinKbps)
      if (!better) return track

      log.info(`hi-res: "${track.title}" ${current || '?'}→${better.bitrate} kbps via ${better.source} (match ${better.matchScore})`)
      return { ...better, upgradedFrom: { id: track.id, source: track.source, bitrate: current } }
    } catch (error) {
      log.debug(`hi-res lookup failed: ${error.message}`)
      return track
    }
  }

  /**
   * Open a playable MP3 stream, falling back across providers.
   * @returns {Promise<{stream: import('node:stream').Readable, track: object, mode: string, attempts: number}>}
   */
  async stream(track, options = {}) {
    const tried = new Set()
    const errors = []

    // Metadata-only providers (Deezer) never stream: clone straight away and
    // keep the rich metadata (exact title/artist/artwork) on the played track.
    if (track.metadataOnly) {
      const clones = await this.alternatives(track, { minScore: 0.45, limit: 4 })
      for (const clone of clones) {
        tried.add(clone.id)
        try {
          const source = this.get(clone.source)
          const opened = await source.stream(clone, options)
          log.info(`metadata clone: "${track.artist} — ${track.title}" → ${clone.source} (${clone.bitrate ?? '?'} kbps)`)
          return {
            ...opened,
            track: { ...clone, title: track.title, artist: track.artist, artwork: track.artwork ?? clone.artwork, clonedFrom: track.id },
            attempts: tried.size,
            fallback: true
          }
        } catch (error) {
          errors.push(`${clone.source}: ${error.message}`)
        }
      }
      throw new Error(`No playable copy found for "${track.artist} — ${track.title}" → ${errors.join(' | ')}`)
    }

    const attempt = async (candidate) => {
      const source = this.get(candidate.source)
      if (!source) throw new Error(`No source "${candidate.source}"`)
      const opened = await source.stream(candidate, options)
      return { ...opened, track: candidate }
    }

    // 1. the track itself
    try {
      tried.add(track.id)
      const opened = await attempt(track)
      return { ...opened, attempts: 1 }
    } catch (error) {
      // Spoken announcements have no musical equivalent: never fall back.
      if (track.announcement || track.source === 'tts') throw error
      errors.push(`${track.source}: ${error.message}`)
      log.warn(`primary stream failed (${track.source}) — ${error.message}`)
    }

    // 2. clones of the same recording on other providers
    let clones = []
    try {
      clones = await this.alternatives(track, { minScore: 0.45, limit: 4 })
    } catch {
      /* ignore */
    }

    for (const clone of clones) {
      if (tried.has(clone.id)) continue
      tried.add(clone.id)
      try {
        const opened = await attempt(clone)
        log.info(`fallback: playing "${clone.title}" from ${clone.source} (${clone.bitrate ?? '?'} kbps)`)
        return { ...opened, attempts: tried.size, fallback: true }
      } catch (error) {
        errors.push(`${clone.source}: ${error.message}`)
      }
    }

    // 3. last resort: a themed live stream so the station never goes silent
    if (this.liveFallback && options.allowLiveFallback !== false) {
      try {
        const [live] = await this.radiobrowser.search(options.fallbackTag ?? track.genre ?? 'music', 1, { minBitrate: 128 })
        if (live) {
          const opened = await attempt(live)
          log.warn(`live fallback: relaying "${live.title}" (${live.bitrate} kbps)`)
          return { ...opened, attempts: tried.size + 1, fallback: true, live: true }
        }
      } catch (error) {
        errors.push(`radiobrowser: ${error.message}`)
      }
    }

    throw new Error(`All sources failed for "${track.title}" → ${errors.join(' | ')}`)
  }
}

export default SourceRegistry
