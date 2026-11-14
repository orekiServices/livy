/**
 * The Forever Jukebox integration: the analysis it serves, the graph built from
 * it, and the client that fetches it.
 *
 * The fixture is a trimmed analysis of a real track from the Forever Jukebox
 * project's own parity corpus (MIT), so the numbers here are the numbers an
 * instance actually returns. No test touches the network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { FjClient, beatTrackFromFj, graphFromFjAnalysis, normaliseFjAnalysis } from '../src/core/seams/fj.ts'
import { ForeverJukebox } from '../src/core/seams/index.ts'
import { encodeMp3 } from '../src/core/automix.ts'
import { beatLoop, tmpdir } from './helpers.ts'

const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'fj-analysis.json'), 'utf8'))

describe('a Forever Jukebox analysis', () => {
  const analysis = normaliseFjAnalysis(fixture)

  test('normalises the Spotify-shaped payload', () => {
    expect(analysis).toBeTruthy()
    expect(analysis.beats.length).toBe(64)
    expect(analysis.track.tempo).toBeCloseTo(125, 0)
    expect(analysis.track.duration).toBeCloseTo(170.4, 0)
    // Beats know where they sit in the bar, which is the one thing our own
    // tracker only guesses.
    expect(analysis.beats.some((beat) => beat.indexInParent === 3)).toBe(true)
    expect(analysis.beats[0].overlappingSegments.length).toBeGreaterThan(0)
    expect(analysis.beats[8].overlappingSegments[0].pitches.length).toBe(12)
  })

  test('a payload with no beats is refused, not half-read', () => {
    expect(normaliseFjAnalysis({ beats: [] })).toBeNull()
    expect(normaliseFjAnalysis(null)).toBeNull()
    expect(normaliseFjAnalysis({})).toBeNull()
  })

  test('builds a graph that can loop', () => {
    const graph = graphFromFjAnalysis(analysis)
    expect(graph.source).toBe('forever-jukebox')
    expect(graph.threshold).toBeGreaterThanOrEqual(10)
    expect(graph.threshold).toBeLessThanOrEqual(80)
    expect(graph.branching).toBeGreaterThan(0)
    expect(graph.lastBranch).toBeGreaterThanOrEqual(0)
    expect(graph.positions.length).toBe(64)
    // At most four branches per beat, as the original.
    for (const row of graph.neighbours) expect(row.length).toBeLessThanOrEqual(4)
  })

  test('every edge is a real pair with a distance under the threshold', () => {
    const graph = graphFromFjAnalysis(analysis)
    for (let from = 0; from < graph.neighbours.length; from += 1) {
      for (const edge of graph.neighbours[from]) {
        expect(edge.from).toBe(from)
        expect(edge.to).not.toBe(from)
        expect(edge.distance).toBeLessThanOrEqual(graph.threshold)
      }
    }
  })

  test('the beat track the walk uses keeps the bar positions', () => {
    const track = beatTrackFromFj(analysis)
    expect(track.beats.length).toBe(64)
    expect(track.bpm).toBeCloseTo(125, 0)
    for (let i = 0; i < track.beats.length; i += 1) {
      expect(track.beats[i].bar).toBe(analysis.beats[i].indexInParent ?? i % 4)
    }
    // No vectors: the graph has the real distance, so there is nothing to
    // fall back to, and the walker must not pretend otherwise.
    expect(track.vectors.length).toBe(0)
  })

  test('a pinned threshold is honoured, and a tighter one branches less', () => {
    const wide = graphFromFjAnalysis(analysis, { threshold: 80 })
    const narrow = graphFromFjAnalysis(analysis, { threshold: 12 })
    expect(wide.threshold).toBe(80)
    expect(narrow.threshold).toBe(12)
    expect(narrow.branching).toBeLessThanOrEqual(wide.branching)
  })
})

describe('the client', () => {
  let server
  let base
  let requests = []
  let payload = { status: 'complete', id: 'job-1', result: fixture.analysis }
  let job = { id: 'job-1' }
  let status = 200

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        requests.push(url.pathname + url.search)
        if (status !== 200) return new Response('nope', { status })
        if (url.pathname === '/api/jobs/by-track') return Response.json(job)
        if (url.pathname.startsWith('/api/analysis/')) return Response.json(payload)
        return new Response('not found', { status: 404 })
      }
    })
    base = `http://127.0.0.1:${server.port}`
  })

  afterAll(() => server?.stop(true))

  test('fetches by track, then by job, and caches the analysis', async () => {
    const cacheDir = tmpdir('livy-fj-')
    const client = new FjClient({ baseUrl: base, cacheDir })
    requests = []
    const analysis = await client.analysisFor({ title: 'Soulful House Vocals', artist: 'Producer Space', durationMs: 170_388 })
    expect(analysis?.beats.length).toBe(64)
    expect(requests).toEqual([
      '/api/jobs/by-track?title=Soulful%20House%20Vocals&artist=Producer%20Space',
      '/api/analysis/job-1'
    ])
    // Second call is served from disk, with no more requests.
    requests = []
    const again = await client.analysisFor({ title: 'Soulful House Vocals', artist: 'Producer Space', durationMs: 170_388 })
    expect(again?.beats.length).toBe(64)
    expect(requests).toEqual([])
    expect(client.info().cached).toBe(1)
  })

  test('an unknown track is a miss, not an error', async () => {
    const client = new FjClient({ baseUrl: base, cacheDir: null })
    job = {} as any
    expect(await client.analysisFor({ title: 'Nothing', artist: 'Nobody' })).toBeNull()
    job = { id: 'job-1' }
    expect(client.info().misses).toBeGreaterThan(0)
    expect(client.info().failures).toBe(0)
  })

  test('an analysis of a different recording is refused', async () => {
    const client = new FjClient({ baseUrl: base, cacheDir: null })
    // The node's audio is a minute shorter than the analysis: the beats would
    // land in the wrong places, which is a seam the listener can hear.
    const analysis = await client.analysisFor({ title: 'Soulful House Vocals', artist: 'Producer Space', durationMs: 110_000 })
    expect(analysis).toBeNull()
    expect(client.info().lastError).toContain('different recording')
  })

  test('an instance that is down does not stop the station', async () => {
    const client = new FjClient({ baseUrl: 'http://127.0.0.1:1', cacheDir: null, timeoutMs: 300 })
    expect(await client.analysisFor({ title: 'Any', artist: 'One' })).toBeNull()
    expect(client.info().failures).toBe(1)
    expect(client.info().lastError).toBeTruthy()
  })

  test('LIVY_FJ_API=off turns it off entirely', () => {
    const client = new FjClient({ baseUrl: 'off' })
    expect(client.enabled).toBe(false)
  })
})

describe('the walk on a real analysis', () => {
  test('jumps between beats that sound alike, and describes each one', async () => {
    const analysis = normaliseFjAnalysis(fixture)
    const graph = graphFromFjAnalysis(analysis)
    // Audio long enough to hold the fixture's 64 beats (125 BPM), synthesised
    // here because this test is about the walk's decisions; the seam renderer
    // has its own tests on real MP3.
    const audio = await encodeMp3(beatLoop({ bpm: 125, seconds: 32 }))
    const frames = []
    for (let at = 0; at < audio.length; at += 418) frames.push(audio.subarray(at, Math.min(at + 418, audio.length)))
    const jukebox = new ForeverJukebox({
      frames,
      track: beatTrackFromFj(analysis),
      graph,
      random: () => 0.99,
      minChance: 1,
      maxChance: 1
    })
    const seen = []
    for (let i = 0; i < 400 && seen.length < 3; i += 1) {
      const segment = await jukebox.next()
      if (segment.jump) seen.push(segment.jump)
      if (segment.ended) break
    }
    expect(seen.length).toBeGreaterThan(0)
    for (const jump of seen) {
      expect(jump.percent).toBeGreaterThanOrEqual(0)
      expect(jump.percent).toBeLessThanOrEqual(100)
      expect(['good', 'fair', 'poor']).toContain(jump.quality)
      expect(graph.positions[jump.fromBeat]).toBeDefined()
      expect(graph.positions[jump.toBeat]).toBeDefined()
    }
  })

  test('FjClient accepts millisecond track.duration from Livy tracks', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/api/jobs/by-track') return Response.json({ id: 'job-ms' })
        if (url.pathname === '/api/analysis/job-ms') {
          return Response.json({ id: 'job-ms', status: 'complete', progress: 100, result: fixture.analysis })
        }
        return new Response('not found', { status: 404 })
      }
    })
    try {
      const client = new FjClient({ baseUrl: server.url.origin, cacheDir: tmpdir('fj-ms-') })
      // `fixture` has duration ~170.4 s; Livy tracks store ms (170_388).
      const analysis = await client.analysisFor({ title: 'Soulful House Vocals', artist: 'Producer Space', duration: 170_388 })
      expect(analysis).not.toBeNull()
      expect(analysis?.beats.length).toBeGreaterThan(0)
    } finally {
      server.stop(true)
    }
  })
})
