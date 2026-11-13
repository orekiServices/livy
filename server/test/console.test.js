/**
 * The web console, now that it is a plugin.
 *
 * The console used to be baked into the node; it is a plugin that mounts a
 * static build on the node's own port. So the things worth asserting are:
 * the UI is served same-origin, client-side routes survive a hard refresh,
 * missing assets still 404 (an SPA fallback that answers everything with HTML
 * hides real breakage), the API is never shadowed by the mount, and switching
 * the plugin off leaves a headless node behind.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { quietLogs, tmpdir, boot, api, waitFor } from './helpers.js'

quietLogs()

const KEY = 'console-owner-key'
const PLUGINS = path.resolve('plugins')
const BUILD = path.join(PLUGINS, 'console', 'public')
const built = fs.existsSync(path.join(BUILD, 'index.html'))

async function node(t) {
  const dir = tmpdir('console-')
  const server = await boot({
    _dir: dir,
    owner: { key: KEY, name: 'tester' },
    store: { enabled: true, file: path.join(dir, 'livy.db') },
    plugins: { enabled: true, dir: PLUGINS, disabled: ['now-playing', 'hourly-ident'] }
  })
  t.after(() => server.close())
  return { ...server, base: `http://127.0.0.1:${server.port}`, dir }
}

test('the console plugin mounts the build on the node it runs in', { skip: built ? false : 'no console build — run `npm run build:web`' }, async (t) => {
  const { base, plugins } = await node(t)

  const record = plugins.list().find((p) => p.id === 'console')
  assert.equal(record.status, 'ready')
  assert.equal(record.scope, 'global', 'the UI is node-wide, not per station')
  assert.deepEqual(record.provides.static, ['/'], 'the mount is declared, so the owner can see it')

  const home = await fetch(`${base}/`)
  assert.equal(home.status, 200)
  assert.match(home.headers.get('content-type'), /text\/html/)
  assert.match(await home.text(), /<html/i)

  const meta = await api(base, '/api/v1/x/console/')
  assert.equal(meta.mount, '/')
  assert.ok(meta.build.files > 0 && meta.build.kb > 0)
  assert.deepEqual(meta.pages, ['/', '/listen/', '/station/', '/owner/'], 'the console knows which pages it ships')
})

test('client-side routes survive a refresh, but a missing asset is still missing', { skip: built ? false : 'no console build' }, async (t) => {
  const { base } = await node(t)

  for (const route of ['/owner/', '/station/']) {
    const res = await fetch(`${base}${route}`)
    assert.equal(res.status, 200, `${route} should be served`)
    assert.match(res.headers.get('content-type'), /text\/html/)
  }

  // Deep client route that has no file of its own: the SPA fallback answers.
  const deep = await fetch(`${base}/owner/anything/`)
  assert.equal(deep.status, 200)

  // Anything that looks like an asset must 404 rather than quietly return HTML.
  for (const missing of ['/_next/static/chunks/nope.js', '/favicon-nope.png', '/styles/nope.css']) {
    const res = await fetch(`${base}${missing}`)
    assert.equal(res.status, 404, `${missing} should 404`)
  }
})

test('the mount never shadows the API, the stream or health', { skip: built ? false : 'no console build' }, async (t) => {
  const { base } = await node(t)

  assert.equal((await api(base, '/health')).status, 'ok')
  assert.equal((await api(base, '/api/v1/info')).name, 'livy')
  assert.equal((await api(base, '/api/v1/stations/nope'))._status, 404, 'an unknown API route is an API 404, not the app shell')

  // The console mount must not swallow /stream either: a bad stream URL is
  // still answered by the broadcaster — as spoken audio for a player, and
  // as JSON for anything that asks for JSON — never as the app shell.
  const stream = await fetch(`${base}/stream/nope`)
  assert.equal(stream.status, 404)
  assert.equal(stream.headers.get('x-livy-error'), 'not_a_stream')
  assert.match(stream.headers.get('content-type'), /audio\/mpeg/)
  await stream.arrayBuffer()

  const asJson = await fetch(`${base}/stream/nope.mp3`, { headers: { accept: 'application/json' } })
  assert.equal(asJson.status, 404)
  assert.match(asJson.headers.get('content-type'), /application\/json/)
  assert.equal((await asJson.json()).code, 'unknown_station')
})

test('switching the console off leaves a headless node', { skip: built ? false : 'no console build' }, async (t) => {
  const { base, plugins } = await node(t)

  await plugins.disable('console')

  const home = await fetch(`${base}/`)
  assert.equal(home.status, 404, 'no UI')
  assert.equal((await api(base, '/api/v1/x/console/'))._status, 404, 'no console endpoint')
  assert.equal((await api(base, '/api/v1/info')).name, 'livy', 'but the radio is still on')

  await plugins.enable('console')
  assert.equal((await fetch(`${base}/`)).status, 200, 'and it comes back')
})

test('a node with no console build still boots, and picks the build up live', async (t) => {
  // A fresh clone has no `public/`: the node must come up anyway and say what
  // to run, rather than failing to start or answering with a bare 404.
  const dir = tmpdir('console-unbuilt-')
  const plugins = path.join(dir, 'plugins')
  fs.mkdirSync(path.join(plugins, 'console'), { recursive: true })
  fs.copyFileSync(path.join(PLUGINS, 'console', 'index.js'), path.join(plugins, 'console', 'index.js'))
  fs.copyFileSync(path.join(PLUGINS, 'console', 'plugin.json'), path.join(plugins, 'console', 'plugin.json'))

  const server = await boot({
    _dir: dir,
    owner: { key: KEY },
    store: { enabled: true, file: path.join(dir, 'livy.db') },
    plugins: { enabled: true, dir: plugins }
  })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.port}`

  assert.equal(server.plugins.list().find((p) => p.id === 'console').status, 'ready', 'a missing build is not a broken plugin')

  const home = await fetch(`${base}/`)
  assert.equal(home.status, 503, 'honest status: the UI is not available yet')
  assert.match(home.headers.get('content-type'), /text\/html/)
  const html = await home.text()
  assert.match(html, /bun run build:web/, 'the page says exactly what to run')
  assert.ok(!html.includes(dir), 'and does not print a filesystem path at a stranger')

  assert.equal((await fetch(`${base}/_next/static/chunks/app.js`)).status, 404, 'assets still 404')
  assert.equal((await api(base, '/api/v1/info')).name, 'livy', 'the radio is unaffected')
  assert.equal((await api(base, '/api/v1/x/console/')).built, false)

  // Now "build" it while the node runs: no restart, no reload.
  if (built) {
    fs.cpSync(BUILD, path.join(plugins, 'console', 'public'), { recursive: true })
    await waitFor(async () => (await fetch(`${base}/`)).status === 200, { timeout: 15_000, interval: 250, label: 'the build to be picked up' })
    assert.match(await (await fetch(`${base}/`)).text(), /<html/i)
    assert.equal((await api(base, '/api/v1/x/console/')).built, true)
  }
})

test('the console build is a static export with no secrets baked in', { skip: built ? false : 'no console build' }, () => {
  const html = fs.readFileSync(path.join(BUILD, 'index.html'), 'utf8')
  assert.ok(!/LIVY_|process\.env/.test(html), 'no environment in the HTML')
  assert.ok(!/localhost:\d+|127\.0\.0\.1/.test(html), 'no hard-coded node address')
  assert.ok(fs.existsSync(path.join(BUILD, 'owner', 'index.html')), 'the owner console is part of the build')
})
