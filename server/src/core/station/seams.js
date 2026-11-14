/**
 * Seams on a live station: the scout that listens to every song as it is
 * read, RL's advice at a track change, and Forever mode.
 *
 * Mixed into Station.prototype in ../station.js.
 */
import { SeamScout, ForeverJukebox } from '../seams/index.ts'
import { beatTrackFromFj, fjClient, graphFromFjAnalysis } from '../seams/fj.ts'
import { rl } from '../models/rl.ts'
import { effectUsable } from '../automix/effects.js'
import { effectOutcomes, outcomeReport } from '../automix/outcomes.js'
import { readSeams } from '../models/trainer/dataset.js'

/** How long a station trusts its own scoreboard before re-reading the log. */
const OUTCOME_TTL_MS = 60_000
/** Seams considered: recent enough to describe the station as it is today. */
const OUTCOME_ROWS = 4000

/** The jukebox's crossfade at a jump: half of it either side of the cut. */
const JUKEBOX_FADE_MS = Math.round(((384 * 2) / 44_100) * 1000)

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

  /**
   * What each transition has actually done on this station.
   *
   * `chooseEffect` asks for this at every seam; reading a few thousand log
   * lines per track change would be silly, so the answer is cached for a
   * minute. A station with no log, no store and no history answers `null`, and
   * the heuristic then behaves exactly as it did before this existed.
   */
  effectOutcomes({ refresh = false } = {}) {
    const cache = this._outcomeCache
    if (!refresh && cache && Date.now() - cache.at < OUTCOME_TTL_MS) return cache.value
    let value = null
    try {
      const records = readSeams({ store: this.store, file: this.options?.seamLogFile ?? undefined, limit: OUTCOME_ROWS })
      value = records.length ? effectOutcomes(records) : null
    } catch (error) {
      this.log?.debug?.(`seam scoreboard: ${error.message}`)
      value = null
    }
    this._outcomeCache = { at: Date.now(), value }
    return value
  },

  /**
   * Owner control: Forever mode on or off, and where its analysis comes from.
   *
   * Off lets the song finish. `apiBase` points the jukebox at a Forever
   * Jukebox instance (`off` to use only the node's own analysis); a new base
   * replaces the client, so a console can switch instances without a restart.
   */
  setForever(on = true, { apiBase } = {}) {
    this.options.forever = Boolean(on)
    if (typeof apiBase === 'string' && apiBase.trim()) {
      this.options.foreverApiBase = apiBase.trim()
      this._fj = fjClient({ baseUrl: this.options.foreverApiBase })
    }
    if (!on && this._forever) this._forever.home = true
    this.emit('forever', this.foreverInfo())
    this.log.info(`forever mode ${on ? 'on' : 'off'}${this.options.foreverApiBase ? ` via ${this.options.foreverApiBase}` : ''}`)
    return this.foreverInfo()
  },

  /**
   * The graph Forever should walk, and where it came from.
   *
   * A real Forever Jukebox analysis is better in every way that matters here:
   * its beats come from the recording rather than from our own tracker, its
   * segments carry the twelve-bin timbre and pitch vectors the distance is
   * defined on, and it knows where the bar starts. It is also somebody else's
   * uptime. So: ask, use it if it answers with a graph that can loop, and fall
   * back to the node's own analysis without ceremony if it does not.
   */
  /** The station's client for a Forever Jukebox instance, built on first use. */
  _foreverApi() {
    this._fj ??= fjClient(this.options.foreverApiBase ? { baseUrl: this.options.foreverApiBase } : undefined)
    return this._fj
  },

  async _foreverGraph(track) {
    if (this.options.foreverApi === false) return null
    try {
      const api = this._foreverApi()
      if (!api.enabled) return null
      const analysis = await api.analysisFor({
        title: track.title,
        artist: track.artist,
        durationMs: track.duration ? Math.round(track.duration * 1000) : undefined
      })
      if (!analysis) return null
      const graph = graphFromFjAnalysis(analysis, this.options.jukebox ?? {})
      if (graph.lastBranch < 0 || graph.branching === 0) {
        this.log.info(`forever-jukebox: "${track.title}" has no usable branch`)
        return null
      }
      return { graph, analysis, track: beatTrackFromFj(analysis), source: 'forever-jukebox' }
    } catch (error) {
      this.log.debug(`forever api: ${error.message}`)
      return null
    }
  },

  /**
   * One jump, written as a complete seam.
   *
   * The trainer learns from rows, and a row is only useful if it says as much
   * as the rows the automix writes: both sides described, the distance between
   * them, and what happened next. A jukebox jump has one advantage over a
   * track-to-track seam, which is that both sides are the same song at the
   * same tempo, so anything the model learns from it is about *musical*
   * similarity rather than about two different recordings agreeing.
   */
  _logForeverSeam(track, jump, graph) {
    const scout = this._scoutFor(track?.id)
    const exit = scout?.beatAt?.(jump.fromMs) ?? null
    const entry = scout?.beatAt?.(jump.toMs) ?? null
    const analysis = this._foreverAnalysis
    const beats = scout?.analysis?.()?.track?.beats ?? []
    const beat = (index) => analysis?.beats?.[index] ?? null
    // Level at a beat: the segments' own loudness when a Forever Jukebox
    // analysis is behind the walk, and the scout's measurement when the node
    // built the graph itself.
    const loudness = (index) => {
      const segments = beat(index)?.overlappingSegments
      if (segments?.length) return segments.reduce((sum, segment) => sum + segment.loudness_max, 0) / segments.length
      const local = beats[index]
      return local ? (local.level ?? local.loudMax ?? null) : null
    }
    const energy = (db) => (db === null ? 0.5 : Math.max(0, Math.min(1, (db + 60) / 60)))
    const outDb = loudness(jump.fromBeat)
    const inDb = loudness(jump.toBeat)
    const bpm = analysis?.track?.tempo ?? scout?.analysis?.()?.track?.bpm ?? 0
    return this._logSeam({
      at: Date.now(),
      kind: 'jukebox',
      transition: 'jukebox-jump',
      // What actually carried the audio across: a 17 ms crossfade between two
      // moments of one song. Naming it that way (rather than inventing a
      // transition the automix cannot play) is what makes the row usable by
      // the trainer, which learns from `effect` and `outcome`.
      effect: 'crossfade',
      track: track?.id ?? null,
      outcome: 'completed',
      // Same recording on both sides: the tempo is the same by construction.
      bpmOut: bpm,
      bpmIn: bpm,
      matched: true,
      correlation: 1,
      loudnessGap: outDb !== null && inDb !== null ? outDb - inDb : 0,
      energy: energy(outDb),
      energyIn: energy(inDb),
      vocalOut: beats[exit?.index ?? -1]?.vocal ?? 0,
      vocalIn: beats[entry?.index ?? -1]?.vocal ?? 0,
      fadeMs: JUKEBOX_FADE_MS,
      phraseAligned: jump.fromBar !== undefined && jump.fromBar === jump.toBar,
      talkover: false,
      hour: new Date().getHours(),
      from: { beat: jump.fromBeat, ms: jump.fromMs, bar: jump.fromBar ?? null },
      to: { beat: jump.toBeat, ms: jump.toMs, bar: jump.toBar ?? null },
      distance: jump.distance,
      percent: jump.percent ?? null,
      quality: jump.quality ?? null,
      nudge: jump.nudge,
      exitKind: exit?.category ?? null,
      exitBeat: exit?.descriptor ?? null,
      entryKind: entry?.category ?? null,
      entryBeat: entry?.descriptor ?? null,
      jukebox: graph ? { threshold: graph.threshold, branching: graph.branching, source: graph.source ?? 'local' } : null
    })
  },

  foreverInfo() {
    const jukebox = this._forever
    return {
      enabled: Boolean(this.options.forever),
      active: Boolean(jukebox),
      track: jukebox ? (this._scout?.track?.id ?? null) : null,
      jumps: jukebox?.jumps ?? 0,
      positionMs: jukebox ? Math.round(jukebox.positionMs) : null,
      lastJump: this._lastJump ?? null,
      /** `forever-jukebox` when the jumps came from its analysis. */
      source: this._foreverSource ?? null,
      seams: this._foreverSeams ?? 0,
      api: this.options.foreverApi === false ? null : this._foreverApi().info()
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
      jukebox: jukebox
        ? {
            branching: jukebox.branching,
            threshold: jukebox.threshold,
            lastBranch: jukebox.lastBranch,
            longestBackward: jukebox.longestBackward,
            engine: jukebox.engine,
            source: jukebox.source ?? 'local'
          }
        : null,
      forever: this.foreverInfo(),
      rl: rl().info(),
      // The scoreboard the automix uses: how each transition has done here.
      outcomes: outcomeReport(this.effectOutcomes())
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
    const local = scout.analysis()
    // A Forever Jukebox analysis first: its beats come from the recording, its
    // segments are the vectors the graph's distance is defined on, and it
    // knows where the bar starts. The node's own analysis is the fallback, and
    // it is always there, so a third party being down never stops the station.
    const remote = await this._foreverGraph(track).catch(() => null)
    const analysis = remote ? { ...(local ?? {}), track: remote.track } : local
    const graph = remote?.graph ?? scout.graph()
    this._foreverAnalysis = remote?.analysis ?? null
    this._foreverSource = remote ? remote.source : 'local'
    this._foreverSeams = 0
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
    this.log.info(
      `forever: "${track.title}", ${graph.branching} branching beats of ${analysis.track.beats.length} (${this._foreverSource})`
    )
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
          // Every jump is a seam the trainer can learn from, written in the
          // same shape as the ones the automix logs.
          this._logForeverSeam(track, segment.jump, graph)
          this._foreverSeams += 1
          this.emit('forever', this.foreverInfo())
        }
        if (segment.ended) break
        while (this._running && !this._skipRequested && !jukebox.home && this._bufferedMs > this.options.bufferAheadMs) await this._sleep(120)
      }
    } catch (error) {
      this.log.warn(`forever stopped: ${error.message}`)
    } finally {
      this._forever = null
      this._foreverAnalysis = null
    }
    if (this._running && !this._skipRequested) await giveBack()
    this.emit('forever', this.foreverInfo())
    return true
  }
}

export default seamMethods
