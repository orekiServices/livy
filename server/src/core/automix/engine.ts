/**
 * The Automix engine: hold the tail back, analyse the pair, render one seam.
 */
import { analyseBeat, stretchAudio } from '../../util/metro.ts'
import createLogger from '../../util/logger.ts'
import { djLine } from '../dj.ts'
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
  foldTempo,
  compressorGain,
  echoTail,
  brake,
  noiseSource,
  resample,
  beatGrid,
  snapCue,
  beatAlignOffset,
  tempoRelease,
  vocalActivity,
  phraseBoundary,
  bandSplit,
  phraseBlend,
  vocalAwareCurves
} from '../dsp/index.ts'
import { DEFAULT_AUTOMIX, AUTO_EFFECT, EFFECTS } from './defaults.ts'
import { codec, codecKey, decodeFrames, samplesIn } from '../../util/codec.ts'
import { LEAD_FRAMES, bridge, reservoirBefore } from '../../util/splice.ts'
import { fitRate, monoOf, sliceChannels } from './util.ts'
import { smartCrossfadeMs, smoothEdges } from './effects.ts'
import { EFFECT_RENDERERS } from './renderers.ts'
import { getSongBpmTempo, getSongBpmStatus } from './getsongbpm.ts'
import { estimateBPMi, makeBpmProfile } from '../models/bpmi.ts'
import { speak, voiceTrack } from './voice.ts'
import {
  analyzeTrackStructure,
  harmonicCompatibility,
  rhythmSimilarity,
  type TrackStructure
} from './structure.ts'
import { planTransition, type TransitionPlanResult } from './planner.ts'

const log = createLogger('automix')

export class Automix {
  declare ctx: any
  declare last: any
  declare log: any
  declare options: any

  #fifo = [] // withheld tail of the song currently on air
  #fifoMs = 0
  #tail = null // { frames, track, ms } waiting for the next song
  #head = [] // first frames of the incoming song
  #headMs = 0
  #currentId = null
  #currentMs = 0
  #collecting = false
  #context = [] // the last frames aired before the FIFO: decoder run-up for the seam
  #lastTrack = null
  #lastEffect = null
  #lastModel = null
  #breaks = 0
  #transitions = 0

  constructor(options: any = {}, ctx: any = {}) {
    this.options = { ...DEFAULT_AUTOMIX, ...options, dj: { ...DEFAULT_AUTOMIX.dj, ...(options.dj ?? {}) } }
    // Migrate old station configs in memory: legacy transition names now map
    // to auto-crossfade and can never reach a renderer. The old effect
    // classifier and automation-model switches are also inert now.
    if (![AUTO_EFFECT, 'crossfade'].includes(this.options.effect)) this.options.effect = AUTO_EFFECT
    this.options.effectPool = []
    this.options.model = false
    this.options.continuousBlend = false
    this.options.neuralAutomix = false
    this.ctx = ctx
    this.log = ctx.log ?? log
    this.last = null
  }

  get enabled() {
    return this.options.enabled !== false
  }

  configure(patch: any = {}) {
    const next = { ...this.options, ...patch, dj: { ...this.options.dj, ...(patch.dj ?? {}) } }
    if (patch.effect != null && ![AUTO_EFFECT, 'crossfade'].includes(patch.effect)) {
      throw new Error(`Automix supports crossfade only (try: ${AUTO_EFFECT}, crossfade)`)
    }
    if (patch.curve != null && !['auto', 'equal-power', 'equal-gain'].includes(patch.curve)) {
      throw new Error(`Unknown fade curve "${patch.curve}" (try: auto, equal-power, equal-gain)`)
    }
    if (patch.effectPool != null) {
      if (!Array.isArray(patch.effectPool)) throw new Error('Automix effectPool must be an array')
      const unknown = patch.effectPool.filter((name) => !EFFECTS.includes(name))
      if (unknown.length) throw new Error(`Automix supports crossfade only; unsupported transition(s): ${unknown.join(', ')}`)
    }
    next.effectPool = []
    next.model = false
    next.continuousBlend = false
    next.neuralAutomix = false
    this.options = next
    if (!this.enabled) this.reset()
    return this.info()
  }

  info() {
    const { enabled, crossfadeMs, curve, effect, minTrackMs, targetLufs, beatAlign, beatmatch, maxStretchPercent, smart, phraseBlend } = this.options
    return {
      enabled,
      crossfadeMs,
      curve,
      effect,
      smart: smart !== false,
      phraseBlend: phraseBlend !== false,
      effects: [...EFFECTS],
      minTrackMs,
      targetLufs,
      beatAlign,
      beatmatch,
      beatmatchSource: 'GetSongBPM',
      beatmatchService: getSongBpmStatus(),
      maxStretchPercent,
      analysePair: false,
      mode: 'crossfade-only',
      model: false,
      intelligent: this.options.intelligent !== false,
      continuousBlend: false,
      neuralAutomix: false,
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
    this.#context = []
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
          this.#tail = { frames: this.#fifo, ms: this.#fifoMs, track: this.#lastTrack ?? null, context: this.#context }
          this.#fifo = []
          this.#fifoMs = 0
          this.#collecting = true
          this.#head = []
          this.#headMs = 0
        }
        this.#currentId = track?.id ?? null
        this.#currentMs = 0
        this.#context = []
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
        this.#remember(frame)
        out.push(frame)
        continue
      }

      this.#fifo.push(frame)
      this.#fifoMs += frame.ms
      const hold = this.holdMs
      while (this.#fifoMs > hold) {
        const oldest = this.#fifo.shift()
        this.#fifoMs -= oldest.ms
        this.#remember(oldest)
        out.push(oldest)
      }
    }
    return out
  }

  /**
   * How much of the song on air is held back.
   *
   * The blend can be no longer than this, so with Smart Automix it is more
   * than `crossfadeMs`: a seam that deserves twelve seconds cannot have them
   * if only six were kept. It is not the whole `maxCrossfadeMs` either — the
   * incoming song has to be read for as long as the tail is before the seam
   * can render, and a source that delivers at 1× would run the buffer dry.
   * The extra tenth of a second is the three frames the splice keeps intact.
   */
  get holdMs() {
    const { crossfadeMs, maxCrossfadeMs, holdMs, smart } = this.options
    if (smart === false) return crossfadeMs + 100
    return clamp(Number(holdMs) || DEFAULT_AUTOMIX.holdMs, crossfadeMs, Math.max(crossfadeMs, maxCrossfadeMs ?? crossfadeMs)) + 100
  }

  /** Keep the last few aired frames: the seam decode needs a run-up. */
  #remember(frame) {
    this.#context.push(frame.data)
    if (this.#context.length > 4) this.#context.shift()
  }

  /**
   * Take back the newest `count` held frames of the song on air.
   *
   * The jukebox uses this at the end of a song: the frames it would rather
   * not air (the fade-out, the silence) are still here, so it removes them
   * and continues from somewhere else in the same song.
   * @returns {number} how many frames were actually withdrawn
   */
  retract(count) {
    if (this.#collecting || this.#tail) return 0
    const take = Math.max(0, Math.min(count, this.#fifo.length))
    for (let i = 0; i < take; i += 1) this.#fifoMs -= this.#fifo.pop().ms
    return take
  }

  /** Frames of the current song being held, newest last. */
  get heldFrames() {
    return this.#collecting || this.#tail ? 0 : this.#fifo.length
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
    //
    // The blend cannot be longer than the tail that was held, so that — not
    // `maxCrossfadeMs` — is what bounds the wait. Collecting thirty seconds
    // of the next song for a six second tail kept a 1× source off air for
    // most of half a minute. The landing is where the seam is eased back
    // onto the incoming song's own frame grid (see `#mix`, step 9).
    const longest = Math.min(this.holdMs, this.#tail?.ms ?? this.holdMs)
    const base = Math.max(crossfadeMs, longest) + 2000 + this.landingMs
    if (!this.#djDue()) return Math.min(maxRenderMs, base)
    return Math.min(maxRenderMs, Math.max(base, dj.leadInMs + 6500 + dj.tailMs + this.landingMs))
  }

  get landingMs() {
    return clamp(Number(this.options.landingMs ?? DEFAULT_AUTOMIX.landingMs) || 0, 300, 6000)
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
    let mixed = null
    let fallbackReason = null
    let serviceError = null
    try {
      mixed = await this.#mix(tail, head)
      if (!mixed) fallbackReason = 'the crossfade render could not be completed'
    } catch (error: any) {
      const detail = error instanceof Error ? error.message : String(error)
      if (error?.service === 'GetSongBPM') {
        serviceError = { service: error.service, code: error.code ?? 'service_error', message: detail, status: error.status ?? null }
        fallbackReason = detail
      } else {
        fallbackReason = 'crossfade renderer failed'
      }
      this.log.warn(`crossfade failed (${detail}); retrying with a safe crossfade`)
    }

    if (!mixed) {
      try {
        mixed = await this.#mix(tail, head, { safeFallback: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.log.warn(`safe crossfade failed (${message})`)
      }
    }

    if (!mixed) {
      this.log.warn(`no decodable audio for a crossfade (${fallbackReason ?? 'unknown render failure'}); passing through original frames`)
      return [...tail.frames, ...head]
    }

    this.#transitions += 1
    this.last = {
      at: Date.now(),
      reason,
      renderMs: Date.now() - started,
      ...(fallbackReason
        ? { fallback: { effect: 'crossfade', reason: fallbackReason, ...(serviceError ? { serviceError } : {}) } }
        : {}),
      ...(serviceError ? { serviceError } : {}),
      ...mixed.report
    }
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
        (fallbackReason ? ', safe crossfade fallback' : '') +
        `, ${Date.now() - started}ms]`
    )
    return mixed.frames
  }

  async #mix(tail, head, { safeFallback = false }: { safeFallback?: boolean } = {}) {
    const options = safeFallback
      ? {
          ...this.options,
          smart: false,
          curve: 'equal-power',
          effect: 'crossfade',
          effectPool: ['crossfade'],
          intelligent: false,
          model: false,
          neuralAutomix: false,
          continuousBlend: false,
          beatAlign: false,
          beatmatch: false,
          vocalAware: false,
          trimSilence: false,
          dj: { ...this.options.dj, enabled: false }
        }
      : this.options
    // Decode on the frame grid: sample 0 of each buffer is the first sample
    // of its first frame, which is what lets the seam be put back between
    // frames nobody re-encoded. The outgoing side is decoded with a run-up of
    // frames that already aired, so its first samples are real audio rather
    // than a decoder finding its feet.
    const tailFrames = tail.frames.map((f) => f.data)
    const headFrames = head.map((f) => f.data)
    const context = tail.context ?? []
    const rawAll = await decodeFrames([...context, ...tailFrames])
    if (!rawAll) return null
    const skip = Math.min(rawAll.length, samplesIn(context))
    const rawA = { left: rawAll.left.subarray(skip), right: rawAll.right.subarray(skip), sampleRate: rawAll.sampleRate, length: rawAll.length - skip }
    const rawB = await decodeFrames(headFrames)
    if (!rawB) return null

    const sampleRate = rawB.sampleRate
    const a0 = fitRate(rawA, sampleRate)
    const b0 = rawB
    const sec = (ms) => Math.round((ms / 1000) * sampleRate)
    const ms = (samples) => Math.round((samples / sampleRate) * 1000)

    // The splice: the first frames of the tail go out exactly as they came,
    // the frame after them is encoded by us but still *is* the original audio
    // (so the two encodings overlap on identical material), and everything
    // from `free` on is ours to change. Worked in output-rate samples; when
    // the two songs share a rate — nearly always — `passFrames` is
    // `LEAD_FRAMES` and `xStart` is 0.
    const spf = samplesIn([headFrames[0]])
    const spfA = samplesIn([tailFrames[0]])
    const passFrames = Math.ceil((LEAD_FRAMES * spf * rawA.sampleRate) / (sampleRate * spfA) - 1e-9)
    const passEnd = Math.round((passFrames * spfA * sampleRate) / rawA.sampleRate)
    const xStart = Math.max(0, passEnd - LEAD_FRAMES * spf)
    const free = passEnd + spf
    if (tailFrames.length <= passFrames + 2 || a0.length < free + sec(400)) return null

    /* 1. loudness (BS.1770) ------------------------------------------------ */
    const loudA = safeFallback ? null : integratedLoudness([a0.left, a0.right], sampleRate)
    const loudB = safeFallback ? null : integratedLoudness([b0.left, b0.right], sampleRate)

    /* 2. cue points -------------------------------------------------------- */
    const monoA = monoOf(a0)
    const monoB = monoOf(b0)
    const cuesA = safeFallback ? { cueOut: a0.length, overlay: a0.length } : detectCues(monoA, sampleRate, { integrated: loudA })
    const cuesB = safeFallback ? { cueIn: 0 } : detectCues(monoB, sampleRate, { integrated: loudB })

    const trim = options.trimSilence !== false
    const aStart = free
    const aEnd = Math.min(a0.length, trim ? Math.max(free + sec(500), cuesA.cueOut) : a0.length)
    const bStart = trim ? Math.min(cuesB.cueIn, Math.max(0, b0.length - sec(2000))) : 0
    let a = sliceChannels(a0, aStart, aEnd)
    let b = sliceChannels(b0, bStart, b0.length)
    if (a.length < sec(400) || b.length < sec(400)) return null

    /* 3. loudness match ---------------------------------------------------- */
    let matchDb = 0
    if (loudA != null && loudB != null) matchDb = clamp(loudA - loudB, -options.maxGainDb, options.maxGainDb)
    const matchGain = DB(matchDb)

    /* 4. tempo pair, beat grid + beatmatch -------------------------------- */
    // The service supplies both published tempos. Waveform analysis estimates
    // phase only, so missing credentials or an unavailable API never silently
    // falls back to a local BPM estimator.
    let beatA = null
    let beatB = null
    let pairChoice = null
    let bpmIProfiles = null
    let bpmIEstimates = null
    if (options.beatAlign) {
      // BPM is always sourced from GetSongBPM for rendering. Local tempo
      // candidates are recorded for the separate CPU BPMi trainer, but they
      // never replace the service result in this beatmatch path.
      const trackA = tail.track ?? tail.frames[0]?.track
      const trackB = head[0]?.track
      const tempoLookup = this.ctx.getSongBpmTempo ?? getSongBpmTempo
      const [tempoA, tempoB] = await Promise.all([tempoLookup(trackA), tempoLookup(trackB)])
      const [phaseA, phaseB] = await Promise.all([
        analyseBeat(monoA.subarray(aStart, aEnd), sampleRate).catch(() => null),
        analyseBeat(monoB.subarray(bStart), sampleRate).catch(() => null)
      ])
      const remoteGrid = (metadata, phaseEstimate) => {
        const bpm = Number(metadata?.tempo)
        if (!Number.isFinite(bpm) || bpm < 40 || bpm > 220) {
          throw new Error('GetSongBPM returned a tempo outside the supported range (40–220 BPM).')
        }
        const periodSamples = (60 * sampleRate) / bpm
        const estimatedPeriod = Number(phaseEstimate?.periodSamples)
        const rawPhase = Number(phaseEstimate?.phaseSamples) || 0
        const phaseFraction = estimatedPeriod > 0
          ? (((rawPhase % estimatedPeriod) + estimatedPeriod) % estimatedPeriod) / estimatedPeriod
          : 0
        return {
          bpm,
          periodSamples,
          phaseSamples: phaseFraction * periodSamples,
          confidence: Number(phaseEstimate?.confidence) || 0,
          serviceConfidence: Number(metadata?.confidence) || 0,
          source: 'GetSongBPM',
          serviceTrack: { id: metadata.id, title: metadata.title, artist: metadata.artist, uri: metadata.uri }
        }
      }
      beatA = remoteGrid(tempoA, phaseA)
      beatB = remoteGrid(tempoB, phaseB)
      // Capture four-second local candidate profiles at the actual seam. BPMi
      // trains on these CPU DSP observations across the whole node, but it is
      // diagnostic here: GetSongBPM remains the tempo used by the renderer.
      const profileAWindow = monoA.subarray(aStart, aEnd)
      const profileBWindow = monoB.subarray(bStart)
      const profileSamples = Math.round(sampleRate * 4)
      const profileA = makeBpmProfile(
        profileAWindow.subarray(Math.max(0, profileAWindow.length - profileSamples)),
        sampleRate,
        { confidence: phaseA?.confidence, scalarBpm: phaseA?.bpm, scalarConfidence: phaseA?.confidence, track: trackA, referenceBpm: beatA.bpm, referenceSource: beatA.source, labelConfidence: beatA.serviceConfidence }
      )
      const profileB = makeBpmProfile(
        profileBWindow.subarray(0, Math.min(profileBWindow.length, profileSamples)),
        sampleRate,
        { confidence: phaseB?.confidence, scalarBpm: phaseB?.bpm, scalarConfidence: phaseB?.confidence, track: trackB, referenceBpm: beatB.bpm, referenceSource: beatB.source, labelConfidence: beatB.serviceConfidence }
      )
      const bpmIOutgoing = estimateBPMi(profileA)
      const bpmIIncoming = estimateBPMi(profileB)
      bpmIProfiles = { outgoing: profileA, incoming: profileB }
      bpmIEstimates = { outgoing: bpmIOutgoing, incoming: bpmIIncoming }
      const octaveFoldedA = foldTempo(beatA.bpm, beatB.bpm).bpm
      const compatibility = Number(clamp(1 - Math.abs(octaveFoldedA - beatB.bpm) / Math.max(1, beatB.bpm), 0, 1).toFixed(4))
      pairChoice = {
        bpmA: beatA.bpm,
        bpmB: beatB.bpm,
        compatibility,
        score: compatibility,
        source: 'GetSongBPM'
      }
    } else {
      // BPMi still observes seams when service-backed beat alignment is off or
      // the GetSongBPM failure path retries a safe crossfade. These local
      // pseudo-labels carry deliberately low confidence; service labels remain
      // stronger when available.
      const trackA = tail.track ?? tail.frames[0]?.track
      const trackB = head[0]?.track
      const profileAWindow = monoA.subarray(aStart, aEnd)
      const profileBWindow = monoB.subarray(bStart)
      const profileSamples = Math.round(sampleRate * 4)
      const windowA = profileAWindow.subarray(Math.max(0, profileAWindow.length - profileSamples))
      const windowB = profileBWindow.subarray(0, Math.min(profileBWindow.length, profileSamples))
      const [phaseA, phaseB] = await Promise.all([
        analyseBeat(windowA, sampleRate).catch(() => null),
        analyseBeat(windowB, sampleRate).catch(() => null)
      ])
      const profileA = makeBpmProfile(windowA, sampleRate, {
        confidence: phaseA?.confidence,
        scalarBpm: phaseA?.bpm,
        scalarConfidence: phaseA?.confidence,
        track: trackA,
        referenceBpm: phaseA?.bpm,
        referenceSource: phaseA?.bpm ? 'local-dsp' : null,
        labelConfidence: Math.max(0.15, (Number(phaseA?.confidence) || 0) * 0.25)
      })
      const profileB = makeBpmProfile(windowB, sampleRate, {
        confidence: phaseB?.confidence,
        scalarBpm: phaseB?.bpm,
        scalarConfidence: phaseB?.confidence,
        track: trackB,
        referenceBpm: phaseB?.bpm,
        referenceSource: phaseB?.bpm ? 'local-dsp' : null,
        labelConfidence: Math.max(0.15, (Number(phaseB?.confidence) || 0) * 0.25)
      })
      bpmIProfiles = { outgoing: profileA, incoming: profileB }
      bpmIEstimates = { outgoing: estimateBPMi(profileA), incoming: estimateBPMi(profileB) }
    }
    const confident = Boolean(beatA && beatB && beatA.confidence > 0.25 && beatB.confidence > 0.25)

    // The grid the *rendered* seam runs on. Without beatmatching that is the
    // outgoing song's own grid; with it, the incoming song's tempo.
    let beatPeriod = confident ? beatA.periodSamples : 0
    let beatAt = (n) => (confident ? beatA.phaseSamples + n * beatA.periodSamples : 0)
    let tempoScale = 1
    let beatmatch = null
    let release = null

    if (confident && options.beatmatch !== false) {
      // 174 BPM against 87 BPM is the same groove at half time: fold first.
      const folded = foldTempo(beatB.bpm, beatA.bpm)
      const ratio = beatA.bpm / folded.bpm // < 1 speeds the outgoing song up
      const driftPercent = Math.abs(1 - ratio) * 100
      const limit = Number(options.maxStretchPercent ?? 12)

      if (driftPercent > 0.3 && driftPercent <= limit) {
        // Ride the pitch fader instead of stamping on it: the tempo change
        // eases in over two beats, then holds at the incoming song's tempo.
        const ramp = Math.round(Math.min(a.length * 0.5, beatA.periodSamples * 2 * ratio))
        const stretched = await stretchAudio([a.left, a.right], sampleRate, { stretch: ratio, rampSamples: ramp })
        // The stretcher's first windows are not the input: it starts from an
        // overlap it does not have. That used to be hidden by the seam
        // starting from silence; now the stretched audio follows the original
        // directly, so ease into it. The tempo ramp has barely begun this
        // early, which is why the two are still in phase and can be faded.
        const settle = Math.min(sec(80), Math.floor(Math.min(a.length, stretched.length) / 4))
        for (let i = 0; i < settle; i += 1) {
          const g = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / settle)
          stretched.channels[0][i] = a.left[i] * (1 - g) + stretched.channels[0][i] * g
          stretched.channels[1][i] = a.right[i] * (1 - g) + stretched.channels[1][i] * g
        }
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
          releaseSeconds: Math.max(0.5, Number(options.tempoReleaseMs ?? 4000) / 1000)
        })
      }
    }

    /* 5. blend length ------------------------------------------------------ */
    // Two facts about the pair decide both the length and the curve: how
    // well they correlate at the seam, and how hard the incoming song
    // enters. Measured over a fixed window so the answer does not depend on
    // the blend length we are about to choose from it.
    //
    // The blend sits at the *end* of what is held — the song plays out and
    // the next one arrives under its last bars — so "the seam" on the
    // outgoing side is the last stretch of `a`, not its first. Where exactly
    // depends on the length about to be chosen, so the probes look at the
    // configured length's worth and the choice is made from that.
    const aSeam = sliceChannels(a, Math.max(0, a.length - sec(options.crossfadeMs)), a.length)
    const seamWindow = Math.min(aSeam.length, b.length, sec(1500))
    const r = seamWindow > 0 ? correlation(monoOf(aSeam).subarray(0, seamWindow), monoOf(b).subarray(0, seamWindow), seamWindow) : 0

    const entryWindow = Math.min(b.left.length, Math.max(1, sec(1000)))
    let entrySum = 0
    for (let i = 0; i < entryWindow; i += 1) entrySum += (b.left[i] ?? 0) ** 2
    const entryEnergy = clamp(Math.sqrt(entrySum / entryWindow) * 4, 0, 1)

    // Is anyone singing at the seam? Asked *before* the length is chosen,
    // because two vocals in each other's way is a reason for a short blend,
    // not just a different curve. The windows are fixed so the answer does not
    // depend on the fade length we are about to pick.
    let probe = null
    let outMono = null
    let inMono = null
    if (options.vocalAware !== false && confident) {
      outMono = monoOf(aSeam)
      inMono = monoOf(b)
      const outActive = vocalActivity(outMono.subarray(0, Math.min(outMono.length, sec(1800))), sampleRate)
      const inActive = vocalActivity(inMono.subarray(0, Math.min(inMono.length, sec(2600))), sampleRate)
      probe = { outgoing: outActive.active, incoming: inActive.active, outActive, inActive }
    }

    // Smart Automix: how long should *this* blend be? (see smartCrossfadeMs)
    const smart = smartCrossfadeMs(
      {
        matched: Boolean(beatmatch),
        tempoDelta: Math.abs((beatA?.bpm ?? 0) - (beatB?.bpm ?? 0)),
        correlation: r,
        energy: entryEnergy,
        bpm: beatmatch ? beatmatch.toBpm : (beatB?.bpm ?? beatA?.bpm ?? null),
        available: ms(Math.min(a.length, b.length)),
        vocal: probe
      },
      options
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
      if (options.phraseBlend !== false) {
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

    // Where the blend starts in the held audio. Everything before it is the
    // outgoing song alone and is aired as it is: the old layout started the
    // blend at the top of the tail and threw away whatever the blend did not
    // reach, so a three second blend over a six second tail cut the last
    // three seconds of every song.
    const lead = Math.max(0, a.length - fade)

    // Phase lock: shift the incoming song by less than one beat so its grid
    // falls exactly on the (possibly warped) grid of the outgoing one, counted
    // from the first outgoing beat inside the blend.
    let alignShift = 0
    if (confident && beatPeriod > 0) {
      let n = 0
      while (beatAt(n) < lead && n < 4096) n += 1
      alignShift = beatAlignOffset(beatPeriod, beatAt(n) - lead, beatB.phaseSamples, b.length, {
        maxFraction: options.cueTolerance ?? 0.6
      })
      if (alignShift > 0) b = sliceChannels(b, alignShift, b.length)
    }
    const solo = sliceChannels(a, 0, lead)
    a = sliceChannels(a, lead, a.length)
    fade = Math.min(fade, a.length, b.length)
    if (fade < sec(400)) return null

    /* 6. the mix ----------------------------------------------------------- */
    // Curve: correlation decides unless the owner pinned one.
    const exponent = options.curve === 'equal-power' ? 2 : options.curve === 'equal-gain' ? 1 : exponentFor(r)

    // Vocal-aware shaping (automix-engine's "do not fade a lyric mid-line").
    // Without stems the honest proxy is the band-energy gate in
    // `vocalActivity`: is anything singing on the outgoing seam, and if so,
    // where does the line end? The answer changes the *shape* of the faders,
    // never the length of the blend, so a misdetection costs a slightly
    // different curve rather than a wrong transition.
    let vocal = null
    let shape = null
    if (probe && outMono && inMono) {
      const { outActive, inActive } = probe
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
    if (!safeFallback && this.#djDue()) {
      dj = djLine({
        from: tail.track,
        to: head[0]?.track,
        station: this.ctx.station?.name ?? 'the station',
        dj: options.dj.name,
        listeners: this.ctx.station?.subscribers?.size ?? 0,
        index: this.#breaks
      })
      voice = await speak({ sources: this.ctx.sources, options: options, log: this.log }, dj.text, sampleRate)
      if (!voice) dj = null
      else this.#breaks += 1
    }

    const voiceStart = voice ? sec(options.dj.leadInMs) : 0
    const needed = Math.max(fade, voice ? voiceStart + voice.length + sec(options.dj.tailMs) : 0)
    const total = Math.min(needed, b.length, sec(options.maxRenderMs))

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

    // The transition type is deliberately fixed. Auto mode can still report
    // that the seam was automatically configured, but it never selects an
    // alternate effect or lets a learned policy replace the crossfade.
    const effect = 'crossfade'
    const choice: Record<string, any> = {
      effect,
      source: 'crossfade-only',
      baseline: 'crossfade',
      margin: 0,
      model: null
    }
    this.#lastEffect = effect
    this.#lastModel = null

    // Structural analysis is retained as diagnostics only. It cannot choose a
    // different renderer or add EQ/FX automation to the crossfade.
    let transitionPlan: TransitionPlanResult | null = null
    if (options.intelligent !== false) {
      try {
        const monoA = monoOf(a)
        const monoB = monoOf(b)
        const keyA = tail.track?.id ? `tail:${tail.track.id}:${monoA.length}` : undefined
        const keyB = head[0]?.track?.id ? `head:${head[0].track.id}:${monoB.length}` : undefined
        const structA: TrackStructure = analyzeTrackStructure(monoA, sampleRate, { cacheKey: keyA })
        const structB: TrackStructure = analyzeTrackStructure(monoB, sampleRate, { cacheKey: keyB })
        transitionPlan = planTransition(structA, structB, {
          useNeural: false,
          minCrossfadeMs: options.minCrossfadeMs ?? 2000,
          maxCrossfadeMs: options.maxCrossfadeMs ?? 30_000,
          requestedCrossfadeMs: options.crossfadeMs ?? 6000,
          availableMs: ms(Math.min(a.length, b.length)),
          maxStretchPercent: options.maxStretchPercent ?? 12,
          correlation: r,
          appliedGainDb: matchDb,
          talkover: Boolean(voice),
          minBeatMatchQuality: options.minQualityScore ?? 0.5,
          seamCount:
            typeof options.seamCount === 'number'
              ? options.seamCount
              : typeof this.ctx.station?.seamCount === 'function'
                ? this.ctx.station.seamCount()
                : undefined,
          progressiveScaling: false
        })
      } catch (error: any) {
        this.log.debug(`crossfade diagnostics: ${error?.message ?? error}`)
      }
    }

    const harmonyInfo = transitionPlan ? harmonicCompatibility(transitionPlan.trackA.key, transitionPlan.trackB.key) : null
    const rhythmSim = transitionPlan
      ? rhythmSimilarity(transitionPlan.trackA.rhythmPattern, transitionPlan.trackB.rhythmPattern)
      : null
    EFFECT_RENDERERS.crossfade({
      a,
      b,
      left,
      right,
      fade,
      total,
      gainFor,
      sampleRate,
      options,
      beatSamples: confident ? beatPeriod : 0
    })

    /* 7. the DJ, over a real sidechain ducker ------------------------------ */
    if (voice) voiceTrack(options, { left, right, voice, voiceStart, sampleRate })

    /* 8. make it joinable -------------------------------------------------- */
    // The render sits between the outgoing song alone and the incoming song
    // alone. Every effect leaves its own mess at its edges (a DC step from a
    // filter, half a sample of a brake), so the first and last few
    // milliseconds are cross-faded into the audio that actually surrounds
    // them. Fading the edges to *silence*, which this used to do, made any
    // transition joinable to any other at the price of a notch at both ends.
    smoothEdges(left, right, sampleRate, { fadeMs: 0 })
    const join = Math.max(1, Math.min(sec(8), Math.floor(total / 4)))
    for (let i = 0; i < join; i += 1) {
      const g = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / join)
      left[i] = (a.left[i] ?? 0) * (1 - g) + left[i] * g
      right[i] = (a.right[i] ?? 0) * (1 - g) + right[i] * g
      const at = total - 1 - i
      left[at] = (b.left[at] ?? 0) * (1 - g) + left[at] * g
      right[at] = (b.right[at] ?? 0) * (1 - g) + right[at] * g
    }

    /* 9. peak ceiling ------------------------------------------------------ */
    // Applied as an envelope that is 1 at both edges: a flat gain over the
    // render would step against the untouched audio either side of it.
    const ceiling = DB(options.ceilingDb)
    const peak = samplePeak([left, right])
    if (peak > ceiling) {
      const g = ceiling / peak
      const edge = Math.max(1, Math.min(sec(150), Math.floor(total / 3)))
      for (let i = 0; i < total; i += 1) {
        const w = Math.min(1, i / edge, (total - 1 - i) / edge)
        const k = 1 - (1 - g) * (0.5 - 0.5 * Math.cos(Math.PI * w))
        left[i] = clamp(left[i] * k, -1, 1)
        right[i] = clamp(right[i] * k, -1, 1)
      }
    }

    /* 10. back onto the frame grid ----------------------------------------- */
    // The programme so far is: original outgoing audio, the outgoing song
    // alone (stretched if it was beatmatched), the render. It has to end on
    // a frame boundary of the *incoming* file, because that is where the
    // untouched frames resume — and the beat alignment put the two songs a
    // fraction of a frame apart. The difference (at most half a frame, 13 ms)
    // is taken up over the landing: the incoming song alone, a few seconds
    // long, resampled by a fraction of a percent. Shifting the song instead
    // would undo the alignment; ignoring it is a 13 ms repeat or drop.
    const consumedB = bStart + alignShift + total
    const prefix = free - xStart
    const before = prefix + lead + total
    let resumeAt = Math.ceil((consumedB + Math.min(sec(this.landingMs), Math.max(0, b0.length - consumedB - 3 * spf))) / spf)
    if (resumeAt > headFrames.length - 3 || resumeAt * spf - consumedB < sec(300)) resumeAt = headFrames.length
    const resumes = resumeAt < headFrames.length
    const natural = Math.max(0, Math.min(b0.length, resumeAt * spf) - consumedB)
    let drift = 0
    if (resumes) {
      const over = (before + natural) % spf
      drift = over <= spf / 2 ? -over : spf - over
    }
    const landing = natural + drift
    const length = Math.ceil((before + landing) / spf) * spf
    const outLeft = new Float32Array(length)
    const outRight = new Float32Array(length)
    outLeft.set(a0.left.subarray(xStart, free))
    outRight.set(a0.right.subarray(xStart, free))
    outLeft.set(solo.left.subarray(0, lead), prefix)
    outRight.set(solo.right.subarray(0, lead), prefix)
    outLeft.set(left, prefix + lead)
    outRight.set(right, prefix + lead)
    if (natural > 0) {
      const from = consumedB
      const landLeft = resample(b0.left.subarray(from, from + natural), natural, landing)
      const landRight = resample(b0.right.subarray(from, from + natural), natural, landing)
      outLeft.set(landLeft.subarray(0, Math.min(landLeft.length, length - before)), before)
      outRight.set(landRight.subarray(0, Math.min(landRight.length, length - before)), before)
    }

    /* 11. back to MP3 ------------------------------------------------------ */
    const bitrate = Math.max(96, Math.min(320, head[0]?.track?.streamBitrate ?? options.bitrate ?? 128))
    const encoded = await bridge(
      codec,
      {
        left: outLeft,
        right: outRight,
        sampleRate,
        bitrate,
        after: resumes
          ? { left: b0.left.subarray(resumeAt * spf, (resumeAt + 3) * spf), right: b0.right.subarray(resumeAt * spf, (resumeAt + 3) * spf) }
          : null,
        // What the next untouched frame expects to find behind it.
        tail: resumes ? reservoirBefore(headFrames, resumeAt) : null
      },
      codecKey()
    )
    if (encoded.length === 0) return null

    const frameMs = (spf / sampleRate) * 1000
    const track = { ...head[0].track, automix: true, mixedFrom: tail.track?.title ?? null, dj: dj?.text ?? null }
    // Frames that are still the outgoing song alone keep its name on the
    // display; the incoming song's takes over where the blend begins.
    const blendFrame = Math.floor((prefix + lead) / spf) - LEAD_FRAMES
    const frames = [
      ...tail.frames.slice(0, passFrames),
      ...encoded.map((data, index) => ({ data, ms: frameMs, track: index < blendFrame && tail.track ? tail.track : track }))
    ]
    const rest = head.slice(resumeAt)

    return {
      frames: [...frames, ...rest],
      report: {
        from: tail.track?.title ?? null,
        to: head[0]?.track?.title ?? null,
        effect,
        // Was this one chosen for the seam, or named by the owner?
        chosen: (options.effect ?? AUTO_EFFECT) === AUTO_EFFECT,
        // Which brain chose it, and what the other one would have picked. An
        // owner looking at a surprising transition can see the disagreement
        // rather than having to infer it.
        decision: {
          source: (options.effect ?? AUTO_EFFECT) === AUTO_EFFECT ? choice.source : 'owner',
          baseline: (options.effect ?? AUTO_EFFECT) === AUTO_EFFECT ? choice.baseline : null,
          margin: choice.margin ?? null,
          model: choice.model ?? null
        },
        entryEnergy: Number(entryEnergy.toFixed(2)),
        curve: exponent >= 1.95 ? 'equal-power' : exponent <= 1.05 ? 'equal-gain' : `blend(${exponent.toFixed(2)})`,
        correlation: Number(r.toFixed(3)),
        blendMs: ms(fade),
        // Smart Automix: what it asked for, and why.
        blend: { requestedMs: options.crossfadeMs, chosenMs: smart.ms, bars: smart.bars, why: smart.why },
        renderedMs: ms(total),
        // Where the render sits: the outgoing song alone before it, the
        // incoming song alone after it, and how far the landing was nudged to
        // meet the incoming file's own frames.
        layout: { leadMs: ms(lead), landingMs: ms(landing), driftSamples: drift, frames: encoded.length, resumed: resumes },
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
          serviceConfidence: beatA ? Number(beatA.serviceConfidence.toFixed(2)) : null,
          incomingServiceConfidence: beatB ? Number(beatB.serviceConfidence.toFixed(2)) : null,
          source: beatA?.source ?? null,
          // Independent CPU BPMi predictions and their local candidate inputs
          // are recorded for training; they never replace the service tempos.
          bpmi: bpmIProfiles ? {
            model: 'BPMi',
            backend: 'cpu',
            outgoing: bpmIEstimates?.outgoing ?? null,
            incoming: bpmIEstimates?.incoming ?? null,
            profiles: bpmIProfiles
          } : null,
          // The rendered beat grid remains service-backed. BPMi's separate
          // local estimate/profile is diagnostic and training data only.
          pair: pairChoice
            ? { bpmA: pairChoice.bpmA, bpmB: pairChoice.bpmB, compatibility: pairChoice.compatibility, source: pairChoice.source }
            : { source: options.beatAlign ? 'GetSongBPM' : 'disabled' },
          // Phrase-aligned blend length (automix-engine's 32-beat map, here).
          phrase: phrase ? { beats: phrase.beats, phrases: phrase.phrases, beatMs: ms(phrase.beatSamples) } : null,
          // Tempo release: how long the incoming song takes to reach native speed.
          releaseMs: release ? ms(release.releaseSamples) : null
        },
        vocal,
        harmony:
          transitionPlan && harmonyInfo
            ? {
                fromKey: transitionPlan.trackA.key.name,
                fromCamelot: transitionPlan.trackA.key.camelot,
                toKey: transitionPlan.trackB.key.name,
                toCamelot: transitionPlan.trackB.key.camelot,
                compatibility: harmonyInfo.score,
                relation: harmonyInfo.relation,
                camelotDistance: harmonyInfo.camelotDistance
              }
            : null,
        structure: transitionPlan
          ? {
              fromSection: transitionPlan.selected.cueOut.sectionType,
              toSection: transitionPlan.selected.cueIn.sectionType,
              rhythmSimilarity: rhythmSim,
              durationBars: transitionPlan.selected.durationBars
            }
          : null,
        quality: transitionPlan?.selected.evaluation ?? null,
        plan: transitionPlan
          ? {
              source: 'crossfade-only',
              strategy: 'crossfade',
              continuousBlend: false,
              stemsUsed: false,
              candidateCount: 1,
              fallbackUsed: false,
              fallbackReason: null
            }
          : null,
        peakDb: Number(TO_DB(Math.min(peak, ceiling)).toFixed(1)),
        dj: dj ? { kind: dj.kind, text: dj.text } : null
      }
    }
  }
}

export default Automix
