/**
 * Livy Memory — what the node remembers across a restart.
 *
 * A radio station is a process that is supposed to never stop, running on
 * hardware that certainly will. Until now a restart meant the queue was
 * rebuilt from the playlist, the song that was playing started again from
 * the top, and everything the node had learned about what it plays was
 * gone. That is a bad answer to `systemctl restart`.
 *
 * So each station keeps a **memory**: the track on air and how far into it,
 * the queue behind it, and a rolling record of what has been played. It
 * lives in the same SQLite file as everything else, is written at most once
 * every few seconds, and is read once at boot.
 *
 * Two things fall out of it:
 *
 *   • **Autoseek.** If the node restarts 3 minutes into a 9 minute song, the
 *     station resumes 3 minutes in — not at the beginning, and not by
 *     skipping it.
 *   • **Less RAM.** History used to be an array that grew for as long as the
 *     process lived. Now the last few entries stay in memory and the rest is
 *     a table — which is also what makes the smart queue possible, because
 *     "what did this station play last week" is a query rather than a
 *     structure somebody has to hold.
 */
import createLogger from '../util/logger.js'

const log = createLogger('memory')

/** Write at most this often; a station changes position 25 times a second. */
const SAVE_EVERY_MS = 5000
/** Below this, resuming is not worth it — just start the song again. */
const MIN_RESUME_MS = 15_000
/** Above this, the memory is stale: nobody wants yesterday's half-song. */
const MAX_AGE_MS = 6 * 3600_000
/** How much of a queue is worth carrying across a restart. */
const MAX_QUEUE = 100
/** How many recent tracks each station keeps in RAM. */
const HOT_HISTORY = 20

/** Only the fields worth persisting: a track object can be large. */
export function slimTrack(track) {
  if (!track) return null
  return {
    id: track.id,
    source: track.source,
    title: track.title,
    artist: track.artist ?? null,
    album: track.album ?? null,
    url: track.url ?? null,
    query: track.query ?? null,
    duration: track.duration ?? 0,
    artwork: track.artwork ?? null,
    bitrate: track.bitrate ?? null,
    live: track.live === true,
    announcement: track.announcement === true,
    requestedBy: track.requestedBy ?? null
  }
}

/**
 * Is this worth resuming into?
 *
 * An ident, a jingle, a live relay and anything nearly finished are better
 * restarted or skipped than seeked. A long song somebody was listening to
 * is exactly what this is for.
 */
export function worthResuming(memory, { minMs = MIN_RESUME_MS, maxAgeMs = MAX_AGE_MS } = {}) {
  if (!memory?.track || !Number.isFinite(memory.positionMs)) return false
  if (memory.track.announcement || memory.track.live) return false
  if (memory.positionMs < minMs) return false
  if (Date.now() - (memory.at ?? 0) > maxAgeMs) return false
  // Nothing to come back to if it was almost over.
  const duration = memory.track.duration ?? 0
  if (duration > 0 && memory.positionMs > duration - 20_000) return false
  return true
}

export class Memory {
  #saved = new Map() // stationId → { at, json }
  #hot = new Map() // stationId → recent tracks, in RAM

  constructor({ store = null, enabled = true, saveEveryMs = SAVE_EVERY_MS } = {}) {
    this.store = store
    this.enabled = enabled !== false && Boolean(store?.rememberStation)
    this.saveEveryMs = saveEveryMs
    this.writes = 0
    this.skipped = 0
  }

  /**
   * Note where a station is. Called on every track change and every few
   * seconds of playback, so it must be cheap and must not write every time.
   */
  save(station, { force = false } = {}) {
    if (!this.enabled || !station) return false

    const now = Date.now()
    const last = this.#saved.get(station.id)
    if (!force && last && now - last.at < this.saveEveryMs) {
      this.skipped += 1
      return false
    }

    const current = station.current
    const memory = {
      at: now,
      state: station.state,
      track: slimTrack(current?.track),
      positionMs: Math.round(current?.positionMs ?? 0),
      // The queue is the cheap half of this: ids and titles, capped.
      queue: (station.queue ?? []).slice(0, MAX_QUEUE).map(slimTrack)
    }

    // Nothing changed except the clock? Skip the write.
    const json = JSON.stringify(memory)
    if (!force && last?.json && Math.abs(json.length - last.json.length) < 4 && last.positionMs === memory.positionMs) {
      this.skipped += 1
      return false
    }

    try {
      this.store.rememberStation(station.id, memory)
      this.#saved.set(station.id, { at: now, json, positionMs: memory.positionMs })
      this.writes += 1
      return true
    } catch (error) {
      log.debug(`could not save ${station.id}: ${error.message}`)
      return false
    }
  }

  /** What this station was doing when the node stopped. */
  recall(stationId) {
    if (!this.enabled) return null
    try {
      return this.store.recallStation(stationId)
    } catch (error) {
      log.debug(`could not recall ${stationId}: ${error.message}`)
      return null
    }
  }

  /** Forget a station (it was deleted, or the owner asked). */
  forget(stationId) {
    this.#saved.delete(stationId)
    this.#hot.delete(stationId)
    try {
      this.store?.forgetStation?.(stationId)
    } catch {
      /* nothing to forget */
    }
  }

  /**
   * Remember that a track played.
   *
   * The last few stay in memory for the things that need them right now
   * (the "recently played" list, the smart queue's no-repeat rule); the full
   * record is already in the `plays` table, which is where anything older
   * comes from.
   */
  played(stationId, track) {
    const slim = slimTrack(track)
    if (!slim) return
    const hot = this.#hot.get(stationId) ?? []
    hot.unshift({ ...slim, at: Date.now() })
    this.#hot.set(stationId, hot.slice(0, HOT_HISTORY))
  }

  /** The last few tracks, newest first — from RAM, then from SQLite. */
  recent(stationId, limit = 20) {
    const hot = this.#hot.get(stationId) ?? []
    if (hot.length >= limit || !this.store?.recentPlays) return hot.slice(0, limit)

    const seen = new Set(hot.map((entry) => entry.id))
    const cold = this.store
      .recentPlays(stationId, limit * 2)
      .filter((row) => !seen.has(row.track_id))
      .map((row) => ({
        id: row.track_id,
        title: row.title,
        artist: row.artist,
        source: row.source,
        at: row.started_at
      }))

    return [...hot, ...cold].slice(0, limit)
  }

  stats() {
    return {
      enabled: this.enabled,
      stations: this.#saved.size,
      writes: this.writes,
      // Writes we did not make: the whole point of the throttle.
      skipped: this.skipped,
      hotTracks: [...this.#hot.values()].reduce((sum, list) => sum + list.length, 0)
    }
  }
}

export default Memory
