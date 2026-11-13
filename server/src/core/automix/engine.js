/**
 * The Automix engine: hold the tail back, analyse the pair, render one seam.
 */
import createHash from 'node:crypto'
import { MetroFramer, analyseBeat, stretchAudio } from '../../util/metro.js'
import createLogger from '../../util/logger.js'
import { djLine } from '../dj.js'
import {
  DB,
  TO_DB,
  clamp,
  Biquad,
  Crossover,
  integratedLoudness,
  samplePeak,
  detectCues,
  correlation,
  fadeGains,
  exponentFor,
  estimateBeat,
  timeStretch,
  foldTempo,
  compressorGain,
  echoTail,
  brake,
  noiseSource,
  resample,
  tempoCandidates,
  selectTempoPair,
  beatGrid,
  snapCue,
  beatAlignOffset,
  tempoRelease,
  vocalActivity,
  phraseBoundary,
  bandSplit,
  phraseBlend,
  vocalAwareCurves
} from '../dsp.js'
import { DEFAULT_AUTOMIX, AUTO_EFFECT, EFFECTS } from './defaults.js'
import { decodeMp3, encodeMp3 } from './audio.js'
import { fitRate, monoOf, sliceChannels } from './util.js'
import { chooseEffect, chooseEffectWithModel, smartCrossfadeMs, smoothEdges } from './effects.js'
import { EFFECT_RENDERERS } from './renderers.js'
import { analysePair } from './analysis.js'
import { speak, voiceTrack } from './voice.js'

const log = createLogger('automix')

// `models` imports EFFECTS from this module, so it is pulled in lazily. The
// cycle would otherwise resolve with one side holding an uninitialised binding.
let djModels = null
const loadModels = async () => {
  if (djModels !== null) return djModels
  try {
    const module = await import('../models/index.js')
    djModels = module.models ?? null
  } catch {
    djModels = null
  }
  return djModels
}

export class Automix {
  #fifo = [] // withheld tail of the song currently on air
  #fifoMs = 0
  #tail = null // { frames, track, ms } waiting for the next song
  #head = [] // first frames of the incoming song
  #headMs = 0
  #currentId = null
  #currentMs = 0
  #collecting = false
  #lastTrack = null
  #lastEffect = null
  #lastModel = null
  #breaks = 0
  #transitions = 0

  constructor(options = {}, ctx = {}) {
    this.options = { ...DEFAULT_AUTOMIX, ...options, dj: { ...DEFAULT_AUTOMIX.dj, ...(options.dj ?? {}) } }
    this.ctx = ctx
    this.log = ctx.log ?? log
    this.last = null
  }

  get enabled() {
    return this.options.enabled !== false
  }

  configure(patch = {}) {
    const next = { ...this.options, ...patch, dj: { ...this.options.dj, ...(patch.dj ?? {}) } }
    if (patch.effect && patch.effect !== AUTO_EFFECT && !EFFECTS.includes(patch.effect)) {
      throw new Error(`Unknown transition "${patch.effect}" (try: ${AUTO_EFFECT}, ${EFFECTS.join(', ')})`)
    }
    if (patch.effectPool) {
      const unknown = patch.effectPool.filter((name) => !EFFECTS.includes(name))
      if (unknown.length) throw new Error(`Unknown transition(s) in the pool: ${unknown.join(', ')}`)
    }
    this.options = next
    if (!this.enabled) this.reset()
    return this.info()
  }

  info() {
    const { enabled, crossfadeMs, curve, effect, minTrackMs, targetLufs, beatAlign, beatmatch, maxStretchPercent } = this.options
    return {
      enabled,
      crossfadeMs,
      curve,
      effect,
      effects: [...EFFECTS],
      minTrackMs,
      targetLufs,
      beatAlign,
      beatmatch,
      maxStretchPercent,
      analysePair: this.options.analysePair !== false,
      model: this.options.model !== false,
      vocalAware: this.options.vocalAware !== false,
      tempoReleaseMs: this.options.tempoReleaseMs ?? 4000,
      dj: { ...this.options.dj },
      transitions: this.#transitions,
      breaks: this.#breaks,
      pending: this.#fifoMs > 0 || Boolean(this.#tail),
      last: this.last
    }
  }

  reset() {
    this.#fifo = []
    this.#fifoMs = 0
    this.#tail = null
    this.#head = []
    this.#headMs = 0
    this.#collecting = false
    this.#currentId = null
    this.#currentMs = 0
  }

  /**
   * Feed reader frames in, get airable frames out.
   * @param {{data: Buffer, ms: number, track: object}[]} frames
   */
  async push(frames) {
    if (!this.enabled || frames.length === 0) return frames

    const out = []
    for (const frame of frames) {
      const track = frame.track
      const bypass = track?.announcement || track?.live || track?.source === 'tts'

      if (track?.id !== this.#currentId) {
        if (bypass || !this.#eligible()) {
          out.push(...this.#drain())
        } else {
          this.#tail = { frames: this.#fifo, ms: this.#fifoMs, track: this.#lastTrack ?? null }
          this.#fifo = []
          this.#fifoMs = 0
          this.#collecting = true
          this.#head = []
          this.#headMs = 0
        }
        this.#currentId = track?.id ?? null
        this.#currentMs = 0
      }

      this.#currentMs += frame.ms
      this.#lastTrack = track

      if (bypass) {
        out.push(frame)
        continue
      }

      if (this.#collecting) {
        this.#head.push(frame)
        this.#headMs += frame.ms
        if (this.#headMs >= this.#needMs()) out.push(...(await this.#renderSeam()))
        continue
      }

      // Nothing is held back until the item has run long enough to be worth
      // mixing: a station's first seconds stay instant and short idents are
      // never touched.
      if (this.#currentMs < this.options.minTrackMs) {
        out.push(frame)
        continue
      }

      this.#fifo.push(frame)
      this.#fifoMs += frame.ms
      while (this.#fifoMs > this.options.crossfadeMs) {
        const oldest = this.#fifo.shift()
        this.#fifoMs -= oldest.ms
        out.push(oldest)
      }
    }
    return out
  }

  /** Release whatever is being held (end of programme, errors, stop). */
  async flush(reason = 'flush') {
    if (!this.enabled) return []
    if (this.#collecting && this.#headMs > 0) {
      const mixed = await this.#renderSeam(reason)
      return [...mixed, ...this.#drain()]
    }
    return this.#drain()
  }

  #drain() {
    const out = []
    if (this.#tail) {
      out.push(...this.#tail.frames)
      this.#tail = null
    }
    out.push(...this.#fifo, ...this.#head)
    this.#fifo = []
    this.#fifoMs = 0
    this.#head = []
    this.#headMs = 0
    this.#collecting = false
    return out
  }

  #eligible() {
    if (this.#fifoMs <= 0) return false
    if (this.#currentMs < this.options.minTrackMs) return false
    return true
  }

  /** How much of the incoming song the seam needs before it can render. */
  #needMs() {
    const { crossfadeMs, dj, maxRenderMs } = this.options
    // Always collect a couple of seconds more than the blend needs: that is
    // the headroom the cue detector uses to trim silence off the front of the
    // next file, and what the echo/spindown tails ring out into.
    // With Smart Automix the blend can grow beyond the configured length,
    // so collect for the longest one it is allowed to choose.
    const longest = this.options.smart === false ? crossfadeMs : Math.max(crossfadeMs, this.options.maxCrossfadeMs ?? crossfadeMs)
    const base = longest + 2000
    if (!this.#djDue()) return Math.min(maxRenderMs, base)
    return Math.min(maxRenderMs, Math.max(base, dj.leadInMs + 6500 + dj.tailMs))
  }

  #djDue() {
    const dj = this.options.dj
    if (!dj?.enabled || !this.ctx.sources) return false
    return this.#transitions % Math.max(1, Number(dj.every) || 1) === 0
  }

  /* ------------------------------ rendering ------------------------------ */

  async #renderSeam(reason = 'segue') {
    const tail = this.#tail
    const head = this.#head
    this.#tail = null
    this.#head = []
    this.#headMs = 0
    this.#collecting = false

    if (!tail || head.length === 0) return [...(tail?.frames ?? []), ...head]

    const started = Date.now()
    try {
      const mixed = await this.#mix(tail, head)
      if (!mixed) return [...tail.frames, ...head]
      this.#transitions += 1
      this.last = { at: Date.now(), reason, renderMs: Date.now() - started, ...mixed.report }
      this.ctx.station?.emit?.('automix', this.last)
      this.log.info(
        `${mixed.report.effect} ${mixed.report.blendMs}ms ${mixed.report.curve}` +
          (mixed.report.beat?.matched
            ? ` beatmatched ${mixed.report.beat.bpm.toFixed(0)}→${mixed.report.beat.playedAtBpm.toFixed(0)}bpm (${mixed.report.beat.stretchPercent > 0 ? '+' : ''}${mixed.report.beat.stretchPercent}%)`
            : mixed.report.beat?.aligned
              ? ` @${mixed.report.beat.bpm.toFixed(0)}bpm`
              : '') +
          `: "${tail.track?.title ?? '?'}" → "${head[0]?.track?.title ?? '?'}"` +
          ` [match ${mixed.report.loudness.appliedDb > 0 ? '+' : ''}${mixed.report.loudness.appliedDb} dB, peak ${mixed.report.peakDb} dBFS` +
          (mixed.report.dj ? `, DJ ${mixed.report.dj.kind}` : '') +
          `, ${Date.now() - started}ms]`
      )
      return mixed.frames
    } catch (error) {
      this.log.warn(`transition failed (${error.message}); hard cut instead`)
      return [...tail.frames, ...head]
    }
  }

  async #mix(tail, head) {
    const rawA = await decodeMp3(Buffer.concat(tail.frames.map((f) => f.data)))
    if (!rawA) return null
    const rawB = await decodeMp3(Buffer.concat(head.map((f) => f.data)))
    if (!rawB) return null

    const sampleRate = rawB.sampleRate
    const a0 = fitRate(rawA, sampleRate)
    const b0 = rawB
    const sec = (ms) => Math.round((ms / 1000) * sampleRate)
    const ms = (samples) => Math.round((samples / sampleRate) * 1000)

    /* 1. loudness (BS.1770) ------------------------------------------------ */
    const loudA = integratedLoudness([a0.left, a0.right], sampleRate)
    const loudB = integratedLoudness([b0.left, b0.right], sampleRate)

    /* 2. cue points -------------------------------------------------------- */
    const monoA = monoOf(a0)
    const monoB = monoOf(b0)
    const cuesA = detectCues(monoA, sampleRate, { integrated: loudA })
    const cuesB = detectCues(monoB, sampleRate, { integrated: loudB })

    const trim = this.options.trimSilence !== false
    const aStart = 0
    const aEnd = trim ? Math.max(sec(500), cuesA.cueOut) : a0.length
    const bStart = trim ? Math.min(cuesB.cueIn, Math.max(0, b0.length - sec(2000))) : 0
    let a = sliceChannels(a0, aStart, aEnd)
    let b = sliceChannels(b0, bStart, b0.length)
    if (a.length < sec(400) || b.length < sec(400)) return null

    /* 3. loudness match ---------------------------------------------------- */
    let matchDb = 0
    if (loudA != null && loudB != null) matchDb = clamp(loudA - loudB, -this.options.maxGainDb, this.options.maxGainDb)
    const matchGain = DB(matchDb)

    /* 4. tempo pair, beat grid + beatmatch -------------------------------- */
    // Both tempos at once, off the event loop when libmetro is there: this
    // is the stage that used to cost most of a second on a long crossfade,
    // and the pacer has to keep releasing frames while it runs.
    //
    // automix-engine's first real insight: the pair is what matters. Two
    // independent estimates plus a fold picks the wrong octave often enough
    // to hear; scoring every candidate pair for agreement (and for sitting
    // near 100 BPM, where real songs live) is the fix. The scalar estimator
    // stays as the default so the native path keeps its speed, and the pair
    // search only runs when both songs were unconfident or disagree badly.
    let beatA = null
    let beatB = null
    let pairChoice = null
    if (this.options.beatAlign) {
      ;[beatA, beatB] = await Promise.all([analyseBeat(monoA.subarray(aStart, aEnd), sampleRate), analyseBeat(monoB.subarray(bStart), sampleRate)])
      pairChoice = await analysePair(this.options, monoA.subarray(aStart, aEnd), monoB.subarray(bStart), sampleRate, beatA, beatB)
      if (pairChoice?.beatA) beatA = pairChoice.beatA
      if (pairChoice?.beatB) beatB = pairChoice.beatB
    }
    const confident = Boolean(beatA && beatB && beatA.confidence > 0.25 && beatB.confidence > 0.25)

    // The grid the *rendered* seam runs on. Without beatmatching that is the
    // outgoing song's own grid; with it, the incoming song's tempo.
    let beatPeriod = confident ? beatA.periodSamples : 0
    let beatAt = (n) => (confident ? beatA.phaseSamples + n * beatA.periodSamples : 0)
    let tempoScale = 1
    let beatmatch = null
    let release = null

    if (confident && this.options.beatmatch !== false) {
      // 174 BPM against 87 BPM is the same groove at half time: fold first.
      const folded = foldTempo(beatB.bpm, beatA.bpm)
      const ratio = beatA.bpm / folded.bpm // < 1 speeds the outgoing song up
      const driftPercent = Math.abs(1 - ratio) * 100
      const limit = Number(this.options.maxStretchPercent ?? 12)

      if (driftPercent > 0.3 && driftPercent <= limit) {
        // Ride the pitch fader instead of stamping on it: the tempo change
        // eases in over two beats, then holds at the incoming song's tempo.
        const ramp = Math.round(Math.min(a.length * 0.5, beatA.periodSamples * 2 * ratio))
        const stretched = await stretchAudio([a.left, a.right], sampleRate, { stretch: ratio, rampSamples: ramp })
        a = { left: stretched.channels[0], right: stretched.channels[1], sampleRate, length: stretched.length }
        const warp = stretched.map
        tempoScale = ratio
        beatPeriod = Math.round((60 * sampleRate) / folded.bpm)
        beatAt = (n) => Math.round(warp.outputAt(beatA.phaseSamples + n * beatA.periodSamples))
        beatmatch = {
          fromBpm: Number(beatA.bpm.toFixed(2)),
          toBpm: Number(folded.bpm.toFixed(2)),
          rawBpm: Number(beatB.bpm.toFixed(2)),
          stretchPercent: Number(((ratio - 1) * 100).toFixed(2)),
          rampMs: ms(ramp)
        }

        // Tempo *release*: automix-engine returns the incoming song to its own
        // tempo over a fixed wall-clock window rather than leaving it stretched
        // for the rest of the track. This node renders only the seam, so the
        // release is reported for the rest of the song: the incoming material
        // after the seam is aired untouched, which is the same listener-side
        // result (it returns to native speed), just achieved by not processing
        // it. The map is still built, because the report is how the console
        // shows what will happen and how long it takes.
        release = tempoRelease(b.length, sampleRate, {
          fromRate: folded.bpm / beatB.bpm,
          releaseSeconds: Math.max(0.5, Number(this.options.tempoReleaseMs ?? 4000) / 1000)
        })
      }
    }

    // Phase lock: shift the incoming song by less than one beat so its grid
    // falls exactly on the (possibly warped) grid of the outgoing one.
    let alignShift = 0
    if (confident && beatPeriod > 0) {
      let n = 0
      while (beatAt(n) < 0 && n < 64) n += 1
      alignShift = beatAlignOffset(beatPeriod, beatAt(n), beatB.phaseSamples, b.length, {
        maxFraction: this.options.cueTolerance ?? 0.6
      })
      if (alignShift > 0) b = sliceChannels(b, alignShift, b.length)
    }

    /* 5. blend length ------------------------------------------------------ */
    // Two facts about the pair decide both the length and the curve: how
    // well they correlate at the seam, and how hard the incoming song
    // enters. Measured over a fixed window so the answer does not depend on
    // the blend length we are about to choose from it.
    const seamWindow = Math.min(a.length, b.length, sec(1500))
    const r = seamWindow > 0 ? correlation(monoOf(a).subarray(0, seamWindow), monoOf(b).subarray(0, seamWindow), seamWindow) : 0

    const entryWindow = Math.min(b.left.length, Math.max(1, sec(1000)))
    let entrySum = 0
    for (let i = 0; i < entryWindow; i += 1) entrySum += (b.left[i] ?? 0) ** 2
    const entryEnergy = clamp(Math.sqrt(entrySum / entryWindow) * 4, 0, 1)

    // Smart Automix: how long should *this* blend be? (see smartCrossfadeMs)
    const smart = smartCrossfadeMs(
      {
        matched: Boolean(beatmatch),
        tempoDelta: Math.abs((beatA?.bpm ?? 0) - (beatB?.bpm ?? 0)),
        correlation: r,
        energy: entryEnergy,
        bpm: beatmatch ? beatmatch.toBpm : (beatB?.bpm ?? beatA?.bpm ?? null),
        available: ms(Math.min(a.length, b.length))
      },
      this.options
    )
    let fade = Math.min(sec(smart.ms), a.length, b.length)
    // Where the outgoing song's ending actually begins (its overlay point),
    // measured in the rendered timeline — the stretch moved it.
    const endingFrom = Math.max(0, Math.round((aEnd - cuesA.overlay) * tempoScale))
    if (endingFrom > sec(400)) fade = Math.min(fade, Math.max(sec(1000), endingFrom))

    let phrase = null
    if (confident && beatPeriod > 0) {
      // Whole beats only, and a whole phrase (4 beats) when one fits inside
      // the audio we are actually holding. Rounding up and then clamping
      // would silently put the blend back off the grid, so round down.
      const available = Math.min(fade, a.length, b.length)
      if (this.options.phraseBlend !== false) {
        // automix-engine maps a fixed count of beats (32) and lets the clock
        // follow the music; a radio seam is the same idea in the other
        // direction — the *length* is a whole number of phrases and the
        // milliseconds follow. A phrase is what a listener hears as "one
        // thing", so an eight-beat blend at 80 BPM and at 140 BPM are both
        // musically the same move.
        phrase = phraseBlend({ bpm: beatmatch ? beatmatch.toBpm : beatA.bpm, availableSamples: available, sampleRate, minBeats: 8, maxBeats: 64 })
        if (phrase) fade = Math.min(phrase.samples, Math.max(sec(400), phrase.samples))
      }
      let beats = Math.max(1, Math.floor(Math.min(fade, available) / beatPeriod))
      if (beats >= 4) beats -= beats % 4
      fade = Math.round(beats * beatPeriod)
      if (phrase) phrase = { ...phrase, beats, samples: fade, phrases: beats / 4 }
    }
    if (fade < sec(400)) return null

    /* 6. the mix ----------------------------------------------------------- */
    // Curve: correlation decides unless the owner pinned one.
    const exponent = this.options.curve === 'equal-power' ? 2 : this.options.curve === 'equal-gain' ? 1 : exponentFor(r)

    // Vocal-aware shaping (automix-engine's "do not fade a lyric mid-line").
    // Without stems the honest proxy is the band-energy gate in
    // `vocalActivity`: is anything singing on the outgoing seam, and if so,
    // where does the line end? The answer changes the *shape* of the faders,
    // never the length of the blend, so a misdetection costs a slightly
    // different curve rather than a wrong transition.
    let vocal = null
    let shape = null
    if (this.options.vocalAware !== false && confident) {
      const outMono = monoOf(a)
      const inMono = monoOf(b)
      const outActive = vocalActivity(outMono.subarray(0, Math.min(outMono.length, fade)), sampleRate)
      const inActive = vocalActivity(inMono.subarray(0, Math.min(inMono.length, Math.max(fade, sec(2000)))), sampleRate)
      const boundary = outActive.active
        ? phraseBoundary(outMono, sampleRate, 0, { beats: beatGrid(outMono.length, sampleRate, (beatmatch?.toBpm ?? beatA.bpm) || 120), maxWaitMs: Math.min(1600, ms(fade) * 0.4) })
        : null
      shape = vocalAwareCurves({
        outgoingActive: outActive.active,
        incomingActive: inActive.active,
        phraseEnd: boundary?.waited ? clamp(boundary.sample / Math.max(1, fade), 0.25, 0.9) : 0.6,
        exponent
      })
      vocal = {
        outgoing: outActive.active,
        incoming: inActive.active,
        shape: shape.shape,
        phraseEndMs: boundary?.waited ? ms(boundary.sample) : null,
        why: boundary?.reason ?? (outActive.active ? 'line continues' : 'no vocal at the seam')
      }
    }
    const gainFor = shape ? (t) => [shape.aGain(t), shape.bGain(t)] : (t) => fadeGains(t, exponent)

    // Voice first: it can make the rendered segment longer than the blend.
    let voice = null
    let dj = null
    if (this.#djDue()) {
      dj = djLine({
        from: tail.track,
        to: head[0]?.track,
        station: this.ctx.station?.name ?? 'the station',
        dj: this.options.dj.name,
        listeners: this.ctx.station?.subscribers?.size ?? 0,
        index: this.#breaks
      })
      voice = await speak({ sources: this.ctx.sources, options: this.options, log: this.log }, dj.text, sampleRate)
      if (!voice) dj = null
      else this.#breaks += 1
    }

    const voiceStart = voice ? sec(this.options.dj.leadInMs) : 0
    const needed = Math.max(fade, voice ? voiceStart + voice.length + sec(this.options.dj.tailMs) : 0)
    const total = Math.min(needed, b.length, sec(this.options.maxRenderMs))

    // Apply the match gain to the incoming song for the seam, then ease it
    // back to the song's own level so the rest of the track is untouched.
    if (matchDb !== 0) {
      const bGained = { left: new Float32Array(total), right: new Float32Array(total), sampleRate, length: total }
      const restore = Math.max(1, sec(1500))
      for (let i = 0; i < total; i += 1) {
        const back = i > total - restore ? (i - (total - restore)) / restore : 0
        const g = matchGain + (1 - matchGain) * back
        bGained.left[i] = (b.left[i] ?? 0) * g
        bGained.right[i] = (b.right[i] ?? 0) * g
      }
      b = bGained
    }

    const left = new Float32Array(total)
    const right = new Float32Array(total)

    // Which transition? Either the one the owner named, or — the default —
    // one chosen for this particular seam (see chooseEffect).
    const wanted = this.options.effect ?? AUTO_EFFECT
    const seamDescription = {
      beat: confident,
      matched: Boolean(beatmatch),
      tempoDelta: Math.abs((beatA?.bpm ?? 0) - (beatB?.bpm ?? 0)),
      correlation: r,
      fadeMs: ms(fade),
      energy: entryEnergy,
      talkover: Boolean(voice),
      previous: this.options.varyEffects === false ? null : this.#lastEffect,
      // The model's richer view of the same seam: tempos on both sides, the
      // loudness gap, vocal activity, and the time of day.
      bpmOut: beatA?.bpm ?? 0,
      bpmIn: beatB?.bpm ?? 0,
      loudnessGap: matchDb,
      vocalOut: vocal?.outgoing ? 1 : 0,
      vocalIn: vocal?.incoming ? 1 : 0,
      phraseAligned: Boolean(phrase)
    }
    let choice = { effect: chooseEffect(seamDescription, this.options.effectPool ?? []), source: 'heuristic' }
    if (wanted === AUTO_EFFECT || !EFFECT_RENDERERS[wanted]) {
      // The DJ model, when one is loaded and the owner has not turned it off.
      // A model is an *opinion*, not a requirement: `score()` returns null for
      // every failure mode, and the heuristic then answers as it always did.
      if (this.options.model !== false) {
        const host = await loadModels()
        const scored = host ? host.score(seamDescription) : null
        if (scored) choice = chooseEffectWithModel(seamDescription, this.options.effectPool ?? [], scored)
      }
      this.#lastModel = choice.model ?? null
    }
    const effect = wanted === AUTO_EFFECT || !EFFECT_RENDERERS[wanted] ? choice.effect : wanted
    this.#lastEffect = effect

    EFFECT_RENDERERS[effect]({
      a,
      b,
      left,
      right,
      fade,
      total,
      gainFor,
      sampleRate,
      options: this.options,
      beatSamples: confident ? beatPeriod : 0
    })

    /* 7. the DJ, over a real sidechain ducker ------------------------------ */
    if (voice) voiceTrack(this.options, { left, right, voice, voiceStart, sampleRate })

    /* 8. make it joinable -------------------------------------------------- */
    // The seam is spliced between audio nobody rendered; every effect leaves
    // its own mess at the edges. This is what lets one transition follow
    // another without a click between them.
    smoothEdges(left, right, sampleRate)

    /* 9. peak ceiling ------------------------------------------------------ */
    const ceiling = DB(this.options.ceilingDb)
    const peak = samplePeak([left, right])
    if (peak > ceiling) {
      const g = ceiling / peak
      for (let i = 0; i < total; i += 1) {
        left[i] *= g
        right[i] *= g
      }
    }

    /* 10. back to MP3 ------------------------------------------------------ */
    const bitrate = Math.max(96, Math.min(320, head[0]?.track?.streamBitrate ?? this.options.bitrate ?? 128))
    const mp3 = await encodeMp3({ left, right, sampleRate, bitrate })
    const parsed = new MetroFramer().push(mp3)
    if (parsed.frames.length === 0) return null

    const frameMs = parsed.durationMs / parsed.frames.length
    const track = { ...head[0].track, automix: true, mixedFrom: tail.track?.title ?? null, dj: dj?.text ?? null }
    const frames = parsed.frames.map((data) => ({ data, ms: frameMs, track }))

    // Whatever of the incoming song the render did not consume is aired as it
    // arrived (plus whatever was trimmed off the front, which is silence).
    const consumedMs = ms(total + bStart + alignShift)
    let skipped = 0
    const rest = []
    for (const frame of head) {
      skipped += frame.ms
      if (skipped > consumedMs) rest.push(frame)
    }

    return {
      frames: [...frames, ...rest],
      report: {
        from: tail.track?.title ?? null,
        to: head[0]?.track?.title ?? null,
        effect,
        // Was this one chosen for the seam, or named by the owner?
        chosen: (this.options.effect ?? AUTO_EFFECT) === AUTO_EFFECT,
        // Which brain chose it, and what the other one would have picked. An
        // owner looking at a surprising transition can see the disagreement
        // rather than having to infer it.
        decision: {
          source: (this.options.effect ?? AUTO_EFFECT) === AUTO_EFFECT ? choice.source : 'owner',
          baseline: (this.options.effect ?? AUTO_EFFECT) === AUTO_EFFECT ? choice.baseline : null,
          margin: choice.margin ?? null,
          model: choice.model ?? null
        },
        entryEnergy: Number(entryEnergy.toFixed(2)),
        curve: exponent >= 1.95 ? 'equal-power' : exponent <= 1.05 ? 'equal-gain' : `blend(${exponent.toFixed(2)})`,
        correlation: Number(r.toFixed(3)),
        blendMs: ms(fade),
        // Smart Automix: what it asked for, and why.
        blend: { requestedMs: this.options.crossfadeMs, chosenMs: smart.ms, bars: smart.bars, why: smart.why },
        renderedMs: ms(total),
        loudness: {
          from: loudA == null ? null : Number(loudA.toFixed(1)),
          to: loudB == null ? null : Number(loudB.toFixed(1)),
          appliedDb: Number(matchDb.toFixed(1))
        },
        cues: { trimmedHeadMs: ms(bStart), trimmedTailMs: ms(a0.length - aEnd), endingFromMs: ms(endingFrom) },
        beat: {
          aligned: confident && alignShift > 0,
          matched: Boolean(beatmatch),
          bpm: beatA?.bpm ?? null,
          incomingBpm: beatB?.bpm ?? null,
          playedAtBpm: beatmatch ? beatmatch.toBpm : (beatA?.bpm ?? null),
          stretchPercent: beatmatch?.stretchPercent ?? 0,
          shiftMs: ms(alignShift),
          beatsInBlend: beatPeriod ? Math.round(fade / beatPeriod) : 0,
          confidence: beatA ? Number(beatA.confidence.toFixed(2)) : null,
          // Joint tempo analysis: the pair chosen, and how well it agrees.
          pair: pairChoice
            ? { bpmA: pairChoice.bpmA, bpmB: pairChoice.bpmB, compatibility: pairChoice.compatibility, source: 'pair' }
            : { source: 'scalar' },
          // Phrase-aligned blend length (automix-engine's 32-beat map, here).
          phrase: phrase ? { beats: phrase.beats, phrases: phrase.phrases, beatMs: ms(phrase.beatSamples) } : null,
          // Tempo release: how long the incoming song takes to reach native speed.
          releaseMs: release ? ms(release.releaseSamples) : null
        },
        vocal,
        peakDb: Number(TO_DB(Math.min(peak, ceiling)).toFixed(1)),
        dj: dj ? { kind: dj.kind, text: dj.text } : null
      }
    }
  }
}

export default Automix
