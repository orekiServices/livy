/**
 * The source registry's manners: it answers without waiting for the slowest
 * provider, and it remembers what each one did.
 *
 * A console search fans out over a dozen providers on other people's servers.
 * One of them is always having a bad day, and before this the whole search
 * waited for it. These tests use stub providers, so nothing here touches the
 * network.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { SourceRegistry } from '../src/sources/index.js'

function stub({ name, tracks = [], delay = 0, fail = null }) {
  return {
    name,
    calls: 0,
    prefixes: [],
    canResolve: () => false,
    async resolve() {
      return { tracks: [] }
    },
    async search(_term, limit) {
      this.calls += 1
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      if (fail) throw new Error(fail)
      return tracks.slice(0, limit).map((track) => ({ ...track, source: name }))
    }
  }
}

/**
 * A registry whose *only* searchable providers are the stubs.
 *
 * The built-ins stay in `noSearch`, so nothing here can reach the internet —
 * a test that fans out to SoundCloud hangs for reasons that have nothing to do
 * with the code under test.
 */
const registry = (sources, config = {}) => {
  const registry = new SourceRegistry({ searchTimeoutMs: 120, ...config })
  registry.noSearch = new Set(registry.sources.map((source) => source.name))
  for (const source of sources) {
    registry.register(source)
    registry.noSearch.delete(source.name)
  }
  return registry
}

const song = (index, name = 'unit') => ({ id: `${name}-${index}`, title: `Song ${index}`, artist: 'Artist', bitrate: 128, duration: 180 })

test('search: a hung provider is a timeout, not a stall', async () => {
  const fast = stub({ name: 'fast', tracks: [song(1, 'fast'), song(2, 'fast')] })
  const hung = stub({ name: 'hung', tracks: [song(3, 'hung')], delay: 5_000 })
  const sources = registry([fast, hung])

  const started = Date.now()
  const found = await sources.search('song', 10)
  const elapsed = Date.now() - started

  assert.ok(elapsed < 1_000, `answered in ${elapsed} ms, not 5 s`)
  assert.equal(found.length, 2, 'the results that arrived are the results')
  assert.ok(found.every((track) => track.source === 'fast'))

  const health = sources.healthOf()
  assert.equal(health.hung.failed, 1)
  assert.match(health.hung.lastError, /timed out/)
  assert.equal(health.fast.ok, 1)
  assert.ok(health.fast.avgMs != null)
  assert.equal(health.fast.healthy, true)
  assert.equal(health.hung.healthy, false)
})

test('search: one failing provider does not fail the search', async () => {
  const good = stub({ name: 'good', tracks: [song(1, 'good')] })
  const bad = stub({ name: 'bad', fail: 'connection reset' })
  const sources = registry([good, bad])

  const found = await sources.search('song', 10)
  assert.equal(found.length, 1)
  assert.equal(found[0].source, 'good')

  const health = sources.healthOf('bad')
  assert.equal(health.calls, 1)
  assert.equal(health.failed, 1)
  assert.equal(health.lastError, 'connection reset')
  assert.equal(health.healthy, false)
})

test('health: unmeasured is not unhealthy, and a single-provider search is measured too', async () => {
  const mine = stub({ name: 'mine', tracks: [song(1, 'mine')] })
  const sources = registry([mine])

  assert.equal(sources.healthOf('mine').healthy, null, 'nothing tried yet')
  assert.equal(sources.healthOf('never-registered').calls, 0)

  await sources.search('song', 5, 'mine')
  const health = sources.healthOf('mine')
  assert.equal(health.calls, 1)
  assert.equal(health.ok, 1)
  assert.equal(health.healthy, true)
  assert.ok(health.avgMs >= 0)

  // The public listing carries it, so the console can show a provider's record
  // next to its name without a second request.
  const listed = sources.describe({ health: true }).find((entry) => entry.name === 'mine')
  assert.equal(listed.health.calls, 1)
  assert.equal(sources.describe().find((entry) => entry.name === 'mine').health, undefined, 'off by default')
})

test('health: resolve and stream are recorded per provider', async () => {
  const resolving = {
    name: 'resolving',
    prefixes: ['resolve:'],
    canResolve: (query) => query.startsWith('resolve:'),
    async resolve() {
      return { tracks: [song(1, 'resolving')] }
    },
    async stream() {
      return { url: 'http://example.invalid/stream.mp3' }
    }
  }
  const sources = registry([resolving])
  await sources.resolve('resolve:anything')
  assert.equal(sources.healthOf('resolving').ok, 1)

  await sources.stream({ ...song(2, 'resolving'), source: 'resolving' })
  const health = sources.healthOf('resolving')
  assert.equal(health.calls, 2, 'the stream attempt counts too')
  assert.equal(health.failed, 0)
})
