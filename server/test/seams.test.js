/**
 * Seam detection while streaming, the beat sorter, the jukebox graph, the
 * Forever engine and the RL model — on a song built to have known answers.
 */
import { test, expect, describe, beforeAll } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encodeMp3 } from '../src/core/automix.js'
import { codec, decodeFrames } from '../src/util/codec.js'
import { SeamScout, ForeverJukebox, JukeboxWalker, CATEGORIES, PROTOTYPES, fitCentroids, nearest, fuse } from '../src/core/seams/index.ts'
import { boot, tone, toMp3 } from './helpers.js'
import { chooseEffectWithModel, effectUsable } from '../src/core/automix/effects.js'
import { split } from '../src/core/models/trainer/dataset.js'
import { RLModel, rewardFor, rl, saveRL, trainRL, reloadRL } from '../src/core/models/rl.ts'

const SR = 44_100
const BPM = 124
const BEAT = 60 / BPM
const BAR = BEAT * 4
const SECTIONS = [['intro', 8], ['A', 16], ['break', 8], ['A', 16], ['B', 16], ['A', 16], ['outro', 8]]
const CHORDS = { A: [220, 277.2, 329.6], B: [174.6, 220, 261.6], intro: [220, 329.6], break: [220, 277.2, 329.6], outro: [220, 277.2] }

/** A 170 s "song" with drums, chords and a known structure. */
function song() {
  const bars = SECTIONS.reduce((sum, [, count]) => sum + count, 0)
  const n = Math.round(bars * BAR * SR)
  const x = new Float32Array(n)
  let seed = 3
  const noise = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32) - 0.5
  const marks = {}
  let bar = 0
  for (const [name, count] of SECTIONS) {
    ;(marks[name] ??= []).push(bar * BAR)
    for (let b = 0; b < count * 4; b += 1) {
      const t0 = (bar * 4 + b) * BEAT
      const i0 = Math.round(t0 * SR)
      const length = Math.round(BEAT * SR)
      const kick = name === 'A' || name === 'B' || name === 'outro'
      const fade = name === 'outro' ? Math.max(0, 1 - b / (count * 4)) : 1
      for (let i = 0; i < length && i0 + i < n; i += 1) {
        const t = i / SR
        let v = 0
        if (kick) v += 0.6 * Math.sin(2 * Math.PI * (50 + 60 * Math.exp(-t * 30)) * t) * Math.exp(-t * 14)
        if (b % 2 === 1 && name !== 'intro') v += noise() * 0.5 * Math.exp(-t * 25)
        if (i > length / 2) v += noise() * 0.15 * Math.exp(-(t - BEAT / 2) * 60)
        for (const f of CHORDS[name]) v += 0.07 * Math.sin(2 * Math.PI * f * (t0 + t)) * (name === 'break' ? 1.5 : 1)
        if (name === 'B') v += 0.1 * Math.sin(2 * Math.PI * 880 * (t0 + t)) * (b % 4 < 2 ? 1 : 0.3)
        x[i0 + i] += v * fade
      }
    }
    bar += count
  }
  return { pcm: x, marks, seconds: n / SR }
}

let cached = null
async function analysed() {
  if (cached) return cached
  const made = song()
  const frames = codec.frames(await encodeMp3({ left: made.pcm, right: made.pcm, sampleRate: SR, bitrate: 128 }))
  const streamed = []
  const scout = new SeamScout({ retain: true, onSeam: (candidate) => streamed.push({ ...candidate, seenAtMs: scout.ms }) })
  // The way a station feeds it: a quarter second at a time.
  for (let i = 0; i < frames.length; i += 10) scout.push(frames.slice(i, i + 10))
  await scout.settle()
  cached = { ...made, frames, scout, streamed }
  return cached
}

beforeAll(async () => {
  await analysed()
}, 120_000)

const near = (candidates, seconds, tolerance = 0.3) => candidates.find((candidate) => Math.abs(candidate.atMs / 1000 - seconds) <= tolerance)

describe('the scout', () => {
  test('codec.frames returns every frame of a long file', async () => {
    const { frames, seconds } = await analysed()
    // The framer hands back at most 2048 frames per push; a 170 s file has 6500.
    expect(Math.abs(frames.length - (seconds * SR) / 1152)).toBeLessThan(3)
  })

  test('finds the tempo and puts beats on the beats', async () => {
    const { scout } = await analysed()
    const { track } = scout.analysis()
    expect(Math.abs(track.bpm - BPM)).toBeLessThan(1)
    // Where there are drums, a tracked beat is within 30 ms of a real one
    // (it sits a little ahead of the attack — a snare is seen sooner than a
    // kick — which is the side to be wrong on when the beat is where a cut goes).
    const drums = track.beats.filter((beat) => beat.start > 20 && beat.start < 44)
    expect(drums.length).toBeGreaterThan(40)
    for (const beat of drums) {
      const error = Math.abs(beat.start - Math.round(beat.start / BEAT) * BEAT)
      expect(error).toBeLessThan(0.03)
    }
  }, 30_000)

  test('several detectors agree on where the sections change', async () => {
    const { scout, marks } = await analysed()
    const { candidates } = scout.analysis()
    expect(candidates.length).toBeGreaterThan(5)
    expect(candidates.length).toBeLessThan(60) // seams, not every beat
    const intoB = near(candidates, marks.B[0])
    expect(intoB, 'the change of chords into B').toBeTruthy()
    expect(intoB.detectors.novelty).toBeGreaterThan(0.5)
    expect(intoB.detectors.phrase).toBeGreaterThan(0.5)
    // The breakdown: the low end goes.
    expect(candidates.some((candidate) => Math.abs(candidate.atMs / 1000 - marks.break[0]) < 1.2 && candidate.detectors.energy > 0.5)).toBe(true)
    // The fade-out is an ending.
    expect(candidates.some((candidate) => candidate.atMs / 1000 > marks.outro[0] && candidate.detectors.ending > 0.5)).toBe(true)
    // Agreement outranks a lone opinion.
    const lone = candidates.filter((candidate) => Object.values(candidate.detectors).filter((value) => value > 0).length === 1)
    for (const candidate of lone) expect(candidate.score).toBeLessThan(intoB.score)
  })

  test('candidates are announced while the song is still streaming', async () => {
    const { streamed, seconds, marks } = await analysed()
    expect(streamed.length).toBeGreaterThan(3)
    const first = near(streamed, marks.A[0], 0.6)
    expect(first, 'the first drop was announced').toBeTruthy()
    // …long before the song had finished being read.
    expect(first.seenAtMs / 1000).toBeLessThan(seconds / 2)
    // Announced once each, in order.
    const beats = streamed.map((candidate) => candidate.beat)
    expect([...beats].sort((a, b) => a - b)).toEqual(beats)
    expect(new Set(beats).size).toBe(beats.length)
  })

  test('a scout that is fed rubbish reports nothing and does not throw', async () => {
    const scout = new SeamScout()
    scout.push([Buffer.alloc(417), Buffer.alloc(417)])
    await scout.settle()
    expect(scout.analysis()).toBeNull()
    expect(scout.graph()).toBeNull()
    expect(scout.candidatesBetween(0, 1e9)).toEqual([])
    expect(scout.beatAt(1000)).toBeNull()
  })

  test('stops holding a song that is longer than it is willing to keep', async () => {
    const { frames } = await analysed()
    const scout = new SeamScout({ retain: true, maxMs: 5000 })
    scout.push(frames.slice(0, 600))
    await scout.settle()
    expect(scout.full).toBe(true)
    expect(scout.frames.length).toBeLessThan(300)
  })
})

describe('sorting beats', () => {
  test('each part of the song is mostly the kind it was written as', async () => {
    const { scout, marks } = await analysed()
    const { track, categories } = scout.analysis()
    const share = (from, to, kinds) => {
      const inside = track.beats.map((beat, index) => [beat, index]).filter(([beat]) => beat.start >= from + 1 && beat.start < to - 1)
      return inside.filter(([, index]) => kinds.includes(CATEGORIES[categories[index]])).length / inside.length
    }
    expect(share(marks.A[0], marks.break[0], ['groove', 'drop'])).toBeGreaterThan(0.85)
    expect(share(marks.intro[0], marks.A[0], ['groove', 'drop'])).toBeLessThan(0.15)
    expect(share(marks.break[0], marks.A[1], ['groove', 'drop'])).toBeLessThan(0.4)
    expect(share(marks.outro[0] + BAR * 4, marks.outro[0] + BAR * 8, ['fade', 'silence', 'sparse'])).toBeGreaterThan(0.7)
  })

  test('beatAt names the kind of beat at a time', async () => {
    const { scout, marks } = await analysed()
    const beat = scout.beatAt((marks.A[0] + BAR * 6) * 1000)
    expect(['groove', 'drop']).toContain(beat.category)
    expect(beat.descriptor).toHaveLength(PROTOTYPES[0].length)
  })

  test('fitted centroids move towards the data and stay anchored', () => {
    expect(fitCentroids([]).centroids).toEqual(PROTOTYPES)
    const groove = CATEGORIES.indexOf('groove')
    const shifted = PROTOTYPES[groove].map((value, index) => (index === 1 ? value + 0.15 : value))
    const few = fitCentroids(Array.from({ length: 5 }, () => shifted)).centroids[groove][1]
    const many = fitCentroids(Array.from({ length: 500 }, () => shifted)).centroids[groove][1]
    expect(few).toBeGreaterThan(PROTOTYPES[groove][1])
    expect(many).toBeGreaterThan(few)
    expect(many).toBeLessThan(PROTOTYPES[groove][1] + 0.15)
    // A beat of that kind is still that kind afterwards.
    expect(nearest(shifted, fitCentroids(Array.from({ length: 500 }, () => shifted)).centroids)).toBe(groove)
  })

  test('fuse drops candidates only the loop detector believes in', async () => {
    const { scout } = await analysed()
    const { track } = scout.analysis()
    const loop = (beat, score = 0.9) => ({ beat, detector: 'loop', score, why: 'x' })
    expect(fuse(track, [loop(10), loop(20)])).toEqual([])
    const both = fuse(track, [loop(10), { beat: 10, detector: 'phrase', score: 1, why: 'y' }, { beat: 30, detector: 'phrase', score: 1, why: 'y' }])
    expect(both.map((candidate) => candidate.beat)).toEqual([10, 30])
    expect(both[0].score).toBeGreaterThan(both[1].score)
  })
})

describe('the jukebox', () => {
  test('the graph links beats in repeats of the same section, and can always get back', async () => {
    const { scout, marks } = await analysed()
    const graph = scout.graph()
    const { track } = scout.analysis()
    expect(graph.lastBranch).toBeGreaterThan(track.beats.length / 2)
    expect(graph.branching).toBeGreaterThan(8)
    expect(graph.branching).toBeLessThanOrEqual(Math.max(4, Math.floor(track.beats.length * 0.25)) + 1)
    const section = (seconds) => {
      let name = 'intro'
      for (const [label] of SECTIONS) for (const at of marks[label]) if (seconds >= at - 0.1 && at >= (marks[name]?.findLast?.((m) => m <= seconds + 0.1) ?? 0)) name = label
      return name
    }
    let edges = 0
    let same = 0
    graph.neighbours.forEach((list, from) => {
      for (const edge of list) {
        edges += 1
        expect(track.beats[edge.to].bar).toBe(track.beats[from].bar)
        if (section(track.beats[from].start) === section(track.beats[edge.to].start)) same += 1
        expect(edge.to).toBeLessThan(graph.lastBranch)
      }
    })
    expect(same / edges).toBeGreaterThan(0.9)
    expect(graph.neighbours[graph.lastBranch].every((edge) => edge.to < graph.lastBranch)).toBe(true)
  })

  test('a walk never reaches the end of the song', async () => {
    const { scout } = await analysed()
    const graph = scout.graph()
    for (const seed of [1, 2, 3]) {
      let state = seed
      const walker = new JukeboxWalker(graph, { random: () => ((state = (state * 16807) % 2147483647) / 2147483647) })
      let beat = 0
      for (let i = 0; i < 5000; i += 1) {
        const step = walker.next(beat)
        expect(step, `seed ${seed} step ${i}`).not.toBeNull()
        beat = step.beat
      }
      expect(walker.branches).toBeGreaterThan(10)
    }
  })

  test('Forever plays past the end of the song, on frames a decoder accepts', async () => {
    const { scout, frames, seconds } = await analysed()
    let state = 7
    const jukebox = new ForeverJukebox({ frames: scout.frames, track: scout.analysis().track, graph: scout.graph(), random: () => ((state = (state * 16807) % 2147483647) / 2147483647) })
    expect(jukebox.possible).toBe(true)
    const out = []
    const jumps = []
    while (out.length < frames.length * 2) {
      const segment = await jukebox.next()
      expect(segment.ended).toBe(false)
      if (segment.jump) jumps.push({ ...segment.jump, resumeFrame: out.length + segment.frames.length, cursor: jukebox.cursor })
      out.push(...segment.frames)
    }
    expect((out.length * 1152) / SR).toBeGreaterThan(seconds * 2)
    expect(jumps.length).toBeGreaterThan(3)
    expect(jukebox.failures).toBe(0)
    for (const jump of jumps) expect(Math.abs(jump.nudge)).toBeLessThanOrEqual(576)

    // After a jump the stream is the song's own frames again, byte for byte…
    const first = jumps[0]
    expect(out[first.resumeFrame]).toBe(frames[first.cursor])
    // …and what the listener hears there is what the song has there.
    const heard = await decodeFrames(out.slice(first.resumeFrame - 4, first.resumeFrame + 6))
    const wanted = await decodeFrames(frames.slice(first.cursor - 4, first.cursor + 6))
    let worst = 0
    for (let i = 4 * 1152; i < 9 * 1152; i += 1) worst = Math.max(worst, Math.abs(heard.left[i] - wanted.left[i]))
    expect(worst).toBeLessThan(0.12)

    // The beat keeps time across the jump: the kick after it lands a whole
    // number of beats after the kick before it, give or take the nudge.
    const around = await decodeFrames(out.slice(first.resumeFrame - 80, first.resumeFrame + 80))
    const scoutAfter = new SeamScout()
    scoutAfter.push(out.slice(first.resumeFrame - 400, first.resumeFrame + 400))
    await scoutAfter.settle()
    const track = scoutAfter.analysis().track
    expect(around.length).toBe(160 * 1152)
    expect(Math.abs(track.bpm - BPM)).toBeLessThan(1.5)
  }, 60_000)

  test('bringing it home lets the song finish', async () => {
    const { scout, frames } = await analysed()
    const jukebox = new ForeverJukebox({ frames: scout.frames, track: scout.analysis().track, graph: scout.graph(), cursor: frames.length - 800 })
    jukebox.home = true
    let total = 0
    for (;;) {
      const segment = await jukebox.next()
      expect(segment.jump).toBeNull()
      total += segment.frames.length
      if (segment.ended) break
    }
    expect(total).toBe(800)
  })
})

describe('RL', () => {
  const seam = (exitKind, entryKind, effect, outcome, extra = {}) => ({ exitKind, entryKind, effect, outcome, ...extra })

  test('rewards: stayed, skipped at the seam, skipped later, unknown', () => {
    expect(rewardFor({ outcome: 'completed' })).toBe(1)
    expect(rewardFor({ outcome: 'skipped', skippedAfterMs: 5000 })).toBe(0)
    expect(rewardFor({ outcome: 'skipped', skippedAfterMs: 120_000 })).toBe(0.5)
    expect(rewardFor({ outcome: 'neutral' })).toBeNull()
  })

  test('learns which transition works in which context', () => {
    const model = new RLModel()
    for (let i = 0; i < 12; i += 1) {
      model.learn(seam('break', 'drop', 'slam', 'completed'))
      model.learn(seam('break', 'drop', 'crossfade', 'skipped', { skippedAfterMs: 4000 }))
      model.learn(seam('vocal', 'vocal', 'slam', 'skipped', { skippedAfterMs: 4000 }))
      model.learn(seam('vocal', 'vocal', 'crossfade', 'completed'))
    }
    expect(model.seams).toBe(48)
    expect(model.rank('break', 'drop', undefined, { explore: 0 })[0].effect).toBe('slam')
    expect(model.rank('vocal', 'vocal', undefined, { explore: 0 })[0].effect).toBe('crossfade')
    expect(model.value('break', 'drop', 'slam').value).toBeGreaterThan(0.85)
    expect(model.value('break', 'drop', 'crossfade').value).toBeLessThan(0.2)
    // The pool is respected.
    expect(model.rank('break', 'drop', ['echo', 'crossfade']).map((entry) => entry.effect).sort()).toEqual(['crossfade', 'echo'])
  })

  test('an untried context borrows from what is known, and one seam does not decide', () => {
    const model = new RLModel()
    for (let i = 0; i < 20; i += 1) model.learn(seam('groove', 'groove', 'echo', 'skipped', { skippedAfterMs: 1000 }))
    // Never played from a fade — but echo has a record, so it is not neutral.
    expect(model.value('fade', 'groove', 'echo').value).toBeLessThan(0.45)
    expect(model.value('fade', 'groove', 'echo').plays).toBe(0)
    const before = model.value('fade', 'groove', 'echo').value
    model.learn(seam('fade', 'groove', 'echo', 'completed'))
    const after = model.value('fade', 'groove', 'echo').value
    expect(after).toBeGreaterThan(before)
    expect(after).toBeLessThan(0.6)
  })

  test('exploration prefers the untried, and stops once there is a record', () => {
    const model = new RLModel()
    for (let i = 0; i < 6; i += 1) model.learn(seam('groove', 'groove', 'crossfade', 'completed', { n: i }))
    for (let i = 0; i < 6; i += 1) model.learn(seam('groove', 'groove', 'filter', 'skipped', { skippedAfterMs: 0 }))
    const exploring = model.rank('groove', 'groove', ['crossfade', 'filter', 'wash'], { explore: 1 })
    const filter = exploring.find((entry) => entry.effect === 'filter')
    const wash = exploring.find((entry) => entry.effect === 'wash')
    expect(wash.score - wash.value).toBeGreaterThan(filter.score - filter.value)
    expect(model.rank('groove', 'groove', ['crossfade', 'filter', 'wash'], { explore: 0 })[0].effect).toBe('crossfade')
    expect(exploring.at(-1).effect).toBe('filter')
  })

  test('ignores seams it cannot place', () => {
    const model = new RLModel()
    expect(model.learn(seam('groove', 'groove', 'not-an-effect', 'completed'))).toBe(false)
    expect(model.learn(seam('groove', null, 'echo', 'completed'))).toBe(false)
    expect(model.learn(seam('groove', 'groove', 'echo', 'neutral'))).toBe(false)
    expect(model.seams).toBe(0)
  })

  test('training refits the sorter and re-sorts old seams by their beats', () => {
    const drop = PROTOTYPES[CATEGORIES.indexOf('drop')]
    const vocal = PROTOTYPES[CATEGORIES.indexOf('vocal')]
    const records = []
    for (let i = 0; i < 30; i += 1) {
      // Logged under a stale name; the descriptor says what it really was.
      records.push({ exitKind: 'groove', entryKind: 'groove', exitBeat: vocal, entryBeat: drop, effect: 'drop', outcome: 'completed' })
      records.push({ exitKind: 'groove', entryKind: 'groove', exitBeat: vocal, entryBeat: drop, effect: 'wash', outcome: 'skipped', skippedAfterMs: 2000 })
    }
    const model = RLModel.train(records)
    expect(model.seams).toBe(60)
    expect(model.evidence('vocal', 'drop')).toBe(60)
    expect(model.evidence('groove', 'groove')).toBe(0)
    expect(model.beats[CATEGORIES.indexOf('drop')]).toBe(60)
    expect(model.rank('vocal', 'drop', undefined, { explore: 0 })[0].effect).toBe('drop')
    const report = RLModel.evaluate(records)
    expect(report.heldOut).toBe(12)
    expect(report.rewardWhenAgreed).toBe(1)
    expect(report.rewardOtherwise).toBe(0)
  })

  test('round-trips through its file, and refuses a file that is not its own', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livy-rl-'))
    const file = path.join(dir, 'rl-model.json')
    try {
      reloadRL()
      expect(rl(file).seams).toBe(0) // no file: the untrained model
      const records = Array.from({ length: 24 }, (_, i) => seam('build', 'drop', i % 2 ? 'slam' : 'echo', i % 2 ? 'completed' : 'skipped', { skippedAfterMs: 0 }))
      const report = trainRL(records, { file })
      expect(report).toMatchObject({ codename: 'RL', trained: true, seams: 24, saved: true })
      expect(report.evaluation.heldOut).toBeGreaterThan(0)
      reloadRL()
      const loaded = rl(file)
      expect(loaded.seams).toBe(24)
      expect(loaded.rank('build', 'drop', undefined, { explore: 0 })[0].effect).toBe('slam')
      expect(loaded.info().contexts[0]).toMatchObject({ exit: 'build', entry: 'drop', effect: 'slam' })

      const json = loaded.toJSON()
      expect(RLModel.fromJSON({ ...json, codename: 'XX' })).toBeNull()
      expect(RLModel.fromJSON({ ...json, actions: [...json.actions].reverse() })).toBeNull()
      expect(RLModel.fromJSON({ ...json, plays: json.plays.slice(1) })).toBeNull()
      expect(RLModel.fromJSON(null)).toBeNull()
      fs.writeFileSync(file, '{ not json')
      reloadRL()
      expect(rl(file).seams).toBe(0)
      // Nothing to learn → nothing written over a good file.
      saveRL(loaded, file)
      expect(trainRL([], { file })).toMatchObject({ trained: false, saved: false })
      reloadRL()
      expect(rl(file).seams).toBe(24)
    } finally {
      reloadRL()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('on a station', () => {
  const drain = (live, sink, keepMs = 0) => {
    while (live._frames.length && live._bufferedMs > keepMs) {
      const frame = live._frames.shift()
      live._bufferedMs -= frame.ms
      sink.push(frame)
    }
  }
  const energyAt = (signal, freq) => {
    let re = 0
    let im = 0
    for (let i = 0; i < signal.length; i += 1) {
      re += signal[i] * Math.cos((2 * Math.PI * freq * i) / SR)
      im += signal[i] * Math.sin((2 * Math.PI * freq * i) / SR)
    }
    return Math.hypot(re, im) / signal.length
  }

  test('filters are heard with the automix on', async () => {
    const node = await boot({ stations: [{ id: 'fx', name: 'FX', autoStart: false, sources: [], automix: { enabled: true } }] })
    try {
      const live = node.manager.get('fx')
      expect(live.automix.enabled).toBe(true)
      live.setFilters({ lowpass: { cutoff: 300 } })
      const mp3 = await toMp3(tone({ seconds: 4, freq: 4000 }))
      const before = energyAt((await decodeFrames(codec.frames(mp3))).left, 4000)
      const track = { id: 'tone', title: 'Tone', artist: 'Test' }
      const frames = codec.frames(mp3).map((data) => ({ data, ms: 26.122, track }))
      for (let i = 0; i < frames.length; i += 10) await live._air(frames.slice(i, i + 10))
      await live._flushAutomix('test')
      const aired = []
      drain(live, aired)
      expect(aired.length).toBeGreaterThan(100)
      const after = energyAt((await decodeFrames(aired.map((frame) => frame.data))).left, 4000)
      expect(after).toBeLessThan(before * 0.25)
    } finally {
      await node.close()
    }
  }, 30_000)

  test('the scout follows the song on air and reports its seams', async () => {
    const { frames } = await analysed()
    const node = await boot({ stations: [{ id: 'sc', name: 'SC', autoStart: false, sources: [] }] })
    try {
      const live = node.manager.get('sc')
      const track = { id: 'song', title: 'Song', artist: 'Test' }
      const seen = []
      live.on('seam', (seam) => seen.push(seam))
      for (let i = 0; i < 3000; i += 10) await live._air(frames.slice(i, i + 10).map((data) => ({ data, ms: 26.122, track })))
      await live._scoutFor('song').settle()
      const info = live.seamsInfo({ graph: true })
      expect(info.track).toBe('song')
      expect(Math.abs(info.bpm - BPM)).toBeLessThan(1)
      expect(info.seams.length).toBeGreaterThan(2)
      expect(info.jukebox.branching).toBeGreaterThan(0)
      expect(info.rl.codename).toBe('RL')
      expect(info.forever).toMatchObject({ enabled: false, active: false })
      expect(seen.length).toBeGreaterThan(0)
      expect(seen[0].track).toBe('song')
      // Not retained unless Forever wants the song in hand.
      expect(live._scoutFor('song').frames.length).toBe(0)
      // A live relay is not a song.
      live._scoutPush([{ data: frames[0], ms: 26, track: { id: 'relay', live: true } }])
      expect(live._scoutFor('relay')).toBeNull()
    } finally {
      await node.close()
    }
  }, 30_000)

  test('Forever keeps a song on air past its end, then lets it finish into the automix', async () => {
    const { frames } = await analysed()
    const node = await boot({ stations: [{ id: 'fv', name: 'FV', autoStart: false, sources: [], forever: true, automix: { enabled: true } }] })
    try {
      const live = node.manager.get('fv')
      expect(live.foreverInfo()).toMatchObject({ enabled: true, active: false })
      const track = { id: 'song', title: 'Song', artist: 'Test' }
      const aired = []
      // The reader: the whole song, with the pacer a few seconds behind.
      for (let i = 0; i < frames.length; i += 10) {
        await live._air(frames.slice(i, i + 10).map((data) => ({ data, ms: 26.122, track })))
        drain(live, aired, 3000)
      }
      expect(live.automix.heldFrames).toBeGreaterThan(100)
      const before = aired.length + live._frames.length + live.automix.heldFrames
      expect(before).toBe(frames.length)

      live._running = true
      live._skipRequested = false
      live._readingTrackId = 'song'
      const jumps = []
      live.on('jump', (jump) => jumps.push(jump))
      const playing = live._playForever()
      const deadline = Date.now() + 40_000
      while (jumps.length < 3 && Date.now() < deadline) {
        drain(live, aired, 500)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(jumps.length).toBeGreaterThanOrEqual(3)
      expect(live.foreverInfo().active).toBe(true)
      expect(live.foreverInfo().lastJump.toBeat).toBe(jumps.at(-1).toBeat)

      // The owner turns it off: the song plays out.
      live.setForever(false)
      expect(await playing).toBe(true)
      expect(live.foreverInfo()).toMatchObject({ enabled: false, active: false })
      await live._flushAutomix('test')
      live._running = false
      drain(live, aired)

      expect(aired.length).toBeGreaterThan(frames.length)
      expect(aired.every((frame) => frame.track.id === 'song')).toBe(true)
      // It ended on the song's real ending…
      expect(aired.at(-1).data).toBe(frames.at(-1))
      // …and no frame went out of order except at a jump: every aired frame
      // that is one of the song's own follows its predecessor or a seam.
      const index = new Map(frames.map((data, i) => [data, i]))
      let breaks = 0
      let rendered = 0
      for (let i = 1; i < aired.length; i += 1) {
        const now = index.get(aired[i].data)
        const was = index.get(aired[i - 1].data)
        if (now == null) rendered += 1
        else if (was != null && now !== was + 1) breaks += 1
      }
      expect(breaks).toBe(0)
      expect(rendered).toBeGreaterThan(0)
      expect(rendered).toBeLessThan(jumps.length * 12)
      // The stream decodes end to end at the length the frames say.
      const pcm = await decodeFrames(aired.slice(-2000).map((frame) => frame.data))
      expect(pcm.length).toBe(2000 * 1152)
    } finally {
      await node.close()
    }
  }, 90_000)

  test('a skip ends Forever at once', async () => {
    const { frames } = await analysed()
    const node = await boot({ stations: [{ id: 'fs', name: 'FS', autoStart: false, sources: [], forever: true }] })
    try {
      const live = node.manager.get('fs')
      const track = { id: 'song', title: 'Song', artist: 'Test' }
      const aired = []
      for (let i = 0; i < frames.length; i += 10) {
        await live._air(frames.slice(i, i + 10).map((data) => ({ data, ms: 26.122, track })))
        drain(live, aired, 3000)
      }
      live._running = true
      live._readingTrackId = 'song'
      const playing = live._playForever()
      await new Promise((resolve) => setTimeout(resolve, 50))
      live.skip()
      await playing
      live._running = false
      expect(live._frames.filter((frame) => frame.track.id === 'song')).toEqual([])
      expect(live.foreverInfo().active).toBe(false)
    } finally {
      await node.close()
    }
  }, 60_000)

  test('RL advises a transition only with evidence, and only one the seam can carry', async () => {
    const node = await boot({ stations: [{ id: 'rl', name: 'RL', autoStart: false, sources: [] }] })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livy-rl-'))
    try {
      const live = node.manager.get('rl')
      const beat = (category) => ({ index: 0, category, descriptor: PROTOTYPES[CATEGORIES.indexOf(category)] })
      live._seamKinds = async () => ({ exit: beat('break'), entry: beat('drop') })
      const seam = { beat: true, matched: true, tempoDelta: 0, fadeMs: 8000 }
      const choice = { effect: 'crossfade', source: 'heuristic', baseline: 'crossfade' }

      reloadRL()
      const model = rl(path.join(dir, 'rl-model.json'))
      // Knows nothing yet: says nothing.
      expect(await live.adviseSeam(seam, choice, [], {})).toBeNull()
      for (let i = 0; i < 10; i += 1) {
        model.learn({ exitKind: 'break', entryKind: 'drop', effect: 'slam', outcome: 'completed' })
        model.learn({ exitKind: 'break', entryKind: 'drop', effect: 'crossfade', outcome: 'skipped', skippedAfterMs: 2000 })
      }
      // `rl()` with the default path would load a different model; point the
      // station at this one the way it finds it.
      const advised = await (async () => {
        const original = process.env.LIVY_DATA_DIR
        saveRL(model, path.join(dir, 'rl-model.json'))
        process.env.LIVY_DATA_DIR = dir
        fs.mkdirSync(path.join(dir, 'data'), { recursive: true })
        saveRL(model, path.join(dir, 'data', 'rl-model.json'))
        reloadRL()
        try {
          return {
            usable: await live.adviseSeam(seam, choice, [], {}),
            pooled: await live.adviseSeam(seam, choice, ['crossfade', 'echo'], {}),
            agreed: await live.adviseSeam(seam, { ...choice, effect: 'slam' }, [], {}),
            off: await ((live.options.rl = false), live.adviseSeam(seam, choice, [], {}))
          }
        } finally {
          if (original === undefined) delete process.env.LIVY_DATA_DIR
          else process.env.LIVY_DATA_DIR = original
          reloadRL()
        }
      })()
      expect(advised.usable).toMatchObject({ effect: 'slam', source: 'rl', model: 'RL', baseline: 'crossfade' })
      expect(advised.pooled?.effect ?? 'crossfade').not.toBe('slam')
      expect(advised.agreed).toBeNull()
      expect(advised.off).toBeNull()
      // What it saw is kept for the seam log.
      expect(live._seamKindsNow({ blendMs: 6000 })).toMatchObject({ exitKind: 'break', entryKind: 'drop' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      await node.close()
    }
  })
})

describe('fixes', () => {
  test('a model whose first choice cannot be rendered is asked for its next', () => {
    const seam = { beat: false, matched: false, tempoDelta: 30, fadeMs: 8000, correlation: 0 }
    const unusable = ['roll', 'bass-swap', 'slam', 'drop', 'spindown', 'sweep', 'filter', 'echo', 'wash', 'crossfade'].filter((name) => !effectUsable(name, seam))
    expect(unusable.length).toBeGreaterThan(0)
    const usable = ['wash', 'echo', 'filter', 'crossfade'].filter((name) => effectUsable(name, seam))
    expect(usable.length).toBeGreaterThan(1)
    const baseline = chooseEffectWithModel(seam, [], null).effect
    const second = usable.find((name) => name !== baseline)
    const scores = Object.fromEntries([[unusable[0], 0.9], [second, 0.7], [baseline, 0.2]])
    const model = { best: unusable[0], order: [unusable[0], second, baseline], margin: 0.2, scores, model: 'm.bin' }
    expect(chooseEffectWithModel(seam, [], model)).toMatchObject({ effect: second, source: 'model' })
    // A runner-up that is no better than the rules is not acted on.
    const weak = { ...model, scores: { ...scores, [second]: 0.22 } }
    expect(chooseEffectWithModel(seam, [], weak)).toMatchObject({ effect: baseline, source: 'heuristic' })
  })

  test('a small training set is never scored on rows it trained on', () => {
    const pairs = Array.from({ length: 8 }, (_, i) => ({ x: [i], y: [i] }))
    const { train, test: held } = split(pairs)
    expect(held.length).toBe(2)
    expect(train.length).toBe(6)
    for (const row of held) expect(train).not.toContain(row)
    expect(split(pairs.slice(0, 1)).test).toEqual([])
  })
})
