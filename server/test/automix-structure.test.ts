import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BEAT_FEATURE_DIM,
  analyzeTrackStructure,
  clearStructureCache,
  detectKey,
  harmonicCompatibility,
  rhythmSimilarity,
  structureCacheStats
} from '../src/core/automix/structure.ts'

const SR = 44100

/** Generate a musical track with explicit chord harmony, kick rhythm, and section envelope. */
function makeMusicalTrack({
  bpm = 124,
  seconds = 32,
  chordFreqs = [220, 261.63, 329.63], // A minor triad (A3, C4, E4)
  pattern = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], // 16-step four-on-the-floor
  sections = [
    { startFrac: 0, endFrac: 0.25, gain: 0.35, bass: 0.3, vocal: 0 }, // intro
    { startFrac: 0.25, endFrac: 0.75, gain: 0.95, bass: 1.0, vocal: 0.5 }, // chorus/drop
    { startFrac: 0.75, endFrac: 1.0, gain: 0.35, bass: 0.25, vocal: 0 } // outro
  ]
}: {
  bpm?: number
  seconds?: number
  chordFreqs?: number[]
  pattern?: number[]
  sections?: Array<{ startFrac: number; endFrac: number; gain: number; bass: number; vocal: number }>
} = {}): Float32Array {
  const n = Math.floor(seconds * SR)
  const out = new Float32Array(n)
  const beatSec = 60 / bpm
  const stepSec = beatSec / 4

  for (let i = 0; i < n; i += 1) {
    const t = i / SR
    const frac = i / n
    const sec = sections.find((s) => frac >= s.startFrac && frac <= s.endFrac) ?? sections[0]

    // Chord harmony (rich harmonics for crisp chroma profile)
    let harm = 0
    for (let c = 0; c < chordFreqs.length; c += 1) {
      const f = chordFreqs[c]
      harm += Math.sin(2 * Math.PI * f * t) * 0.28 + Math.sin(2 * Math.PI * f * 2 * t) * 0.12
    }

    // Rhythmic percussion on the 16-step grid
    const stepPos = (t / stepSec) % 16
    const stepIdx = Math.floor(stepPos)
    const stepPhase = (stepPos - stepIdx) * stepSec
    const accent = pattern[stepIdx] ?? 0
    const kickEnv = accent > 0 ? accent * Math.exp(-stepPhase * 34) : 0
    const kickFreq = 58 + 75 * Math.exp(-stepPhase * 45)
    const kick = Math.sin(2 * Math.PI * kickFreq * stepPhase) * kickEnv * 0.65 * sec.bass

    // Optional vocal formant energy (700 Hz + 1600 Hz vibrato)
    const vocal =
      sec.vocal > 0
        ? sec.vocal *
          (Math.sin(2 * Math.PI * 720 * t + 3 * Math.sin(2 * Math.PI * 5 * t)) * 0.14 +
            Math.sin(2 * Math.PI * 1550 * t) * 0.08)
        : 0

    out[i] = Math.max(-0.95, Math.min(0.95, (harm * 0.55 + vocal) * sec.gain + kick))
  }
  return out
}

test('Krumhansl-Schmuckler key detection identifies major and minor keys with Camelot codes', () => {
  // Pure A minor chroma profile (A=9, C=0, E=4, plus diatonic neighbors)
  const aMinor = new Float32Array(12)
  aMinor[9] = 1.0
  aMinor[0] = 0.85
  aMinor[4] = 0.9
  aMinor[2] = 0.4
  aMinor[7] = 0.45
  const keyAm = detectKey(aMinor)
  assert.equal(keyAm.name, 'Am')
  assert.equal(keyAm.camelot, '8A')
  assert.ok(keyAm.confidence > 0.25)

  // Pure C major chroma profile (C=0, E=4, G=7, F=5, D=2)
  const cMajor = new Float32Array(12)
  cMajor[0] = 1.0
  cMajor[4] = 0.85
  cMajor[7] = 0.95
  cMajor[5] = 0.45
  cMajor[2] = 0.35
  const keyC = detectKey(cMajor)
  assert.equal(keyC.name, 'C')
  assert.equal(keyC.camelot, '8B')

  // E minor (9A)
  const eMinor = new Float32Array(12)
  eMinor[4] = 1.0
  eMinor[7] = 0.85
  eMinor[11] = 0.9
  eMinor[2] = 0.4
  const keyEm = detectKey(eMinor)
  assert.equal(keyEm.name, 'Em')
  assert.equal(keyEm.camelot, '9A')
})

test('Camelot harmonic compatibility ranks exact > relative/adjacent > clash', () => {
  const mk = (tonic: number, mode: 'major' | 'minor', num: number, letter: 'A' | 'B') => ({
    tonic,
    mode,
    name: `${num}${letter}`,
    camelotNumber: num,
    camelotLetter: letter,
    camelot: `${num}${letter}`,
    confidence: 0.9,
    correlation: 0.9
  })

  const exact = harmonicCompatibility(mk(9, 'minor', 8, 'A'), mk(9, 'minor', 8, 'A'))
  const relative = harmonicCompatibility(mk(9, 'minor', 8, 'A'), mk(0, 'major', 8, 'B'))
  const adjacent = harmonicCompatibility(mk(9, 'minor', 8, 'A'), mk(4, 'minor', 9, 'A'))
  const energyBoost = harmonicCompatibility(mk(9, 'minor', 8, 'A'), mk(11, 'minor', 10, 'A'))
  const clash = harmonicCompatibility(mk(9, 'minor', 8, 'A'), mk(3, 'minor', 2, 'A'))

  assert.equal(exact.relation, 'exact')
  assert.equal(relative.relation, 'relative')
  assert.equal(adjacent.relation, 'adjacent')
  assert.equal(energyBoost.relation, 'energy-boost')
  assert.ok(exact.score > adjacent.score)
  assert.ok(adjacent.score >= 0.88 && relative.score >= 0.88)
  assert.ok(Math.min(adjacent.score, relative.score) > energyBoost.score)
  assert.ok(energyBoost.score > clash.score)
  assert.ok(clash.score < 0.4, `tritone clash should score low (got ${clash.score})`)
})

test('analyzeTrackStructure extracts key, beats, phrases, sections, cues, beat sequences, and uses LRU cache', () => {
  clearStructureCache()
  const pcm = makeMusicalTrack({ bpm: 124, seconds: 24 })

  const s1 = analyzeTrackStructure(pcm, SR, { cacheKey: 'unit-track-a' })
  assert.ok(s1.bpm > 55 && s1.bpm < 200, `detected BPM ${s1.bpm}`)
  assert.equal(s1.rhythmPattern.length, 16)
  assert.ok(s1.sections.length >= 2, `segmented into ${s1.sections.length} sections`)
  assert.ok(s1.phrases.length >= 1, `detected ${s1.phrases.length} phrase boundaries`)
  assert.ok(s1.mixOutCandidates.length >= 1, 'produced mix-out cue candidates')
  assert.ok(s1.mixInCandidates.length >= 1, 'produced mix-in cue candidates')
  assert.ok(s1.beatSequence.length >= 1)
  assert.equal(s1.beatSequence[0].length, BEAT_FEATURE_DIM)
  // Mix-out cue should be in the back half of the track, mix-in in the front half (never arbitrary/swapped).
  assert.ok(s1.mixOutCandidates[0].timeSec > s1.durationSec * 0.45, `mixOut=${s1.mixOutCandidates[0].timeSec}s`)
  assert.ok(s1.mixInCandidates[0].timeSec < s1.durationSec * 0.5, `mixIn=${s1.mixInCandidates[0].timeSec}s`)

  // Second call with the same cacheKey hits LRU cache immediately.
  const s2 = analyzeTrackStructure(pcm, SR, { cacheKey: 'unit-track-a' })
  assert.equal(s1.cached, false)
  assert.equal(s2.cached, true, 'LRU cache returned cached TrackStructure')
  assert.equal(s2.bpm, s1.bpm)
  assert.equal(s2.key.camelot, s1.key.camelot)
  const stats = structureCacheStats()
  assert.ok(stats.hits >= 1)
})

test('rhythmSimilarity distinguishes matching grooves from syncopated grooves', () => {
  const fourOnFloor = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
  const fourWithHats = [1, 0, 0.25, 0, 1, 0, 0.25, 0, 1, 0, 0.25, 0, 1, 0, 0.25, 0]
  const breakbeat = [1, 0, 0, 0.7, 0, 0.8, 0, 0, 0, 0.9, 0.6, 0, 0, 0, 0.8, 0]

  const same = rhythmSimilarity(fourOnFloor, fourWithHats)
  const diff = rhythmSimilarity(fourOnFloor, breakbeat)
  assert.ok(same > 0.85, `similar grooves scored ${same}`)
  assert.ok(diff < same - 0.3, `distinct groove scored ${diff} vs ${same}`)
})
