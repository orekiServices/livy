/**
 * Smart Queue — what plays when nobody said what should play next.
 *
 * A rotation eventually runs out: the playlist ends, the requests dry up, it
 * is four in the morning. The old answer was to loop the same list forever,
 * which is fine for a jingle channel and deadly for a music station.
 *
 * This is the other answer, and it is the one every streaming service
 * settled on: look at what this station has actually been playing, ask the
 * sources for more of that, and keep going. Three rules keep it listenable:
 *
 *   • **Follow the station, not the last track.** Seeds are drawn from a
 *     window of recent plays, so one oddity in the rotation does not send
 *     the whole night sideways.
 *   • **Never repeat yourself.** Anything played recently — or already
 *     queued — is filtered out, by id *and* by artist+title, because the
 *     same song has a different id on every source.
 *   • **Do not become one artist's radio show.** At most one track per
 *     artist per refill, and the seeds rotate.
 *
 * It is deliberately source-agnostic: it asks the registry to search, so a
 * node with SoundCloud, Audius and a folder of FLACs gets candidates from
 * all three.
 */
import createLogger from '../util/logger.ts'

const log = createLogger('smartqueue')

const DEFAULTS = {
  enabled: true,
  /** Refill when fewer than this many tracks are left. */
  minQueue: 3,
  /** How many to add each time. */
  batch: 5,
  /** How far back "recently played" goes. */
  lookback: 60,
  /** Tracks per artist in one refill. */
  perArtist: 1,
  /** Seeds to try per refill, newest first. */
  seeds: 3,
  /** Fall back to the station's own playlists when nothing is found. */
  playlistFallback: true
}

/** Loose identity for a song: the same recording on two sources matches. */
export const fingerprint = (track) =>
  `${String(track?.artist ?? '')} ${String(track?.title ?? '')}`
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/(official|video|audio|lyrics?|remaster(ed)?|hd|hq|feat\.?|ft\.?|with)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/**
 * Turn what a station has been playing into things to search for.
 *
 * Artists are the strongest signal a radio station has; genres are the
 * second. Both are used, and the query is deliberately vague — "similar to
 * X" is not a thing an MP3 search understands, but "X" plus a genre word is
 * close enough to keep a night moving.
 */
export function seedsFrom(history: any = [], { limit = 3 }: any = {}) {
  const seeds = []
  const seen = new Set()

  for (const entry of history) {
    const artist = String(entry.artist ?? '').trim()
    if (!artist || artist.length < 2) continue
    const key = artist.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    seeds.push({ kind: 'artist', text: artist, from: entry.title ?? null })
    if (seeds.length >= limit) break
  }

  // Nothing but unknown artists (a folder of untagged files, a live relay):
  // fall back to the words in the titles.
  if (seeds.length === 0) {
    for (const entry of history.slice(0, limit)) {
      const words = String(entry.title ?? '')
        .split(/[\s\-—–]+/)
        .filter((word) => word.length > 3)
        .slice(0, 3)
        .join(' ')
      if (words) seeds.push({ kind: 'title', text: words, from: entry.title })
    }
  }

  return seeds
}

export class SmartQueue {
  declare memory: any
  declare options: any
  declare sources: any
  declare stats: any
  declare store: any

  constructor({ sources, memory = null, store = null, options = {} }: any = {}) {
    this.sources = sources
    this.memory = memory
    this.store = store
    this.options = { ...DEFAULTS, ...options }
    this.stats = { refills: 0, added: 0, empty: 0 }
  }

  configure(patch: any = {}) {
    this.options = { ...this.options, ...patch }
    return this.options
  }

  get enabled() {
    return this.options.enabled !== false
  }

  /** Everything this station should not be given again. */
  #avoid(station, history) {
    const ids = new Set()
    const prints = new Set()

    const note = (track) => {
      if (!track) return
      if (track.id) ids.add(String(track.id))
      const print = fingerprint(track)
      if (print) prints.add(print)
    }

    history.forEach(note)
    station.queue?.forEach(note)
    note(station.current?.track)

    return { ids, prints }
  }

  /**
   * Find the next few tracks for a station.
   *
   * Returns `[]` rather than throwing: a station that cannot find anything
   * to autoplay should fall back to its rotation, not stop.
   */
  async suggest(station, { count = null }: any = {}) {
    if (!this.enabled || !this.sources?.search) return []

    const wanted = count ?? this.options.batch
    const history = this.memory?.recent(station.id, this.options.lookback) ?? []
    if (history.length === 0) return []

    const { ids, prints } = this.#avoid(station, history)
    const seeds = seedsFrom(history, { limit: this.options.seeds })
    if (seeds.length === 0) {
      // Nothing to go on: untagged files, or a station that has only played
      // idents. Better to fall back to the rotation than to invent music.
      this.stats.empty += 1
      return []
    }

    const picked = []
    const artists = new Map()

    for (const seed of seeds) {
      if (picked.length >= wanted) break
      let candidates = []
      try {
        candidates = await this.sources.search(seed.text, 20)
      } catch (error) {
        log.debug(`search failed for "${seed.text}": ${error.message}`)
        continue
      }

      for (const candidate of candidates) {
        if (picked.length >= wanted) break
        if (!candidate?.title || candidate.streamable === false) continue

        const id = String(candidate.id ?? '')
        const print = fingerprint(candidate)
        if (id && ids.has(id)) continue
        if (print && prints.has(print)) continue

        const artist = String(candidate.artist ?? '').toLowerCase()
        if (artist && (artists.get(artist) ?? 0) >= this.options.perArtist) continue

        picked.push({ ...candidate, autoplay: true, seededBy: seed.text })
        ids.add(id)
        if (print) prints.add(print)
        if (artist) artists.set(artist, (artists.get(artist) ?? 0) + 1)
      }
    }

    if (picked.length === 0) this.stats.empty += 1
    return picked
  }

  /**
   * Top the queue up if it is running out.
   * @returns {Promise<number>} how many tracks were added
   */
  async refill(station) {
    if (!this.enabled) return 0
    if ((station.queue?.length ?? 0) >= this.options.minQueue) return 0

    const tracks = await this.suggest(station)
    if (tracks.length === 0) return 0

    station.enqueue(tracks)
    this.stats.refills += 1
    this.stats.added += tracks.length
    log.info(
      `${station.id}: autoplay added ${tracks.length} track(s) — ${tracks
        .slice(0, 3)
        .map((track) => `${track.artist} — ${track.title}`)
        .join(', ')}`
    )
    return tracks.length
  }
}

export default SmartQueue
