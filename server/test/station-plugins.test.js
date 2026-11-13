/**
 * Plugins, per station.
 *
 * A plugin is loaded once for the node, but it does not have to apply to every
 * station. The rules this pins down:
 *
 *   • no override → the station follows the plugin's global state;
 *   • an override is enforced by the host, not by the plugin behaving well:
 *     a station it is off for is invisible through `ctx.stations` and its
 *     events are never delivered;
 *   • global plugins (the console) cannot be switched per station;
 *   • choices live in SQLite and survive a restart;
 *   • deleting a station forgets its choices, so a reused id starts clean.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import PluginHost from '../src/core/plugins.js'
import Store from '../src/store/index.js'
import SourceRegistry from '../src/sources/index.js'
import { tmpdir, quietLogs, boot, api, makeMedia, waitFor } from './helpers.js'

quietLogs()

const KEY = 'scope-owner-key'
const PLUGINS = path.resolve('plugins')

/** A manager stand-in: an event bus with a couple of stations in it. */
const fakeManager = (ids = ['lofi', 'talk']) => {
  const bus = new EventEmitter()
  bus.stations = new Map(ids.map((id) => [id, { id, name: id.toUpperCase(), state: 'playing' }]))
  bus.list = () => [...bus.stations.values()]
  bus.get = (id) => bus.stations.get(id)
  return bus
}

async function host(files, { store = null, stations = ['lofi', 'talk'] } = {}) {
  const dir = tmpdir('scope-plugins-')
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body)
  }
  const manager = fakeManager(stations)
  const instance = new PluginHost({
    dir,
    manager,
    sources: new SourceRegistry({}),
    store,
    config: { server: { port: 2333 }, owner: { key: 'super-secret' }, stationDefaults: {} },
    version: 'test'
  })
  await instance.loadAll()
  return { host: instance, dir, manager }
}

/** A plugin that records every station it is allowed to see or hear. */
const SPY = `export const manifest = { name: 'Spy', version: '1.0.0', scope: 'stations' }
  export const seen = { events: [], scope: [] }
  export default function setup(ctx) {
    globalThis.__spy = seen
    ctx.on('track', ({ station }) => seen.events.push(station.id))
    ctx.stations.onScopeChange((change) => seen.scope.push(change))
    seen.visible = () => ctx.stations.all().map((s) => s.id)
    seen.settingsFor = (id) => ctx.stations.settings(id)
  }`

test('with no override every station follows the plugin', async () => {
  const { host: h, manager } = await host({ 'spy.js': SPY })
  const spy = globalThis.__spy

  assert.deepEqual(spy.visible(), ['lofi', 'talk'])
  assert.equal(h.appliesTo('spy', 'lofi'), true)
  assert.deepEqual(h.list()[0].stations.mode, 'all')

  manager.emit('track', manager.get('lofi'), { track: { title: 'x' } })
  manager.emit('track', manager.get('talk'), { track: { title: 'y' } })
  assert.deepEqual(spy.events, ['lofi', 'talk'])
  await h.close()
})

test('switching a plugin off for one station hides that station completely', async () => {
  const { host: h, manager } = await host({ 'spy.js': SPY })
  const spy = globalThis.__spy

  h.setStationState('spy', 'talk', false)

  assert.deepEqual(spy.visible(), ['lofi'], 'it is gone from ctx.stations')
  assert.equal(h.appliesTo('spy', 'talk'), false)

  manager.emit('track', manager.get('talk'), { track: { title: 'unheard' } })
  manager.emit('track', manager.get('lofi'), { track: { title: 'heard' } })
  assert.deepEqual(spy.events, ['lofi'], 'and its events never arrive')

  assert.deepEqual(spy.scope.at(-1), { station: 'talk', enabled: false }, 'the plugin is told, so it can tidy up')

  const listed = h.list().find((p) => p.id === 'spy')
  assert.deepEqual(listed.stations, { scope: 'stations', mode: 'some', on: ['lofi'], off: ['talk'], overrides: { talk: false } })

  // …and back again.
  h.clearStationState('spy', 'talk')
  assert.deepEqual(spy.visible(), ['lofi', 'talk'])
  assert.equal(h.list().find((p) => p.id === 'spy').stations.mode, 'all')
  await h.close()
})

test('per-station settings are layered over the plugin\'s own', async () => {
  const dir = tmpdir('scope-store-')
  const store = await Store.open(path.join(dir, 'n.db'))
  const { host: h } = await host(
    {
      'spy/plugin.json': JSON.stringify({ name: 'Spy', version: '1.0.0', scope: 'stations', settings: { colour: 'orange', every: 6 } }),
      'spy/index.js': SPY.replace("export const manifest = { name: 'Spy', version: '1.0.0', scope: 'stations' }", '')
    },
    { store }
  )
  const spy = globalThis.__spy

  assert.deepEqual(spy.settingsFor('lofi'), { colour: 'orange', every: 6 })
  h.setStationState('spy', 'lofi', true, { settings: { colour: 'teal' } })
  assert.deepEqual(spy.settingsFor('lofi'), { colour: 'teal', every: 6 }, 'the station wins, the rest is inherited')
  assert.deepEqual(spy.settingsFor('talk'), { colour: 'orange', every: 6 }, 'and nobody else is affected')

  await h.close()
  store.close()
})

test('a global plugin cannot be switched per station', async () => {
  const { host: h } = await host({
    'ui/plugin.json': JSON.stringify({ name: 'UI', version: '1.0.0', scope: 'global' }),
    'ui/index.js': 'export default function setup() {}'
  })

  assert.throws(() => h.setStationState('ui', 'lofi', false), /global plugin/)
  assert.equal(h.appliesTo('ui', 'lofi'), true)
  assert.equal(h.list().find((p) => p.id === 'ui').stations.mode, 'global')
  assert.equal(h.stationView('lofi').some((p) => p.id === 'ui'), false, 'and it is not offered in the station view')
  await h.close()
})

test('choices are stored in SQLite and survive a reload of the host', async () => {
  const dir = tmpdir('scope-persist-')
  const store = await Store.open(path.join(dir, 'n.db'))
  const files = { 'spy.js': SPY }

  const first = await host(files, { store })
  first.host.setStationState('spy', 'talk', false)
  await first.host.close()

  // A second host over the same database picks the decision straight back up.
  const second = new PluginHost({
    dir: first.dir,
    manager: fakeManager(),
    sources: new SourceRegistry({}),
    store,
    config: { server: { port: 2333 }, stationDefaults: {} },
    version: 'test'
  })
  await second.loadAll()
  assert.equal(second.appliesTo('spy', 'talk'), false, 'still off after a restart')
  assert.deepEqual(globalThis.__spy.visible(), ['lofi'])

  // Deleting the station forgets the choice, so a reused id starts clean.
  second.manager.emit('removed', { id: 'talk' })
  assert.equal(second.appliesTo('spy', 'talk'), true)
  assert.deepEqual(store.pluginState('spy').stations, {})

  await second.close()
  store.close()
})

/* ------------------------------ over HTTP ------------------------------- */

async function node(t) {
  const dir = tmpdir('scope-api-')
  const mediaDir = path.join(dir, 'media')
  makeMedia(mediaDir, { count: 2, ms: 4000 })

  const server = await boot({
    _dir: dir,
    owner: { key: KEY, name: 'tester' },
    sources: { mediaDir },
    store: { enabled: true, file: path.join(dir, 'livy.db') },
    plugins: { enabled: true, dir: PLUGINS, disabled: ['console'] },
    stations: [
      { id: 'lofi', name: 'Lo-Fi', playlists: [`local:${mediaDir}`], autoStart: false },
      { id: 'talk', name: 'Talk', playlists: [`local:${mediaDir}`], autoStart: false }
    ]
  })
  t.after(() => server.close())
  return { ...server, base: `http://127.0.0.1:${server.port}`, dir }
}

test('the owner API can scope a shipped plugin to one station', async (t) => {
  const { base } = await node(t)

  const view = await api(base, '/api/v1/owner/stations/talk/plugins', { key: KEY })
  assert.equal(view._status, 200)
  const np = view.plugins.find((p) => p.id === 'now-playing')
  assert.deepEqual({ enabled: np.enabled, source: np.source }, { enabled: true, source: 'node' })
  assert.equal(view.plugins.some((p) => p.id === 'console'), false, 'global plugins are not offered per station')

  assert.deepEqual(
    (await api(base, '/api/v1/x/now-playing/')).stations.map((s) => s.id).sort(),
    ['lofi', 'talk'],
    'both stations to begin with'
  )

  const off = await api(base, '/api/v1/owner/stations/talk/plugins/now-playing/disable', { method: 'POST', key: KEY })
  assert.equal(off._status, 200)
  assert.equal(off.plugins.find((p) => p.id === 'now-playing').enabled, false)

  // The plugin's own endpoint follows immediately: no restart, no reload.
  assert.deepEqual((await api(base, '/api/v1/x/now-playing/')).stations.map((s) => s.id), ['lofi'])

  const back = await api(base, '/api/v1/owner/stations/talk/plugins/now-playing/reset', { method: 'POST', key: KEY })
  assert.equal(back.plugins.find((p) => p.id === 'now-playing').source, 'node')
  assert.deepEqual((await api(base, '/api/v1/x/now-playing/')).stations.map((s) => s.id).sort(), ['lofi', 'talk'])
})

test('scoping is owner-only and validated', async (t) => {
  const { base } = await node(t)

  assert.equal((await api(base, '/api/v1/owner/stations/talk/plugins'))._status, 401, 'no key, no answer')
  assert.equal((await api(base, '/api/v1/owner/stations/nope/plugins', { key: KEY }))._status, 404)
  assert.equal((await api(base, '/api/v1/owner/stations/talk/plugins/nope/disable', { method: 'POST', key: KEY }))._status, 404)

  const global = await api(base, '/api/v1/owner/stations/talk/plugins/console/disable', { method: 'POST', key: KEY })
  assert.equal(global._status, 400)
  assert.match(global.message, /global plugin/)
})

test('one PATCH can re-scope a plugin across stations', async (t) => {
  const { base } = await node(t)

  const patched = await api(base, '/api/v1/owner/plugins/now-playing', {
    method: 'PATCH',
    key: KEY,
    body: { stations: { talk: false, lofi: true } }
  })
  assert.equal(patched._status, 200)
  assert.deepEqual(patched.stations.off, ['talk'])
  assert.deepEqual(patched.stations.overrides, { talk: false, lofi: true })

  // The file the plugin writes only covers the stations it applies to.
  const file = path.resolve('data/now-playing.json')
  await waitFor(() => fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).stations.every((s) => s.id !== 'talk'), {
    label: 'now-playing to drop the station it is off for'
  })

  const cleared = await api(base, '/api/v1/owner/plugins/now-playing', { method: 'PATCH', key: KEY, body: { stations: { talk: null, lofi: null } } })
  assert.deepEqual(cleared.stations.overrides, {}, 'null forgets the override')
  assert.equal(cleared.stations.mode, 'all')
})
