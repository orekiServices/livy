/**
 * Seams on a live station: the scout that listens to every song as it is
 * read, RL's advice at a track change, and Forever mode.
 *
 * Mixed into Station.prototype in ../station.js.
 */
import { SeamScout, ForeverJukebox } from '../seams/index.ts'
import { rl } from '../models/rl.ts'
import { effectUsable } from '../automix/effects.js'

/** RL speaks once it has seen this many seams between two kinds of beat. */
const MIN_EVIDENCE = 6
/** …and only when its pick is this much better than what was going to play. */
const MIN_EDGE = 0.08

export const seamMethods = {
  /**
   * Show the scout what is about to air. One scout per song; the previous
   * song's is kept until the seam out of it has been rendered and logged.
   */
  _scoutPush(frames) {
    if (this.options.seams === false || frames.length === 0) return
    const track = frames[0].track
    if (!track || track.live === true) return
    try {
      if (this._scout?.track?.id !== track.id) {
        this._scoutPrevious?.scout.close()
        this._scoutPrevious = this._scout ?? null
        const scout = new SeamScout({
          // Forever needs the song in hand; otherwise the analysis is enough.
          retain: Boolean(this.options.forever),
          maxMs: this.options.seamMaxMs ?? 15 * 60_000,
          centroids: () => rl().centroids,
          onSeam: (candidate) => {
            this.stats.seams = (this.stats.seams ?? 0) + 1
            this.emit('seam', { track: track.id, atMs: candidate.atMs, score: candidate.score, detectors: candidate.detectors })
          }
        })
        this._scout = { track, scout }
      }
      // A batch can straddle two songs only at a rendered seam, and those
      // frames are tagged with the song they belong to.
      this._scout.scout.push(frames.filter((frame) => frame.track?.id === track.id).map((frame) => frame.data))
    } catch (error) {
      this.log.debug(`scout: ${error.message}`)
    }
  },

  _scoutFor(trackId) {
    if (trackId == null) return null
    if (this._scout?.track?.id === trackId) return this._scout.scout
    if (this._scoutPrevious?.track?.id === trackId) return this._scoutPrevious.scout
    return null
  },

  /**
   * What kind of beat a seam leaves and what kind it enters.
   *
   * The blend sits at the end of the outgoing song and the start of the
   * incoming one, so the exit is the beat the blend begins on and the entry
   * is the first beat that plays alone after it.
   */
  async _seamKinds({ from, to, blendMs = 6000 } = {}) {
    const out = this._scoutFor(from)
    const into = this._scoutFor(to)
    await Promise.all([out?.settle(), into?.settle()])
    const exit = out ? out.beatAt(Math.max(0, out.ms - blendMs)) : null
    const entry = into ? into.beatAt(blendMs) : null
    return { exit, entry }
  },

  /**
   * RL's say in which transition plays. Called by the automix with the seam
   * it is about to render and the choice it has made so far; returns a
   * replacement, or nothing.
   */
  async adviseSeam(seam, choice, pool = [], { from = null, to = null, blendMs = 6000 } = {}) {
    this._seamContext = null
    if (this.options.seams === false) return null
    const { exit, entry } = await this._seamKinds({ from: from?.id, to: to?.id, blendMs })
    this._seamContext = { from: from?.id ?? null, to: to?.id ?? null, exit, entry }
    if (!exit || !entry || this.options.rl === false) return null

    const model = rl()
    if (model.evidence(exit.category, entry.category) < MIN_EVIDENCE) return null
    const ranked = model.rank(exit.category, entry.category, pool.length ? pool : undefined, { explore: this.options.rlExplore ?? 0.35 })
    const top = ranked.find((option) => effectUsable(option.effect, seam))
    if (!top || top.effect === choice.effect) return null
    const current = model.value(exit.category, entry.category, choice.effect).value
    if (top.score - current < MIN_EDGE) return null
    this.log.info(`RL: ${exit.category} → ${entry.category}: ${top.effect} (${top.value.toFixed(2)}) over ${choice.effect} (${current.toFixed(2)})`)
    return { effect: top.effect, source: 'rl', baseline: choice.baseline ?? choice.effect, margin: Number((top.score - current).toFixed(3)), model: 'RL' }
  },

  /** Owner control: Forever mode on or off. Off lets the song finish. */
  setForever(on = true) {
    this.options.forever = Boolean(on)
    if (!on && this._forever) this._forever.home = true
    this.emit('forever', this.foreverInfo())
    this.log.info(`forever mode ${on ? 'on' : 'off'}`)
    return this.foreverInfo()
  },

  foreverInfo() {
    const jukebox = this._forever
    return {
      enabled: Boolean(this.options.forever),
      active: Boolean(jukebox),
      track: jukebox ? (this._scout?.track?.id ?? null) : null,
      jumps: jukebox?.jumps ?? 0,
      positionMs: jukebox ? Math.round(jukebox.positionMs) : null,
      lastJump: this._lastJump ?? null
    }
  },

  /** What the scout knows about the song being read, for the owner. */
  seamsInfo({ graph = false } = {}) {
    const scout = this._scout?.scout
    const analysis = scout?.analysis() ?? null
    const jukebox = graph ? scout?.graph() : null
    return {
      track: this._scout?.track?.id ?? null,
      ...(scout?.info() ?? { ms: 0, beats: 0, candidates: 0 }),
      seams: analysis ? analysis.candidates.map((c) => ({ atMs: c.atMs, score: c.score, detectors: c.detectors, why: c.why })) : [],
      jukebox: jukebox ? { branching: jukebox.branching, threshold: jukebox.threshold, lastBranch: jukebox.lastBranch, longestBackward: jukebox.longestBackward, engine: jukebox.engine } : null,
      forever: this.foreverInfo(),
      rl: rl().info()
    }
  },

  /**
   * Forever mode: the song that has just been read does not end.
   *
   * By now the reader has pushed the whole song, but the end of it has not
   * aired: the automix is holding the tail for a blend, and the pacer is
   * seconds behind the reader. Those frames are taken back, and from there
   * the jukebox decides what plays — the song's own frames, with a re-encoded
   * handful wherever it jumps. It stops when the owner turns it off, somebody
   * skips or asks for a song, or an announcement is due; the rest of the song
   * then goes through the automix like any other ending.
   */
  async _playForever() {
    if (!this.options.forever || this._skipRequested || !this._running) return false
    const held = this._scout
    const scout = held?.scout
    const track = held?.track
    if (!scout || !track || this._readingTrackId !== track.id) return false
    if (scout.full || scout.failed || scout.frames.length !== scout.seenFrames) return false

    await scout.settle()
    const analysis = scout.analysis()
    const graph = scout.graph()
    if (!analysis || !graph || graph.lastBranch < 0) {
      this.log.info(`forever: "${track.title}" has nowhere to loop back to`)
      return false
    }

    // Take back what has not aired, newest first, for as long as it is this
    // song's own untouched frames (identity, not equality: a rendered seam
    // or a filtered block is a different buffer and stays where it is).
    const frames = scout.frames
    let cursor = frames.length
    const fromAutomix = this.automix?.enabled ? this.automix.heldFrames : 0
    if (fromAutomix > 0) cursor -= this.automix.retract(fromAutomix)
    while (cursor > 0 && this._frames.length > 0) {
      const last = this._frames[this._frames.length - 1]
      if (last.track?.id !== track.id || last.data !== frames[cursor - 1]) break
      this._frames.pop()
      this._bufferedMs -= last.ms
      cursor -= 1
    }

    const jukebox = new ForeverJukebox({ frames, track: analysis.track, graph, cursor })
    const ms = (jukebox.spf / jukebox.sampleRate) * 1000
    const giveBack = async () => {
      // The rest of the song, through the usual path (minus the scout, which
      // has heard it), so the change to the next song is still a mix.
      const rest = frames.slice(jukebox.cursor).map((data) => ({ data, ms, track }))
      if (!rest.length) return
      if (this.automix?.enabled) {
        try {
          for (const frame of await this.automix.push(rest)) {
            this._frames.push(frame)
            this._bufferedMs += frame.ms
          }
          return
        } catch (error) {
          this.log.warn(`automix bypassed: ${error.message}`)
        }
      }
      for (const frame of rest) {
        this._frames.push(frame)
        this._bufferedMs += frame.ms
      }
    }

    if (!jukebox.possible) {
      this.log.info(`forever: too little of "${track.title}" is left to loop from`)
      await giveBack()
      return false
    }

    this._forever = jukebox
    this.log.info(`forever: "${track.title}" — ${graph.branching} branching beats of ${analysis.track.beats.length}`)
    this.emit('forever', this.foreverInfo())
    try {
      while (this._running && !this._skipRequested) {
        // Anything else that wants the air ends the loop at the song's end.
        if (!this.options.forever || this.requests.length > 0 || this.announcements.length > 0) jukebox.home = true
        if (jukebox.home) break
        const segment = await jukebox.next()
        for (const data of segment.frames) {
          this._frames.push({ data, ms, track })
          this._bufferedMs += ms
        }
        if (segment.jump) {
          this._lastJump = { ...segment.jump, at: Date.now() }
          this.stats.jumps = (this.stats.jumps ?? 0) + 1
          this.emit('jump', { track: track.id, ...segment.jump })
        }
        if (segment.ended) break
        while (this._running && !this._skipRequested && !jukebox.home && this._bufferedMs > this.options.bufferAheadMs) await this._sleep(120)
      }
    } catch (error) {
      this.log.warn(`forever stopped: ${error.message}`)
    } finally {
      this._forever = null
    }
    if (this._running && !this._skipRequested) await giveBack()
    this.emit('forever', this.foreverInfo())
    return true
  }
}

export default seamMethods
