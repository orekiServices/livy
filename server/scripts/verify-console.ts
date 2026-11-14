#!/usr/bin/env bun
/**
 * Does the console actually work against this node?
 *
 * This is the browser-free half of `web/e2e/console.spec.ts`: it asks the node
 * for every route the console exports, follows one of its script tags to prove
 * the bundle is really being served, and then sends the exact payloads the
 * console's filter rack sends — because a rack that renders but cannot reach
 * the DSP is the failure mode that looks fine in a screenshot.
 *
 *   bun scripts/verify-console.ts [baseUrl]
 *
 * Default base is `http://127.0.0.1:3000`, which is where `bun src/index.ts`
 * serves the console. Playwright covers the same ground with a real browser
 * when one is available; this runs anywhere.
 */
const base = (process.argv[2] ?? process.env.LIVY_CONSOLE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')

const ROUTES = [
  ['/', 'Late night'],
  ['/station', null],
  ['/seams', 'Seams'],
  ['/filters', 'Radio filters'],
  ['/lyrics', 'Words'],
  ['/search', 'Search'],
  ['/stations', 'Stations'],
  ['/models', 'Training'],
  ['/ops', 'Node'],
  ['/owner', 'Owner desk']
]

/**
 * The rack's "on with no parameters" payloads, copied from
 * `web/app/filters/page.js`. Each one must engage on the node; a payload the
 * console sends and the node drops is a dead switch.
 */
const RACK = {
  timescale: { speed: 1.1, pitch: 1, rate: 1 },
  karaoke: { level: 1, monoLevel: 0.4, filterBand: 220, filterWidth: 100 },
  channelMix: { leftToLeft: 0.8, leftToRight: 0.2, rightToLeft: 0.2, rightToRight: 0.8 },
  compressor: { threshold: -18, ratio: 4, attack: 0.01, release: 0.25, gain: 1, makeupGain: 1.2 },
  lowpass: { cutoff: 6000, smoothing: 1, resonance: 0 },
  highpass: { cutoff: 80, smoothing: 1, resonance: 0 },
  rotation: { rotationHz: 0.2 },
  tesseract: { rotationHz: 0.15 },
  spatial: { x: 1, y: 0, z: 0, depth: 0.5 },
  tremolo: { frequency: 5, depth: 0.5 },
  vibrato: { frequency: 5, depth: 0.3 },
  chorus: { delay: 25, rate: 1.5, depth: 0.3, feedback: 0.15, mix: 0.4 },
  phaser: { rate: 0.6, depth: 0.7, feedback: 0.3, mix: 0.5 },
  flanger: { rate: 0.4, depth: 0.5, feedback: 0.2, mix: 0.4 },
  echo: { delay: 350, feedback: 0.35, mix: 0.25 },
  reverb: { roomSize: 0.6, damping: 0.4, wetLevel: 0.35, dryLevel: 0.9, width: 0.6, mix: 0.35 },
  distortion: { scale: 1.5, offset: 0.1 },
  phonograph: { frequency: 1, depth: 0.5, crackle: 0.2, flutter: 0.1, room: 0.2, micAgc: 0, drive: 0.2 }
}

const PRESETS = {
  warm: { equalizer: { bands: [{ band: 1, gain: 0.33 }, { band: 13, gain: -0.5 }] } },
  bright: { equalizer: { bands: [{ band: 8, gain: 0.12 }, { band: 13, gain: 0.26 }] } },
  club: {
    equalizer: { bands: [{ band: 0, gain: 0.41 }, { band: 13, gain: 0.19 }] },
    compressor: { threshold: -12, ratio: 3, attack: 0.02, release: 0.2, gain: 1, makeupGain: 1.2 }
  },
  lofi: {
    lowpass: { cutoff: 4200, smoothing: 1 },
    highpass: { cutoff: 120, smoothing: 1 },
    phonograph: { crackle: 0.18, flutter: 0.08, room: 0.2, drive: 0.25, depth: 0.4 }
  },
  night: { lowpass: { cutoff: 9000 }, compressor: { threshold: -20, ratio: 5, attack: 0.01, release: 0.3, gain: 1, makeupGain: 1.5 } },
  karaoke: { karaoke: { level: 1, monoLevel: 0.6, filterBand: 220, filterWidth: 120 } },
  space: {
    reverb: { mix: 0.45, roomSize: 0.7, damping: 0.35, wetLevel: 0.4, dryLevel: 0.9, width: 0.7 },
    echo: { mix: 0.2, delay: 420, feedback: 0.3 }
  },
  phone: { highpass: { cutoff: 380, smoothing: 1 }, lowpass: { cutoff: 3400 }, distortion: { scale: 1.3 } }
}

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/**
 * A node with an owner key set answers 401 to everything under `/owner`. The
 * console asks for the key once and keeps it in sessionStorage; the script
 * takes it from `LIVY_OWNER_KEY` instead, or reads `<data>/owner.key` when
 * `LIVY_DATA_DIR` points at the node's data directory.
 */
const OWNER_KEY = process.env.LIVY_OWNER_KEY ?? (process.env.LIVY_DATA_DIR
  ? await Bun.file(`${process.env.LIVY_DATA_DIR}/data/owner.key`).text().catch(() => '')
  : '')
const authHeaders = OWNER_KEY ? { 'x-owner-key': OWNER_KEY.trim() } : {}

async function get(path, options: any = {}) {
  const headers = { ...(options.headers ?? {}), ...(path.startsWith('/api/v1/owner') ? authHeaders : {}) }
  const res = await fetch(`${base}${path}`, { cache: 'no-store', ...options, headers })
  return res
}

async function json(path: string, options: any = {}) {
  const res = await get(path, options)
  const text = await res.text()
  try {
    return { res, body: JSON.parse(text) }
  } catch {
    return { res, body: null, text }
  }
}

// 1. The node answers, and it is this node.
{
  const { res, body } = await json('/api/v1/info')
  record('node answers /api/v1/info', res.ok && body?.name === 'livy', `status ${res.status}, name ${body?.name}`)
}

// 2. Every console route is served, and its bundle is really there.
let bundleChecked = false
for (const [path, heading] of ROUTES) {
  const res = await get(path)
  const html = res.ok ? await res.text() : ''
  const hasShell = html.includes('_next/static') && html.length > 500
  const headingOk = !heading || html.includes(heading.replace(/&/g, '&amp;'))
  record(
    `route ${path}`,
    res.ok && hasShell,
    `status ${res.status}, ${html.length} bytes${headingOk ? '' : `, missing "${heading}"`}`
  )

  if (!bundleChecked && hasShell) {
    const script = html.match(/src="(\/_next\/static\/[^"]+\.js)"/)?.[1]
    if (script) {
      const js = await get(script)
      record('console bundle is served', js.ok, `${script} → ${js.status}`)
      bundleChecked = true
    }
  }
}

// 3. The pages' data endpoints.
{
  const { res, body } = await json('/api/v1/stations')
  const stations = body?.stations ?? body ?? []
  record('stations list', res.ok && Array.isArray(stations), `${stations.length} station(s)`)

  const station = stations[0]
  if (!station) {
    record('station-scoped checks', false, 'the node has no station')
  } else {
    const seams = await json(`/api/v1/owner/stations/${station.id}/seams`)
    record('seams endpoint', seams.res.ok, `status ${seams.res.status}`)

    const forever = await json(`/api/v1/owner/stations/${station.id}/forever`)
    record('forever endpoint', forever.res.ok, `status ${forever.res.status}`)

    // 4. Every payload the rack can send, one at a time, then cleared.
    for (const [name, payload] of Object.entries(RACK)) {
      const set = await json(`/api/v1/owner/stations/${station.id}/filters`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [name]: payload })
      })
      const active = set.body?.active ?? []
      const unknown = set.body?.unknown ?? []
      record(`rack ${name}`, set.res.ok && active.includes(name) && unknown.length === 0, `active [${active.join(', ')}]`)
      await get(`/api/v1/owner/stations/${station.id}/filters`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    }

    for (const [name, payload] of Object.entries(PRESETS)) {
      const set = await json(`/api/v1/owner/stations/${station.id}/filters`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const active = set.body?.active ?? []
      record(`preset ${name}`, set.res.ok && active.length > 0, `active [${active.join(', ')}]`)
      await get(`/api/v1/owner/stations/${station.id}/filters`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    }
  }
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) process.exit(1)

export {}
