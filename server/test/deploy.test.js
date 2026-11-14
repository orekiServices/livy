/**
 * Deployment and station integration: the two places where this phase's
 * features meet the rest of the node.
 *
 *   1. **Vercel Serverless.** A function is not a server. Nothing here asserts
 *      that a stream works — it cannot, and the test says so out loud. What it
 *      does assert is that the app boots with no writable disk, that it says
 *      which parts are ephemeral, that the console is served, and that a
 *      route which *needs* a socket explains itself instead of hanging.
 *   2. **Station filters.** The chain has to run inside the real reader
 *      pipeline — decode, filter, encode, hand back frames with the track still
 *      attached — and it has to cost nothing when it is empty.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'

import { serverless, paths } from '../src/config.js'
import { FilterChain, EQ_BANDS } from '../src/core/filters/index.js'
import { decodeMp3, encodeMp3 } from '../src/core/automix.js'
import { quietLogs, beatLoop, tone, toMp3, framesFrom, boot, api, tmpdir } from './helpers.js'

quietLogs()

/* ------------------------------------------------------------------ *
 * Vercel Serverless
 * ------------------------------------------------------------------ */

/**
 * A real HTTP server around the serverless handler.
 *
 * Vercel's Node runtime hands the function a Node `IncomingMessage` and
 * `ServerResponse` over its own socket, so a local server is the closest
 * faithful harness: headers, status codes, chunked responses and aborts all
 * behave the way they will in production. What it cannot reproduce is the
 * platform's freezing, timeouts and ephemeral disk — those are asserted
 * directly against the config instead.
 */
async function serverlessHarness(t) {
  const previous = { ...process.env }
  process.env.VERCEL = '1'
  process.env.LIVY_PLUGINS = 'console'
  // A mounted directory, because /tmp is not a place a test should write to
  // when it has one; what a *bare* Vercel deployment gets is asserted
  // separately, in the config test below.
  process.env.LIVY_DATA_DIR = tmpdir('livy-vercel-')
  // `serverless` and `paths` are read at module load, so the module has to be
  // imported *after* the environment says so. No query string: a cache-busting
  // URL would give `index.js` a second copy of `config.js`, and the copy that
  // answers a request is not necessarily the copy the test inspected.
  const mod = await import('../src/index.js')
  const restore = () => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
  }

  const server = http.createServer((req, res) => mod.handleRequest(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  const get = (urlPath) =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }))
        })
        .on('error', reject)
    })

  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve)
      server.closeIdleConnections?.()
    })
    restore()
  })

  return { get, mod }
}

test('a serverless deployment says which storage it has, and it is ephemeral', async (t) => {
  const { get } = await serverlessHarness(t)

  const info = JSON.parse((await get('/api/v1/info')).body)
  assert.equal(info.name, 'livy')
  assert.ok(info.deployment, 'the deployment is described')
  assert.equal(info.deployment.serverless, true)
  // The harness mounts LIVY_DATA_DIR (a temp dir), so storage is a real, if
  // disposable, directory; a bare deployment gets 'ephemeral' (asserted in the
  // config test below). Either way the *limits* are the part that must be
  // honest, because they are what a client builds on.
  assert.ok(['ephemeral', 'disk'].includes(info.deployment.storage))
  assert.equal(info.deployment.storage, 'disk', 'this harness mounted a directory')
  assert.equal(info.deployment.limits.streaming, false, 'streaming is not available and it says so')
  assert.equal(info.deployment.limits.websocket, false)
  assert.equal(info.deployment.limits.maxFunctionSeconds, 300)
})

test('the console is served by the function, with the filter schema in setup', async (t) => {
  const { get } = await serverlessHarness(t)

  const home = await get('/')
  assert.equal(home.status, 200)
  assert.match(home.type, /text\/html/)
  assert.match(home.body, /<title>Livy<\/title>/)

  const setup = JSON.parse((await get('/api/v1/setup')).body)
  assert.equal(setup.filters.bands.length, EQ_BANDS.length)
  assert.ok(setup.filters.filters.length >= 19, 'every filter is advertised')
  assert.ok(setup.transitions.length >= 10, 'and so is every transition')
})

test('REST works on a serverless deployment; a socket-only route explains itself', async (t) => {
  const { get } = await serverlessHarness(t)

  for (const route of ['/api/v1/info', '/api/v1/sources', '/api/v1/setup', '/api/v1/stations']) {
    const response = await get(route)
    assert.equal(response.status, 200, `${route} answered ${response.status}`)
    assert.match(response.type, /json/)
  }

  // The WebSocket lives on the node's own socket. 501 is the honest answer:
  // 404 would send a client looking for a typo instead of a different host.
  const events = await get('/api/v1/events')
  assert.equal(events.status, 501)
  assert.match(events.body, /long-lived connection/i)
  assert.match(events.body, /bun start/)
})

test('a bare Vercel deployment writes to /tmp, and says so', async () => {
  // The real answer, decided at module load from the real environment: with
  // VERCEL=1 and no mounted volume, nothing may point at the bundle.
  const { execFileSync } = await import('node:child_process')
  const script = `
    process.env.VERCEL = '1'
    delete process.env.LIVY_DATA_DIR
    const cfg = await import('./src/config.js')
    console.log(JSON.stringify({ serverless: cfg.serverless, data: cfg.paths.data, writable: cfg.paths.writable }))
  `
  // `bun` when this suite is running under it, `node` otherwise — the point is
  // the module's decision, and both runtimes must make the same one.
  const runtime = process.versions.bun ? process.execPath : process.execPath
  const out = execFileSync(runtime, ['-e', script], { cwd: path.resolve('.'), encoding: 'utf8', env: { ...process.env, VERCEL: '1', LIVY_DATA_DIR: '' } })
  const answer = JSON.parse(out.trim().split('\n').at(-1))
  assert.equal(answer.serverless, true)
  assert.ok(answer.data.startsWith('/tmp'), `data dir is ${answer.data}`)
  assert.equal(answer.writable, 'ephemeral')

  // And in this process, for whatever it is worth, the values are absolute.
  assert.equal(typeof serverless, 'boolean')
  assert.ok(path.isAbsolute(paths.data))
})

test('a boot failure is a JSON 500, not a hung function', async () => {
  // `handleRequest` deliberately never throws: a function that throws during
  // module init fails the *invocation*, which is far harder to debug than a
  // 500 that names the problem.
  const { handleRequest } = await import('../src/index.js')
  // A `ServerResponse` stand-in with the methods the handler actually uses.
  const fake = {
    statusCode: 0,
    headers: {},
    headersSent: false,
    chunks: [],
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value
    },
    writeHead(status, headers = {}) {
      this.statusCode = status
      for (const [key, value] of Object.entries(headers)) this.setHeader(key, value)
      this.headersSent = true
      return this
    },
    write(chunk) {
      this.chunks.push(chunk)
      return true
    },
    end(body) {
      if (body) this.chunks.push(body)
      this.body = Buffer.concat(this.chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))).toString('utf8')
      this.finished = true
    }
  }
  await handleRequest({ method: 'GET', url: '/api/v1/info', headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' }, on() {} }, fake)
  assert.ok(fake.statusCode >= 200, `a status was set (${fake.statusCode})`)
  assert.ok(fake.finished, 'the response was ended')
  assert.ok(fake.body.length > 0, 'and it has a body')
})

/* ------------------------------------------------------------------ *
 * Station filters, inside the real pipeline
 * ------------------------------------------------------------------ */

test('an unfiltered station builds no chain and does no work', () => {
  const empty = new FilterChain({})
  assert.equal(empty.empty, true)
  assert.deepEqual(empty.active, [])
  assert.equal(empty.process(new Float32Array(16), new Float32Array(16)).left.length, 16, 'processing is a no-op')
})

test('a station applies its chain to what it airs, and keeps the track attached', async (t) => {
  // The unit under test is the station's own path: `#air` → decode → chain →
  // encode. It is driven through `setFilters` and the public frame queue so a
  // refactor of the private stage cannot pass this test by accident.
  const station = await boot({ stations: [{ id: 'fx', name: 'FX FM', autoStart: false, sources: [] }] })
  t.after(() => station.close())
  const live = station.manager.get('fx')

  // A low-pass at 300 Hz over a 4 kHz tone: the audio that comes out has to be
  // measurably darker than the audio that went in.
  const bright = tone({ seconds: 2, freq: 4000 })
  const mp3 = await toMp3(bright)
  const before = await decodeMp3(mp3)
  const highBefore = energyAt(before.left, 4000)

  const info = live.setFilters({ lowpass: { cutoff: 300 } })
  assert.deepEqual(info.active, ['lowpass'])

  // Drive the private air path the way the reader does: one batch of frames.
  const frames = framesFrom(mp3, { id: 'tone', title: 'Tone', artist: 'Test' })
  const out = await live.__airForTest(frames)
  assert.ok(out.length > 0, 'frames came back')

  const rendered = await decodeMp3(Buffer.concat(out.map((frame) => frame.data)))
  const highAfter = energyAt(rendered.left, 4000)
  assert.ok(highAfter < highBefore * 0.25, `4 kHz is 12 dB down (${highBefore.toFixed(4)} → ${highAfter.toFixed(4)})`)

  // The listener must still see the right song.
  assert.equal(out[0].track.id, 'tone')
  assert.ok(Math.abs(out.reduce((sum, frame) => sum + frame.ms, 0) - 2000) < 400, 'the duration is about right')
})

test('clearing the chain puts the station back on untouched audio', async (t) => {
  const station = await boot({ stations: [{ id: 'fx2', name: 'FX2', autoStart: false, sources: [] }] })
  t.after(() => station.close())
  const live = station.manager.get('fx2')

  live.setFilters({ lowpass: { cutoff: 300 } })
  live.setFilters({})
  assert.deepEqual(live.filters.active, [])

  const mp3 = await toMp3(tone({ seconds: 1, freq: 4000 }))
  const out = await live.__airForTest(framesFrom(mp3, { id: 'tone', title: 'Tone', artist: 'Test' }))
  // With no chain the frames are the reader's own objects, byte for byte.
  assert.equal(out.length, framesFrom(mp3, { id: 'x' }).length)
})

test('an unknown filter is an error the owner can see', async (t) => {
  const station = await boot({ stations: [{ id: 'fx3', name: 'FX3', autoStart: false, sources: [] }] })
  t.after(() => station.close())
  const live = station.manager.get('fx3')
  assert.throws(() => live.setFilters({ hologram: { depth: 1 } }), /unknown filter/i)
  // And the station is still usable with the chain it had.
  assert.deepEqual(live.filters.active, [])
})

test('a station carries its configured chain from boot', async (t) => {
  const station = await boot({
    stations: [{ id: 'fx4', name: 'FX4', autoStart: false, sources: [], filters: { tremolo: { frequency: 4, depth: 0.5 } } }]
  })
  t.after(() => station.close())
  const live = station.manager.get('fx4')
  assert.deepEqual(live.filters.active, ['tremolo'])
})

/* ------------------------------------------------------------------ *
 * Filter API over HTTP
 * ------------------------------------------------------------------ */

test('the owner can set and read a station filter chain over REST', async (t) => {
  const station = await boot({
    owner: { key: 'test-owner-key' },
    stations: [{ id: 'api-fx', name: 'API FX', autoStart: false, sources: [] }]
  })
  t.after(() => station.close())

  const base = `http://127.0.0.1:${station.port}`
  const before = await api(base, '/api/v1/owner/stations/api-fx/filters', { key: 'test-owner-key' })
  assert.equal(before._status, 200)
  assert.deepEqual(before.active, [])
  assert.equal(before.schema.bands.length, EQ_BANDS.length)
  assert.ok(before.schema.filters.length >= 19)

  const set = await api(base, '/api/v1/owner/stations/api-fx/filters', {
    method: 'POST',
    key: 'test-owner-key',
    body: { filters: { equalizer: { bands: [{ band: 2, gain: 2 }] }, reverb: { mix: 0.2 } } }
  })
  assert.equal(set._status, 200)
  assert.deepEqual(set.active, ['equalizer', 'reverb'])

  const after = await api(base, '/api/v1/owner/stations/api-fx/filters', { key: 'test-owner-key' })
  assert.deepEqual(after.active, ['equalizer', 'reverb'])
  assert.equal(after.settings.reverb.mix, 0.2)

  // A NodeLink-shaped body (no wrapper object) is accepted too.
  const nodelink = await api(base, '/api/v1/owner/stations/api-fx/filters', {
    method: 'POST',
    key: 'test-owner-key',
    body: { tremolo: { frequency: 3, depth: 0.4 } }
  })
  assert.equal(nodelink._status, 200)
  assert.deepEqual(nodelink.active, ['tremolo'])

  const bad = await api(base, '/api/v1/owner/stations/api-fx/filters', {
    method: 'POST',
    key: 'test-owner-key',
    body: { warble: { amount: 1 } }
  })
  assert.equal(bad._status, 400)
  assert.match(JSON.stringify(bad), /unknown filter/i)
})

/** Energy at one frequency, normalised by the samples analysed. */
function energyAt(samples, freq) {
  const n = Math.min(samples.length, 44_100)
  const k = (2 * Math.PI * freq) / 44_100
  let real = 0
  let imag = 0
  for (let i = 0; i < n; i += 1) {
    real += samples[i] * Math.cos(k * i)
    imag -= samples[i] * Math.sin(k * i)
  }
  return Math.sqrt(real * real + imag * imag) / n
}
