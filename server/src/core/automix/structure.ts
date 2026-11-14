/**
 * Musical structure, harmonic key (Camelot), downbeat/phrase grids, rhythm
 * patterns, section segmentation, and cue candidate discovery for AutoMix.
 *
 * Everything here is pure TypeScript DSP built on Livy's `FeatureStream`,
 * `trackBeats`, and seam detectors — CPU-fast, deterministic, and cached via
 * `MemoryLruCache` so tracks and seam buffers are never analysed twice.
 */
import { CHROMA, FeatureStream } from '../seams/features.ts'
import { trackBeats, type Beat, type BeatTrack } from '../seams/beats.ts'
import {
  detectEnding,
  detectEnergy,
  detectNovelty,
  detectPhrase,
  detectVocal,
  type DetectorContext
} from '../seams/detectors.ts'
import { clamp, estimateBeat, integratedLoudness } from '../dsp.ts'
import { MemoryLruCache } from '../cache.ts'

export type MusicalMode = 'major' | 'minor'

export type SectionType = 'intro' | 'verse' | 'chorus' | 'buildup' | 'breakdown' | 'drop' | 'outro'

export interface MusicalKey {
  /** Pitch class 0..11 (C = 0, C# = 1, ..., B = 11). */
  tonic: number
  mode: MusicalMode
  /** Standard name e.g. "Am", "C", "F#m". */
  name: string
  /** Camelot wheel number 1..12. */
  camelotNumber: number
  /** Camelot letter: 'A' = minor, 'B' = major. */
  camelotLetter: 'A' | 'B'
  /** Full Camelot code e.g. "8A", "8B". */
  camelot: string
  /** 0..1 confidence derived from correlation margin over runner-up key. */
  confidence: number
  /** Raw correlation with best key template (−1..1). */
  correlation: number
}

export interface HarmonicMatch {
  score: number
  camelotDistance: number
  relation:
    | 'exact'
    | 'adjacent'
    | 'relative'
    | 'diagonal'
    | 'energy-boost'
    | 'parallel'
    | 'distant'
    | 'clash'
    | 'unknown'
}

export interface PhraseBoundary {
  beatIndex: number
  barIndex: number
  timeSec: number
  sample: number
  /** Phrase length rank this boundary aligns with (4, 8, 16, or 32 bars). */
  phraseBars: 4 | 8 | 16 | 32
  /** 0..1 musical salience (phrase alignment + novelty + energy transition). */
  strength: number
  isDownbeat: boolean
}

export interface SongSection {
  type: SectionType
  startSec: number
  endSec: number
  startSample: number
  endSample: number
  startBeat: number
  endBeat: number
  bars: number
  /** Mean energy normalized 0..1. */
  energy: number
  /** Mean low-end ratio 0..1. */
  bassDensity: number
  /** Mean vocal presence 0..1. */
  vocalDensity: number
  /** Mean onset activity 0..1. */
  rhythmicDensity: number
  /** Confidence of the structural label 0..1. */
  confidence: number
}

export interface CueCandidate {
  role: 'mix-out' | 'mix-in'
  timeSec: number
  sample: number
  beatIndex: number
  barIndex: number
  phraseBars: 4 | 8 | 16 | 32 | 1
  sectionType: SectionType
  /** 0..1 musical appropriateness score. */
  score: number
  vocalFree: boolean
  energy: number
  bassDensity: number
  reason: string
}

export interface TrackStructure {
  sampleRate: number
  durationSec: number
  lengthSamples: number
  bpm: number
  bpmConfidence: number
  loudnessLufs: number | null
  key: MusicalKey
  /** 12-bin energy-normalized pitch-class profile. */
  chromaMean: number[]
  /** 16-step normalized groove/rhythm fingerprint over 1 bar (16th-note grid). */
  rhythmPattern: number[]
  /** 0..1 overall rhythmic regularity / syncopation strength. */
  grooveStrength: number
  /** Mean energy normalized 0..1. */
  meanEnergy: number
  /** Energy slope (positive = rising, negative = falling). */
  energyTrend: number
  /** Mean vocal density 0..1. */
  vocalDensity: number
  /** Mean low-frequency density 0..1. */
  bassDensity: number
  /** Beat timestamps in seconds. */
  beats: Beat[]
  /** Downbeat indices into `beats`. */
  downbeats: number[]
  /** Detected phrase boundaries (4/8/16/32-bar). */
  phrases: PhraseBoundary[]
  /** Segmented musical sections. */
  sections: SongSection[]
  /** Ranked mix-out cue candidates (best first). */
  mixOutCandidates: CueCandidate[]
  /** Ranked mix-in cue candidates (best first). */
  mixInCandidates: CueCandidate[]
  /** Per-beat compact 16-dim feature vectors for sequence neural models. */
  beatSequence: Float32Array[]
  /** True when retrieved from cache. */
  cached?: boolean
}

/* ------------------------------------------------------------------ *
 * Key detection — Krumhansl-Schmuckler / Temperley profiles + Camelot
 * ------------------------------------------------------------------ */

const PITCH_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const

// Krumhansl-Kessler tonal hierarchy templates (rotated across 12 pitch classes).
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

// Camelot numbers indexed by pitch class (C=0..B=11):
// Major (B): C=8B, G=9B, D=10B, A=11B, E=12B, B=1B, F#=2B, Db=3B, Ab=4B, Eb=5B, Bb=6B, F=7B
const MAJOR_CAMELOT = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1] as const
// Minor (A): Am=8A, Em=9A, Bm=10A, F#m=11A, C#m=12A, Abm=1A, Ebm=2A, Bbm=3A, Fm=4A, Cm=5A, Gm=6A, Dm=7A
const MINOR_CAMELOT = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10] as const

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length
  let meanA = 0
  let meanB = 0
  for (let i = 0; i < n; i += 1) {
    meanA += a[i]
    meanB += b[i]
  }
  meanA /= n
  meanB /= n
  let num = 0
  let denA = 0
  let denB = 0
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA
    const db = b[i] - meanB
    num += da * db
    denA += da * da
    denB += db * db
  }
  const denom = Math.sqrt(denA * denB)
  return denom > 1e-12 ? num / denom : 0
}

/** Detect musical key & Camelot code from a 12-bin chroma vector. */
export function detectKey(chroma: ArrayLike<number>): MusicalKey {
  const sum = Array.from({ length: CHROMA }, (_, i) => Math.max(0, Number(chroma[i]) || 0)).reduce((a, b) => a + b, 0)
  if (sum <= 1e-9) {
    return {
      tonic: 0,
      mode: 'major',
      name: 'C',
      camelotNumber: 8,
      camelotLetter: 'B',
      camelot: '8B',
      confidence: 0,
      correlation: 0
    }
  }

  const rotated = new Float64Array(CHROMA)
  let best = { tonic: 0, mode: 'major' as MusicalMode, corr: -2 }
  let second = -2

  for (let tonic = 0; tonic < 12; tonic += 1) {
    for (let i = 0; i < 12; i += 1) rotated[i] = Number(chroma[(i + tonic) % 12]) || 0
    for (const [mode, profile] of [
      ['major', MAJOR_PROFILE],
      ['minor', MINOR_PROFILE]
    ] as const) {
      const corr = pearson(rotated, profile)
      if (corr > best.corr) {
        second = best.corr
        best = { tonic, mode, corr }
      } else if (corr > second) {
        second = corr
      }
    }
  }

  const camelotNumber = best.mode === 'major' ? MAJOR_CAMELOT[best.tonic] : MINOR_CAMELOT[best.tonic]
  const camelotLetter: 'A' | 'B' = best.mode === 'major' ? 'B' : 'A'
  const margin = Math.max(0, best.corr - second)
  const confidence = clamp(Math.max(0, best.corr) * 0.65 + clamp(margin * 3.5, 0, 0.35), 0, 1)

  return {
    tonic: best.tonic,
    mode: best.mode,
    name: `${PITCH_NAMES[best.tonic]}${best.mode === 'minor' ? 'm' : ''}`,
    camelotNumber,
    camelotLetter,
    camelot: `${camelotNumber}${camelotLetter}`,
    confidence: Number(confidence.toFixed(3)),
    correlation: Number(best.corr.toFixed(3))
  }
}

/**
 * Harmonic compatibility between two keys on the Camelot wheel (0..1).
 * Low-confidence keys blend softly toward neutral (0.65) so atonal percussion
 * or noisy recordings are not unfairly penalized as a key clash.
 */
export function harmonicCompatibility(keyA: MusicalKey | null | undefined, keyB: MusicalKey | null | undefined): HarmonicMatch {
  if (!keyA || !keyB) return { score: 0.65, camelotDistance: 0, relation: 'unknown' }
  const conf = Math.min(keyA.confidence, keyB.confidence)
  const rawDiff = Math.abs(keyA.camelotNumber - keyB.camelotNumber)
  const wheelDist = Math.min(rawDiff, 12 - rawDiff)
  const sameLetter = keyA.camelotLetter === keyB.camelotLetter
  const sameTonic = keyA.tonic === keyB.tonic

  let base = 0.2
  let relation: HarmonicMatch['relation'] = 'distant'

  if (wheelDist === 0 && sameLetter) {
    base = 1.0
    relation = 'exact'
  } else if (wheelDist === 0 && !sameLetter) {
    base = 0.9
    relation = 'relative'
  } else if (wheelDist === 1 && sameLetter) {
    base = 0.92
    relation = 'adjacent'
  } else if (wheelDist === 1 && !sameLetter) {
    base = 0.8
    relation = 'diagonal'
  } else if (sameTonic && !sameLetter) {
    base = 0.72
    relation = 'parallel'
  } else if (wheelDist === 2 && sameLetter) {
    base = 0.76
    relation = 'energy-boost'
  } else if (wheelDist === 2) {
    base = 0.58
    relation = 'distant'
  } else if (wheelDist === 3) {
    base = 0.45
    relation = 'distant'
  } else if (wheelDist === 4) {
    base = 0.32
    relation = 'distant'
  } else {
    // 5 or 6 steps on the Camelot wheel (minor 2nd / tritone clash).
    base = wheelDist === 6 ? 0.15 : 0.22
    relation = 'clash'
  }

  // Weight toward neutral when key detection confidence is low.
  const weight = clamp(conf / 0.45, 0.2, 1)
  const score = Number((0.65 * (1 - weight) + base * weight).toFixed(4))
  return { score, camelotDistance: wheelDist + (sameLetter ? 0 : 0.5), relation }
}

/* ------------------------------------------------------------------ *
 * Rhythm pattern fingerprint (16th-note 1-bar groove profile)
 * ------------------------------------------------------------------ */

export function extractRhythmPattern(features: FeatureStream, track: BeatTrack): { pattern: number[]; grooveStrength: number } {
  const bins = new Float64Array(16)
  const counts = new Float64Array(16)
  const onset = features.onset.view()
  const lowFlux = features.lowFlux.view()

  if (track.beats.length >= 4) {
    for (const beat of track.beats) {
      const barPos = ((beat.bar % 4) + 4) % 4
      const span = Math.max(1, beat.to - beat.from)
      for (let f = beat.from; f < beat.to; f += 1) {
        const sub = Math.min(3, Math.floor(((f - beat.from) / span) * 4))
        const slot = barPos * 4 + sub
        bins[slot] += (onset[f] ?? 0) + 0.6 * (lowFlux[f] ?? 0)
        counts[slot] += 1
      }
    }
  } else if (onset.length >= 16) {
    for (let i = 0; i < onset.length; i += 1) {
      const slot = i % 16
      bins[slot] += onset[i]
      counts[slot] += 1
    }
  }

  let norm = 0
  let sum = 0
  let peak = 0
  for (let i = 0; i < 16; i += 1) {
    const v = counts[i] > 0 ? bins[i] / counts[i] : 0
    bins[i] = v
    norm += v * v
    sum += v
    if (v > peak) peak = v
  }
  const denom = Math.sqrt(norm) || 1
  const pattern = Array.from(bins, (v) => Number((v / denom).toFixed(4)))
  const mean = sum / 16
  // Peak-to-mean contrast distinguishes crisp dance grooves from flat pads.
  const grooveStrength = mean > 1e-6 ? clamp((peak / mean - 1.1) / 2.4, 0, 1) : 0
  return { pattern, grooveStrength: Number(grooveStrength.toFixed(3)) }
}

/** Cosine similarity between two 16-step rhythm patterns (0..1). */
export function rhythmSimilarity(a: ArrayLike<number> | null | undefined, b: ArrayLike<number> | null | undefined): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0.5
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na * nb)
  if (denom <= 1e-9) return 0.5
  return clamp(dot / denom, 0, 1)
}

/* ------------------------------------------------------------------ *
 * Phrase grid (4 / 8 / 16 / 32 bars) & Musical Section Segmentation
 * ------------------------------------------------------------------ */

const normLevel = (db: number) => clamp((db + 54) / 48, 0, 1)

function detectPhrases(context: DetectorContext, sampleRate: number): PhraseBoundary[] {
  const { beats } = context.track
  if (beats.length < 4) return []

  const novelty = detectNovelty(context)
  const energy = detectEnergy(context)
  const phraseOpinions = detectPhrase(context)

  const salience = new Float64Array(beats.length)
  for (const op of novelty) if (op.beat >= 0 && op.beat < beats.length) salience[op.beat] += op.score * 0.6
  for (const op of energy) if (op.beat >= 0 && op.beat < beats.length) salience[op.beat] += op.score * 0.5
  for (const op of phraseOpinions) if (op.beat >= 0 && op.beat < beats.length) salience[op.beat] += op.score * 0.7

  // Find phrase anchor aligned to bar downbeat with strongest structural support.
  let anchor = Math.max(0, beats.findIndex((b) => b.bar === 0))
  let bestAnchorScore = -1
  const searchCap = Math.min(beats.length, 32)
  for (let c = 0; c < searchCap; c += 1) {
    let s = beats[c].bar === 0 ? 0.4 : 0
    for (let i = c; i < beats.length; i += 16) {
      const barsFrom = (i - c) / 4
      const mult = barsFrom % 32 === 0 ? 1.2 : barsFrom % 16 === 0 ? 1.0 : barsFrom % 8 === 0 ? 0.85 : 0.5
      s += salience[i] * mult
    }
    if (s > bestAnchorScore + 1e-9) {
      bestAnchorScore = s
      anchor = c
    }
  }

  const out: PhraseBoundary[] = []
  for (let i = anchor; i < beats.length; i += 16) {
    const barIndex = Math.round((i - anchor) / 4)
    const phraseBars: 4 | 8 | 16 | 32 =
      barIndex > 0 && barIndex % 32 === 0
        ? 32
        : barIndex > 0 && barIndex % 16 === 0
          ? 16
          : barIndex % 8 === 0
            ? 8
            : 4
    const baseRank = phraseBars === 32 ? 1.0 : phraseBars === 16 ? 0.92 : phraseBars === 8 ? 0.82 : 0.62
    const localSalience = Math.max(salience[i], (salience[i - 1] ?? 0) * 0.5, (salience[i + 1] ?? 0) * 0.5)
    const strength = clamp(baseRank * 0.65 + clamp(localSalience, 0, 1) * 0.35, 0, 1)
    out.push({
      beatIndex: i,
      barIndex,
      timeSec: Number(beats[i].start.toFixed(3)),
      sample: Math.round(beats[i].start * sampleRate),
      phraseBars,
      strength: Number(strength.toFixed(3)),
      isDownbeat: beats[i].bar === 0
    })
  }
  return out
}

function segmentSections(
  context: DetectorContext,
  phrases: PhraseBoundary[],
  sampleRate: number,
  durationSec: number
): SongSection[] {
  const { beats, medianLevel } = context.track
  if (beats.length === 0) {
    return [
      {
        type: 'verse',
        startSec: 0,
        endSec: durationSec,
        startSample: 0,
        endSample: Math.round(durationSec * sampleRate),
        startBeat: 0,
        endBeat: 0,
        bars: 0,
        energy: 0.5,
        bassDensity: 0.3,
        vocalDensity: 0.2,
        rhythmicDensity: 0.3,
        confidence: 0.2
      }
    ]
  }

  // Combine 8-bar+ phrase boundaries and high-salience novelty/energy boundaries.
  const cuts = new Set<number>([0, beats.length])
  const stepBars = beats.length >= 64 ? 8 : 4
  for (const p of phrases) {
    if (p.phraseBars >= stepBars || p.strength >= 0.78) cuts.add(p.beatIndex)
  }
  for (const op of [...detectNovelty(context), ...detectEnergy(context), ...detectEnding(context)]) {
    if (op.score >= 0.55 && op.beat >= 4 && op.beat <= beats.length - 4) {
      // Snap near existing phrase cut if within 4 beats, else add.
      let near = false
      for (const c of cuts) {
        if (Math.abs(c - op.beat) <= 4) {
          near = true
          break
        }
      }
      if (!near) cuts.add(op.beat)
    }
  }

  const ordered = [...cuts].sort((a, b) => a - b)
  // Compute raw stats per segment first so neighbours can inform buildup→drop classification.
  const raw = []
  const meanTrackBass = beats.reduce((s, b) => s + b.low, 0) / beats.length
  const meanTrackOnset = beats.reduce((s, b) => s + b.onset, 0) / beats.length || 1e-6

  for (let s = 0; s < ordered.length - 1; s += 1) {
    const startBeat = ordered[s]
    const endBeat = ordered[s + 1]
    if (endBeat <= startBeat) continue
    const slice = beats.slice(startBeat, endBeat)
    const count = slice.length
    const meanLevel = slice.reduce((a, b) => a + b.level, 0) / count
    const bass = slice.reduce((a, b) => a + b.low, 0) / count
    const vocal = slice.reduce((a, b) => a + b.vocal, 0) / count
    const high = slice.reduce((a, b) => a + b.high, 0) / count
    const onset = slice.reduce((a, b) => a + b.onset, 0) / count

    // Slope inside segment (second half minus first half) detects buildups & fadeouts.
    const mid = Math.max(1, Math.floor(count / 2))
    const firstLevel = slice.slice(0, mid).reduce((a, b) => a + b.level, 0) / mid
    const lastLevel = slice.slice(mid).reduce((a, b) => a + b.level, 0) / Math.max(1, count - mid)
    const firstOnset = slice.slice(0, mid).reduce((a, b) => a + b.onset, 0) / mid
    const lastOnset = slice.slice(mid).reduce((a, b) => a + b.onset, 0) / Math.max(1, count - mid)

    const startSec = beats[startBeat].start
    const endSec = endBeat < beats.length ? beats[endBeat].start : durationSec
    raw.push({
      startBeat,
      endBeat,
      startSec,
      endSec,
      bars: Math.max(1, Math.round(count / 4)),
      meanLevel,
      relDb: meanLevel - medianLevel,
      energy: normLevel(meanLevel),
      bass,
      bassRel: meanTrackBass > 1e-6 ? bass / meanTrackBass : 1,
      vocal,
      high,
      onset,
      onsetRel: onset / meanTrackOnset,
      levelSlope: lastLevel - firstLevel,
      onsetSlope: (lastOnset - firstOnset) / meanTrackOnset
    })
  }

  const sections: SongSection[] = raw.map((seg, idx) => {
    const isFirst = idx === 0
    const isLast = idx === raw.length - 1
    const prev = idx > 0 ? raw[idx - 1] : null
    const next = idx + 1 < raw.length ? raw[idx + 1] : null

    let type: SectionType = 'verse'
    let confidence = 0.62

    if (isFirst && (seg.relDb < -2 || seg.bassRel < 0.85 || seg.levelSlope > 2.5 || (next && next.meanLevel > seg.meanLevel + 2.5))) {
      type = 'intro'
      confidence = 0.82
    } else if (
      isLast &&
      (seg.relDb < -2 || seg.levelSlope < -2.2 || seg.bassRel < 0.82 || (prev && prev.meanLevel > seg.meanLevel + 2.5))
    ) {
      type = 'outro'
      confidence = 0.84
    } else if (
      next &&
      next.meanLevel - seg.meanLevel > 3.0 &&
      (seg.levelSlope > 1.5 || seg.onsetSlope > 0.2 || seg.high > 0.22)
    ) {
      type = 'buildup'
      confidence = 0.78
    } else if (
      prev &&
      seg.meanLevel - prev.meanLevel > 3.2 &&
      seg.bassRel >= 1.05 &&
      seg.relDb >= 0.5
    ) {
      type = 'drop'
      confidence = 0.83
    } else if (!isFirst && !isLast && (seg.relDb < -4.0 || (seg.bassRel < 0.62 && seg.relDb < -1.5))) {
      type = 'breakdown'
      confidence = 0.8
    } else if (seg.relDb >= 1.0 && (seg.bassRel >= 0.95 || seg.onsetRel >= 1.05)) {
      type = 'chorus'
      confidence = 0.74
    } else {
      type = isFirst && raw.length >= 3 ? 'intro' : isLast && raw.length >= 3 ? 'outro' : 'verse'
      confidence = 0.58
    }

    return {
      type,
      startSec: Number(seg.startSec.toFixed(3)),
      endSec: Number(seg.endSec.toFixed(3)),
      startSample: Math.round(seg.startSec * sampleRate),
      endSample: Math.round(seg.endSec * sampleRate),
      startBeat: seg.startBeat,
      endBeat: seg.endBeat,
      bars: seg.bars,
      energy: Number(seg.energy.toFixed(3)),
      bassDensity: Number(clamp(seg.bass, 0, 1).toFixed(3)),
      vocalDensity: Number(clamp(seg.vocal, 0, 1).toFixed(3)),
      rhythmicDensity: Number(clamp(seg.onsetRel * 0.5, 0, 1).toFixed(3)),
      confidence: Number(confidence.toFixed(3))
    }
  })

  return sections
}

function sectionAtBeat(sections: SongSection[], beatIndex: number): SongSection {
  for (const s of sections) {
    if (beatIndex >= s.startBeat && beatIndex < s.endBeat) return s
  }
  return sections[sections.length - 1]
}

function buildCueCandidates(
  role: 'mix-out' | 'mix-in',
  context: DetectorContext,
  phrases: PhraseBoundary[],
  sections: SongSection[],
  sampleRate: number,
  durationSec: number
): CueCandidate[] {
  const { beats } = context.track
  if (beats.length === 0) {
    const timeSec = role === 'mix-in' ? 0 : Math.max(0, durationSec - Math.min(durationSec * 0.35, 6))
    return [
      {
        role,
        timeSec: Number(timeSec.toFixed(3)),
        sample: Math.round(timeSec * sampleRate),
        beatIndex: 0,
        barIndex: 0,
        phraseBars: 1,
        sectionType: role === 'mix-in' ? 'intro' : 'outro',
        score: 0.5,
        vocalFree: true,
        energy: 0.5,
        bassDensity: 0.3,
        reason: 'fallback position (no beat grid)'
      }
    ]
  }

  const vocalDropBeats = new Set(detectVocal(context).map((op) => op.beat))
  const candidates: CueCandidate[] = []

  // Consider all detected phrase boundaries + section starts + start/tail anchors.
  const beatSet = new Map<number, { phraseBars: 4 | 8 | 16 | 32 | 1; strength: number }>()
  for (const p of phrases) beatSet.set(p.beatIndex, { phraseBars: p.phraseBars, strength: p.strength })
  for (const s of sections) {
    if (!beatSet.has(s.startBeat) && s.startBeat < beats.length) {
      beatSet.set(s.startBeat, { phraseBars: s.bars >= 8 ? 8 : 4, strength: 0.72 })
    }
  }
  if (!beatSet.has(0)) beatSet.set(0, { phraseBars: 8, strength: 0.7 })

  const SECTION_PREF_OUT: Record<SectionType, number> = {
    outro: 1.0,
    breakdown: 0.9,
    verse: 0.72,
    chorus: 0.66,
    drop: 0.5,
    buildup: 0.4,
    intro: 0.3
  }
  const SECTION_PREF_IN: Record<SectionType, number> = {
    intro: 1.0,
    breakdown: 0.88,
    verse: 0.75,
    buildup: 0.7,
    drop: 0.62,
    chorus: 0.55,
    outro: 0.25
  }

  for (const [beatIndex, meta] of beatSet) {
    const beat = beats[beatIndex]
    if (!beat) continue
    const progress = durationSec > 0 ? beat.start / durationSec : 0

    // For mix-out, avoid the very opening; for mix-in, prefer the opening half.
    if (role === 'mix-out' && durationSec > 16 && progress < 0.25) continue
    if (role === 'mix-in' && durationSec > 16 && progress > 0.65) continue

    const sec = sectionAtBeat(sections, beatIndex)
    const lookBeats = beats.slice(beatIndex, Math.min(beats.length, beatIndex + 8))
    const localVocal = lookBeats.reduce((a, b) => a + b.vocal, 0) / Math.max(1, lookBeats.length)
    const localBass = lookBeats.reduce((a, b) => a + b.low, 0) / Math.max(1, lookBeats.length)
    const localEnergy = normLevel(lookBeats.reduce((a, b) => a + b.level, 0) / Math.max(1, lookBeats.length))
    const vocalFree = localVocal < 0.28 || vocalDropBeats.has(beatIndex)

    const phraseBonus = meta.phraseBars === 32 ? 1.0 : meta.phraseBars === 16 ? 0.95 : meta.phraseBars === 8 ? 0.9 : 0.72
    const sectionScore = role === 'mix-out' ? SECTION_PREF_OUT[sec.type] : SECTION_PREF_IN[sec.type]
    const positionScore =
      role === 'mix-out'
        ? clamp(0.45 + 0.55 * progress, 0, 1) // prefer later in the track / tail
        : clamp(1.0 - 0.85 * progress, 0.2, 1) // prefer near opening
    const vocalScore = vocalFree ? 1.0 : clamp(1 - localVocal * 0.9, 0.2, 0.85)
    const downbeatScore = beat.bar === 0 ? 1.0 : 0.65

    const score = clamp(
      0.3 * sectionScore +
        0.24 * phraseBonus +
        0.18 * vocalScore +
        0.16 * positionScore +
        0.12 * downbeatScore,
      0,
      1
    )

    const reasons: string[] = [`${sec.type}`]
    if (meta.phraseBars >= 8) reasons.push(`${meta.phraseBars}-bar phrase`)
    if (beat.bar === 0) reasons.push('downbeat')
    if (vocalFree) reasons.push('vocal-clear')

    candidates.push({
      role,
      timeSec: Number(beat.start.toFixed(3)),
      sample: Math.round(beat.start * sampleRate),
      beatIndex,
      barIndex: Math.floor(beatIndex / 4),
      phraseBars: meta.phraseBars,
      sectionType: sec.type,
      score: Number(score.toFixed(4)),
      vocalFree,
      energy: Number(localEnergy.toFixed(3)),
      bassDensity: Number(clamp(localBass, 0, 1).toFixed(3)),
      reason: reasons.join(', ')
    })
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates.slice(0, 8)
}

/**
 * Compact 16-dimensional per-beat sequence features used by TCN / GRU / Transformer
 * Neural AutoMix architectures:
 *   [energy, bass, vocal, high, onset, barPhaseSin, barPhaseCos, downbeat,
 *    chroma0..chroma5 (6 folded harmonic bins), beatConf, relativePosition]
 */
export const BEAT_FEATURE_DIM = 16

function buildBeatSequence(features: FeatureStream, track: BeatTrack): Float32Array[] {
  const { beats } = track
  if (beats.length === 0) return []
  const maxOnset = Math.max(1e-6, ...beats.map((b) => b.onset))
  const out: Float32Array[] = []
  for (let i = 0; i < beats.length; i += 1) {
    const b = beats[i]
    const v = new Float32Array(BEAT_FEATURE_DIM)
    v[0] = normLevel(b.level)
    v[1] = clamp(b.low, 0, 1)
    v[2] = clamp(b.vocal, 0, 1)
    v[3] = clamp(b.high, 0, 1)
    v[4] = clamp(b.onset / maxOnset, 0, 1)
    const phase = (b.bar / 4) * 2 * Math.PI
    v[5] = Math.sin(phase)
    v[6] = Math.cos(phase)
    v[7] = b.bar === 0 ? 1 : 0

    // Fold 12 chroma pitch classes into 6 fifth-paired harmonic descriptors.
    const span = Math.max(1, b.to - b.from)
    const chromaAcc = new Float64Array(CHROMA)
    for (let f = b.from; f < b.to; f += 1) {
      const row = features.chroma.row(f)
      for (let k = 0; k < CHROMA; k += 1) chromaAcc[k] += row[k] / span
    }
    for (let k = 0; k < 6; k += 1) {
      v[8 + k] = clamp((chromaAcc[k] + chromaAcc[k + 6]) * 0.5, 0, 1)
    }
    v[14] = clamp(b.confidence, 0, 1)
    v[15] = beats.length > 1 ? i / (beats.length - 1) : 0
    out.push(v)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Caching layer — avoids re-analysing identical PCM or tracks
 * ------------------------------------------------------------------ */

const structureCache = new MemoryLruCache({
  name: 'automix-structure',
  maxEntries: 256,
  ttlMs: 30 * 60_000,
  maxBytes: 24 * 1024 * 1024
})

/** Fast deterministic FNV-1a fingerprint over strided PCM samples. */
export function fingerprintPcm(mono: Float32Array, sampleRate: number, hint?: string): string {
  let hash = 0x811c9dc5
  const mix = (n: number) => {
    hash ^= n & 0xff
    hash = Math.imul(hash, 0x01000193) >>> 0
    hash ^= (n >>> 8) & 0xff
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  mix(sampleRate)
  mix(mono.length)
  const stride = Math.max(1, Math.floor(mono.length / 256))
  for (let i = 0; i < mono.length; i += stride) {
    const q = Math.round(clamp(mono[i], -1, 1) * 32767)
    mix(q)
  }
  return `${hint ?? 'pcm'}:${sampleRate}:${mono.length}:${hash.toString(16)}`
}

export function clearStructureCache(): void {
  structureCache.clear()
}

export function structureCacheStats() {
  return structureCache.stats()
}

/* ------------------------------------------------------------------ *
 * Main public entry point
 * ------------------------------------------------------------------ */

export interface AnalyzeStructureOptions {
  cacheKey?: string
  bypassCache?: boolean
  /** Optional stereo channels for accurate BS.1770 loudness. */
  channels?: Float32Array[]
  /** Optional already-estimated BPM & confidence (skips fallback beat estimate). */
  knownBeat?: { bpm?: number; confidence?: number; phaseSamples?: number } | null
}

/**
 * Full musical analysis of a PCM buffer (full track or seam window):
 * BPM, beat grid, downbeats, musical key + Camelot, energy, vocal & bass
 * density, rhythm pattern, phrase boundaries, sections, and mix-in/mix-out cues.
 */
export function analyzeTrackStructure(
  mono: Float32Array,
  sampleRate: number,
  options: AnalyzeStructureOptions = {}
): TrackStructure {
  const key = options.cacheKey ?? fingerprintPcm(mono, sampleRate)
  if (!options.bypassCache) {
    const hit = structureCache.get(key) as TrackStructure | undefined
    if (hit) return { ...hit, cached: true }
  }

  const durationSec = mono.length / Math.max(1, sampleRate)
  const stream = new FeatureStream(sampleRate)
  stream.push(mono)

  const beatTrack = trackBeats(stream)

  // Fall back to scalar beat estimator when the buffer is short (<4s) or DP tracker had low confidence.
  let bpm = beatTrack.bpm
  let bpmConfidence = beatTrack.confidence
  if (options.knownBeat?.bpm && options.knownBeat.bpm > 0 && (options.knownBeat.confidence ?? 0) > bpmConfidence) {
    bpm = options.knownBeat.bpm
    bpmConfidence = options.knownBeat.confidence ?? bpmConfidence
  } else if (!(bpm > 0) || bpmConfidence < 0.15) {
    const est = estimateBeat(mono, sampleRate)
    if (est && est.bpm > 0) {
      bpm = est.bpm
      bpmConfidence = Math.max(bpmConfidence, est.confidence)
    }
  }

  // Energy-weighted chroma average across all frames for reliable key detection.
  const chromaMean = new Array<number>(CHROMA).fill(0)
  const levelView = stream.level.view()
  let weightSum = 0
  for (let f = 0; f < stream.frames; f += 1) {
    const w = Math.max(0.01, normLevel(levelView[f]))
    const row = stream.chroma.row(f)
    for (let k = 0; k < CHROMA; k += 1) chromaMean[k] += row[k] * w
    weightSum += w
  }
  if (weightSum > 0) {
    for (let k = 0; k < CHROMA; k += 1) chromaMean[k] = Number((chromaMean[k] / weightSum).toFixed(4))
  }
  const musicalKey = detectKey(chromaMean)

  const { pattern: rhythmPattern, grooveStrength } = extractRhythmPattern(stream, beatTrack)

  // Summary energy, trend, vocal, and bass density.
  let energySum = 0
  let vocalSum = 0
  let bassSum = 0
  let firstHalfEnergy = 0
  let secondHalfEnergy = 0
  const half = Math.max(1, Math.floor(stream.frames / 2))
  for (let f = 0; f < stream.frames; f += 1) {
    const e = normLevel(levelView[f])
    energySum += e
    vocalSum += stream.vocal.at(f)
    bassSum += stream.low.at(f)
    if (f < half) firstHalfEnergy += e
    else secondHalfEnergy += e
  }
  const frameDenom = Math.max(1, stream.frames)
  const meanEnergy = Number((energySum / frameDenom).toFixed(3))
  const energyTrend = Number(
    clamp(secondHalfEnergy / Math.max(1, stream.frames - half) - firstHalfEnergy / half, -1, 1).toFixed(3)
  )
  const vocalDensity = Number(clamp(vocalSum / frameDenom, 0, 1).toFixed(3))
  const bassDensity = Number(clamp(bassSum / frameDenom, 0, 1).toFixed(3))

  const loudnessLufs = integratedLoudness(options.channels ?? [mono], sampleRate)

  const detectorCtx: DetectorContext = { track: beatTrack }
  const phrases = detectPhrases(detectorCtx, sampleRate)
  const sections = segmentSections(detectorCtx, phrases, sampleRate, durationSec)
  const mixOutCandidates = buildCueCandidates('mix-out', detectorCtx, phrases, sections, sampleRate, durationSec)
  const mixInCandidates = buildCueCandidates('mix-in', detectorCtx, phrases, sections, sampleRate, durationSec)
  const downbeats = beatTrack.beats.filter((b) => b.bar === 0).map((b) => b.index)
  const beatSequence = buildBeatSequence(stream, beatTrack)

  const result: TrackStructure = {
    sampleRate,
    durationSec: Number(durationSec.toFixed(3)),
    lengthSamples: mono.length,
    bpm: Number((bpm || 0).toFixed(2)),
    bpmConfidence: Number(clamp(bpmConfidence, 0, 1).toFixed(3)),
    loudnessLufs: loudnessLufs == null ? null : Number(loudnessLufs.toFixed(2)),
    key: musicalKey,
    chromaMean,
    rhythmPattern,
    grooveStrength,
    meanEnergy,
    energyTrend,
    vocalDensity,
    bassDensity,
    beats: beatTrack.beats,
    downbeats,
    phrases,
    sections,
    mixOutCandidates,
    mixInCandidates,
    beatSequence,
    cached: false
  }

  if (!options.bypassCache) {
    structureCache.set(key, result)
  }
  return result
}
