/**
 * Plugin host: discovery, isolation, the extension points (source, effect,
 * HTTP route), enable/disable persistence, reload, rescan — and the shipped
 * plugins actually loading in a real node.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import PluginHost from '../src/core/plugins.ts'
import Store from '../src/store/index.ts'
import SourceRegistry from '../src/sources/index.ts'
import { EFFECTS } from '../src/core/automix.ts'
import { tmpdir, quietLogs, boot, api, waitFor } from './helpers.ts'

quietLogs()

/** Minimal stand-ins: the host only needs an event bus and a registry. */
const fakeManager = () => {
  const bus: any = new EventEmitter()
  bus.stations = new Map()
  bus.list = () => []
  bus.get = () => undefined
  return bus
}

async function host(files: Record<string, string>, { store = null }: any = {}) {
  const dir = tmpdir('livy-plugins-')
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body)
  }
  const instance = new PluginHost({
    dir,
    manager: fakeManager(),
    sources: new SourceRegistry({}),
    store,
    config: { server: { port: 2333 }, owner: { key: 'super-secret' }, stationDefaults: {} },
    version: 'test'
  })
  await instance.loadAll()
  return { host: instance, dir }
}

test('single-file and folder plugins are discovered and started', async () => {
  const { host: h } = await host({
    'single.js': `export const manifest = { name: 'Single', version: '2.0.0' }
      export default function setup(ctx) { ctx.log.info('up') }`,
    'folder/plugin.json': JSON.stringify({ name: 'Folder Plugin', version: '1.2.3', description: 'from a manifest', main: 'main.js' }),
    'folder/main.js': 'export default function setup() {}',
    '.hidden.js': 'export default function setup() { throw new Error("should not load") }',
    'notes.txt': 'ignored'
  })

  const list = h.list()
  assert.equal(list.length, 2)

  const single = list.find((p) => p.id === 'single')
  assert.equal(single.status, 'ready')
  assert.equal(single.version, '2.0.0')

  const folder = list.find((p) => p.id === 'folder')
  assert.equal(folder.name, 'Folder Plugin')
  assert.equal(folder.description, 'from a manifest')
  await h.close()
})

test('a broken plugin is isolated, never fatal', async () => {
  const { host: h } = await host({
    'boom.js': 'export default function setup() { throw new Error("kaboom") }',
    'fine.js': 'export default function setup(ctx) { ctx.log.info("still here") }',
    'empty.js': 'export const manifest = { name: "No setup" }'
  })

  const byId = Object.fromEntries(h.list().map((p) => [p.id, p]))
  assert.equal(byId.boom.status, 'error')
  assert.match(byId.boom.error, /kaboom/)
  assert.equal(byId.empty.status, 'error')
  assert.match(byId.empty.error, /setup/)
  assert.equal(byId.fine.status, 'ready', 'one bad plugin does not stop the others')
  await h.close()
})

test('plugins add sources, transitions and HTTP routes — and give them back', async () => {
  const { host: h } = await host({
    'kitchen-sink.js': `export default function setup(ctx) {
      ctx.registerSource({
        name: 'demo',
        prefixes: ['demo:'],
        canResolve: (q) => q.startsWith('demo:'),
        resolve: async () => ({ type: 'search', name: 'demo', tracks: [] })
      })
      ctx.registerEffect('warp', ({ left, right, total, a, b, gainFor, fade }) => {
        for (let i = 0; i < total; i += 1) {
          const [ga, gb] = gainFor(i / fade)
          left[i] = (a.left[i] ?? 0) * ga + (b.left[i] ?? 0) * gb
          right[i] = left[i]
        }
      })
      ctx.registerRoute('GET', '/ping', ({ res, send }) => { send(res, 200, { pong: true }); return true })
    }`
  })

  const record = h.list()[0]
  assert.deepEqual(record.provides.sources, ['demo'])
  assert.deepEqual(record.provides.effects, ['warp'])
  assert.deepEqual(record.provides.routes, ['/api/v1/x/kitchen-sink/ping'])
  assert.ok(EFFECTS.includes('warp'), 'the transition is offered to stations')
  assert.ok(h.sources.get('demo'), 'the source is in the registry')

  await h.disable('kitchen-sink')
  assert.equal(h.sources.get('demo'), undefined, 'sources are revoked')
  assert.ok(!EFFECTS.includes('warp'), 'effects are revoked')
  assert.equal(h.routes.length, 0, 'routes are revoked')
  await h.close()
})

test('a plugin cannot replace a built-in transition or see the owner key', async () => {
  const { host: h } = await host({
    'nosy.js': `export default function setup(ctx) {
      globalThis.__seenConfig = JSON.stringify(ctx.config)
      try { ctx.registerEffect('crossfade', () => {}) } catch (error) { globalThis.__effectError = error.message }
    }`
  })

  assert.match(globalThis.__effectError, /built-in/)
  assert.doesNotMatch(globalThis.__seenConfig, /super-secret/, 'the owner key never reaches a plugin')
  assert.match(globalThis.__seenConfig, /2333/, 'harmless facts are shared')
  delete globalThis.__seenConfig
  delete globalThis.__effectError
  await h.close()
})

test('events and intervals are delivered, then cleaned up on unload', async () => {
  const { host: h } = await host({
    'listener.js': `export default function setup(ctx) {
      globalThis.__tracks = []
      ctx.on('track', ({ station, data }) => { globalThis.__tracks.push(data.track.title) })
      ctx.on('track', () => { throw new Error('handlers are wrapped') })
    }`
  })

  h.manager.emit('track', { id: 's1' }, { track: { title: 'First' } })
  h.manager.emit('track', { id: 's1' }, { track: { title: 'Second' } })
  assert.deepEqual(globalThis.__tracks, ['First', 'Second'])

  await h.disable('listener')
  h.manager.emit('track', { id: 's1' }, { track: { title: 'Third' } })
  assert.deepEqual(globalThis.__tracks, ['First', 'Second'], 'listeners are removed with the plugin')
  delete globalThis.__tracks
  await h.close()
})

test('enable/disable is remembered in SQLite, and reload re-reads the file', async () => {
  const store = await Store.open(path.join(tmpdir('livy-plugin-db-'), 'livy.db'))
  const { host: h, dir } = await host(
    {
      'toggle.js': `export const manifest = { name: 'Toggle', version: '1.0.0' }
        export default function setup(ctx) { globalThis.__loaded = (globalThis.__loaded ?? 0) + 1 }`,
      'off-by-default/plugin.json': JSON.stringify({ name: 'Off', version: '1.0.0', enabled: false }),
      'off-by-default/index.js': 'export default function setup() { globalThis.__offLoaded = true }'
    },
    { store }
  )

  assert.equal(globalThis.__loaded, 1)
  assert.equal(globalThis.__offLoaded, undefined, 'manifest.enabled=false ships switched off')
  assert.equal(h.list().find((p) => p.id === 'off-by-default').status, 'disabled')

  await h.disable('toggle')
  assert.equal(store.pluginState('toggle').enabled, false)

  await h.enable('off-by-default')
  assert.equal(globalThis.__offLoaded, true)
  assert.equal(store.pluginState('off-by-default').enabled, true)

  // Edit on disk, reload, see the new code.
  fs.writeFileSync(path.join(dir, 'toggle.js'), 'export default function setup() { globalThis.__loaded = 99 }')
  await h.reload('toggle')
  assert.equal(globalThis.__loaded, 99)

  // A new plugin dropped in while running is picked up by rescan.
  fs.writeFileSync(path.join(dir, 'late.js'), 'export default function setup() { globalThis.__late = true }')
  await h.rescan()
  assert.equal(globalThis.__late, true)
  assert.equal(h.list().length, 3)

  for (const key of ['__loaded', '__offLoaded', '__late']) delete globalThis[key]
  await h.close()
  store.close()
})

test('settings come from the manifest, the database and saveSettings()', async () => {
  const store = await Store.open(path.join(tmpdir('livy-plugin-settings-'), 'livy.db'))
  const { host: h } = await host(
    {
      'configurable/plugin.json': JSON.stringify({ name: 'Configurable', version: '1.0.0', settings: { greeting: 'hello', times: 1 } }),
      'configurable/index.js': `export default function setup(ctx) {
        globalThis.__settings = { ...ctx.settings }
        ctx.saveSettings({ times: ctx.settings.times + 1 })
      }`
    },
    { store }
  )

  assert.deepEqual(globalThis.__settings, { greeting: 'hello', times: 1 })
  assert.equal(store.pluginState('configurable').settings.times, 2, 'saveSettings persists')

  await h.reload('configurable')
  assert.equal(globalThis.__settings.times, 2, 'stored settings win over the manifest on the next load')
  delete globalThis.__settings
  await h.close()
  store.close()
})

test('the plugins shipped with Livy load in a real node and serve their routes', async () => {
  const dir = tmpdir('livy-real-')
  const instance = await boot({
    _dir: dir,
    store: { enabled: true, file: path.join(dir, 'livy.db') },
    plugins: { enabled: true, dir: path.resolve('plugins') }
  })
  const base = `http://127.0.0.1:${instance.port}`

  try {
    const byId = Object.fromEntries(instance.plugins.list().map((p) => [p.id, p]))
    assert.equal(byId['now-playing'].status, 'ready')
    assert.equal(byId['hourly-ident'].status, 'disabled', 'the on-air ident is opt-in')
    assert.equal(byId['live-relay'].status, 'disabled', 'a plugin that can grab the transmitter is opt-in too')
    assert.equal(byId.backspin, undefined, 'the demo backspin transition is not shipped')

    const nowPlaying = await api(base, '/api/v1/x/now-playing/')
    assert.equal(nowPlaying._status, 200)
    assert.ok(Array.isArray(nowPlaying.stations))

    const text = await fetch(`${base}/api/v1/x/now-playing/text`)
    assert.equal(text.headers.get('content-type'), 'text/plain; charset=utf-8')

    const missing = await api(base, '/api/v1/x/now-playing/nope')
    assert.equal(missing._status, 404)

    // The file the plugin is supposed to keep up to date.
    const file = path.resolve('data/now-playing.json')
    await waitFor(() => fs.existsSync(file), { label: 'now-playing.json' })
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).updatedAt > 0)

    // Disabling it through the host takes the endpoint away again.
    await instance.plugins.disable('now-playing')
    assert.equal((await api(base, '/api/v1/x/now-playing/'))._status, 404)
  } finally {
    await instance.close()
  }
})
