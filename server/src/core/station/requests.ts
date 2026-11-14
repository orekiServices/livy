/**
 * The request line, votes and democratic skips.
 *
 * Mixed into Station.prototype in ../station.js.
 */
import {
  PassThrough,
  randomUUID,
  buildSilence,
  MetroFramer,
  MetroTranscoder,
  engineInfo,
  sniff,
  worthResuming,
  hlsSegments,
  isHlsUrl,
  createLogger,
  Automix,
  DEFAULT_AUTOMIX,
  decodeMp3,
  encodeMp3,
  FilterChain,
  DEFAULTS,
  publicTrack
} from './deps.ts'

export const requestsMethods = {
  /**
   * Public request entry point — "everyone can request".
   * @param {object} opts
   * @param {string} opts.query   search terms or a source URL
   * @param {string} [opts.by]    display name
   * @param {string} [opts.requesterId] stable id (ip hash / session) for limits
   */
  async request({ query, by = 'anonymous', requesterId = by, track: presetTrack }: any = {}) {
    if (!this.options.allowRequests) throw Object.assign(new Error('This station does not take requests'), { status: 403 })
    if (this.requests.length >= this.options.maxRequests) throw Object.assign(new Error('Request queue is full'), { status: 429 })

    const pending = this.requests.filter((r) => r.requesterId === requesterId).length
    if (pending >= this.options.maxPendingPerUser) {
      throw Object.assign(new Error(`You already have ${pending} pending requests`), { status: 429 })
    }

    const last = this.lastRequestAt.get(requesterId) ?? 0
    const wait = this.options.requestCooldownMs - (Date.now() - last)
    if (wait > 0) throw Object.assign(new Error(`Please wait ${Math.ceil(wait / 1000)}s before requesting again`), { status: 429 })

    let track = presetTrack
    if (!track) {
      const resolved = await this.sources.resolve(query, { limit: 5 })
      track = resolved.tracks.find((t) => t.streamable !== false)
      if (!track) throw Object.assign(new Error(`Nothing playable found for "${query}"`), { status: 404 })
    } else if (typeof this.sources.rehydrate === 'function') {
      // Public payloads drop the provider's playback handle. Get it back
      // before the request is committed to the queue.
      track = await this.sources.rehydrate(track)
    }

    const duplicate =
      this.requests.some((r) => r.track.id === track.id) || this.current?.track?.id === track.id
    if (duplicate) throw Object.assign(new Error('That track is already on air or queued'), { status: 409 })

    if (this.store?.isBanned(requesterId)) {
      throw Object.assign(new Error('Your line has been restricted by the station owner'), { status: 403 })
    }

    const request = {
      id: randomUUID().slice(0, 8),
      track,
      by: String(by).slice(0, 32),
      requesterId,
      votes: 1,
      voters: new Set([requesterId]),
      requestedAt: Date.now()
    }

    // Persisted first: votes and requests survive a restart (SQLite).
    try {
      this.store?.saveRequest({ id: request.id, stationId: this.id, track, by: request.by, requesterId })
      this.store?.addVote({ stationId: this.id, requestId: request.id, voter: requesterId })
    } catch (error) {
      this.log.debug(`store: ${error.message}`)
    }

    this.requests.push(request)
    this.lastRequestAt.set(requesterId, Date.now())
    this.emit('requests', this.requests)
    this.log.info(`request from ${request.by}: ${track.artist} — ${track.title}`)

    if (!this._running && this.options.autoStart) this.start()
    return { request: this._publicRequest(request), position: this.requestPosition(request.id) }
  },

  voteRequest(id, voterId = 'anonymous') {
    const request = this.requests.find((r) => r.id === id)
    if (!request) throw Object.assign(new Error('No such request'), { status: 404 })
    if (this.store?.isBanned(voterId)) throw Object.assign(new Error('Your line has been restricted'), { status: 403 })

    // SQLite UNIQUE(request_id, voter) is the source of truth for duplicates.
    const accepted = this.store ? this.store.addVote({ stationId: this.id, requestId: id, voter: voterId }) : !request.voters.has(voterId)
    if (!accepted) throw Object.assign(new Error('You already voted for this'), { status: 409 })

    request.voters.add(voterId)
    request.votes = this.store ? this.store.voteCount(id) : request.votes + 1
    this.requests.sort((a, b) => b.votes - a.votes || a.requestedAt - b.requestedAt)
    this.emit('requests', this.requests)
    return { request: this._publicRequest(request), position: this.requestPosition(id) }
  },

  removeRequest(id) {
    const index = this.requests.findIndex((r) => r.id === id)
    if (index === -1) return null
    const [removed] = this.requests.splice(index, 1)
    this.emit('requests', this.requests)
    return this._publicRequest(removed)
  },

  requestPosition(id) {
    const sorted = [...this.requests].sort((a, b) => b.votes - a.votes || a.requestedAt - b.requestedAt)
    return sorted.findIndex((r) => r.id === id) + 1
  },

  /** Democratic skip: needs half of the current listeners (at least one). */
  voteSkip(voterId = 'anonymous') {
    if (!this.options.allowRequests) throw Object.assign(new Error('Voting is disabled here'), { status: 403 })
    if (this.store?.isBanned(voterId)) throw Object.assign(new Error('Your line has been restricted'), { status: 403 })

    const trackId = this.current?.track?.id ?? 'idle'
    this.voteSkips.add(voterId)
    if (this.store) this.store.addSkipVote({ stationId: this.id, trackId, voter: voterId })

    const needed = Math.max(1, Math.ceil(this.listeners * this.options.voteSkipRatio))
    const votes = this.store ? Math.max(this.voteSkips.size, this.store.skipVoteCount(this.id, trackId)) : this.voteSkips.size
    const passed = votes >= needed
    if (passed) {
      this.voteSkips.clear()
      this.store?.clearSkipVotes(this.id, trackId)
      this.skip()
    }
    this.emit('voteskip', { votes, needed, passed })
    return { votes, needed, passed }
  },

  _publicRequest(request) {
    return {
      id: request.id,
      by: request.by,
      votes: request.votes,
      requestedAt: request.requestedAt,
      // Same allow-list as everything else a listener sees: a request must not
      // hand out the media URL (a local path, or a signed CDN link) either.
      track: publicTrack(request.track)
    }
  },

  publicRequests() {
    return [...this.requests]
      .sort((a, b) => b.votes - a.votes || a.requestedAt - b.requestedAt)
      .map((r) => this._publicRequest(r))
  }
}

export default requestsMethods
