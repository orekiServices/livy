/**
 * Nodecast HTTP surface (node:http, no framework): the REST API, the MP3
 * broadcast endpoint and the static web console — one port, one origin.
 *
 * Responses are built from explicit projections (`publicTrack`), so upstream
 * media URLs, local file paths and anything else internal stay on the server.
 *
 *   GET    /health
 *   GET    /api/v1/info | /stats
 *   GET    /api/v1/search?q=&limit=
 *   GET    /api/v1/resolve?q=
 *   GET    /api/v1/stations                     (?queue=1 to include queues)
 *   POST   /api/v1/stations                     (auth)
 *   GET    /api/v1/stations/:id
 *   PATCH  /api/v1/stations/:id                 (auth)
 *   DELETE /api/v1/stations/:id                 (auth)
 *   GET    /api/v1/stations/:id/queue | /history | /nowplaying
 *   POST   /api/v1/stations/:id/queue           (auth) { query | track, position }
 *   DELETE /api/v1/stations/:id/queue/:index    (auth)
 *   POST   /api/v1/stations/:id/skip|shuffle|start|stop|reload  (auth)
 *   GET    /stream/:id                          continuous MP3 (+ICY metadata)
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { buildIcyMetadataBlock } from '../util/icyClient.js'
import { resolveStaticFile, sendFile } from '../util/files.js'
import { paths } from '../config.js'
import { createOwnerRouter, isOwner, ownerKey } from './owner.js'
import { StreamErrorVoice, failStream } from './streamErrors.js'
import { LANGUAGES } from '../tts/index.js'
import Lyrics from '../core/lyrics.js'
import { publicTrack } from '../core/station.js'
import createLogger from '../util/logger.js'
import { EFFECTS } from '../core/automix.js'

const log = createLogger('http')
const VERSION = createRequire(import.meta.url)('../../package.json').version
const startedAt = Date.now()

/** Fold a display string down to something safe for an HTTP header value. */
const asciiHeader = (value) =>
  String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()


/** Never hand an internal detail (path, host, stack) to a browser. */
const SAFE_ERROR = /^[\w .,'"()\-+:;!?\/]{0,160}$/
const publicMessage = (error) => {
  const message = String(error?.message ?? '')
  if (!message || /[\\/](home|users|var|etc|node_modules)[\\/]/i.test(message) || !SAFE_ERROR.test(message)) return 'Request failed'
  return message
}

export function createRequestHandler({ manager, config, sources, store = null, tts = null, plugins = null }) {
  // A config assembled by hand (tests, embedders) may not carry every key.
  // A missing one must never turn into `Invalid value "undefined" for header`.
  const cors = config.server?.cors ?? '*'

  const send = (res, status, body, headers = {}) => {
    const isJson = typeof body === 'object' && !Buffer.isBuffer(body)
    const payload = isJson ? JSON.stringify(body) : body
    res.writeHead(status, {
      'content-type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'access-control-allow-origin': cors,
      'cache-control': 'no-store',
      ...headers
    })
    res.end(payload)
  }

  const fail = (res, status, message) => send(res, status, { error: true, status, message })

  const authorized = (req, url) => {
    // One credential rules them all. When a key exists it is *required* —
    // presenting none used to fall through to the empty legacy password and
    // quietly open protected routes. `ownerKey()` already falls back to
    // `server.password`, so a node configured the old way still works.
    const key = ownerKey(config)
    if (key) return isOwner(req, config, url)
    return true // open mode: no key, no password — a laptop, not the internet
  }

  /** Stable-ish identity for rate limiting: forwarded IP + chosen name. */
  const requesterId = (req, body = {}) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown'
    return createHash('sha1').update(`${ip}|${body.by ?? ''}`).digest('hex').slice(0, 12)
  }

  const readJson = (req, limit = 1 << 20) =>
    new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size > limit) return req.destroy(new Error('Body too large'))
        chunks.push(c)
      })
      req.on('end', () => {
        if (!chunks.length) return resolve({})
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          // A malformed body is the caller's mistake, not a server fault.
          reject(Object.assign(new Error(`Invalid JSON: ${error.message}`), { status: 400 }))
        }
      })
      req.on('error', reject)
    })

  /* ---------------------------- MP3 broadcast --------------------------- */

  function handleStream(req, res, station, speak) {
    const wantsMeta = String(req.headers['icy-metadata'] ?? '') === '1'
    const metaint = config.relay.metaint
    const remote = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.socket.remoteAddress

    // A station that exists but is not broadcasting, a listener who has been
    // banned, a node at capacity: all of them get told, out loud, instead of
    // being handed an empty socket to stare at.
    if (store?.isBanned?.(remote)) return speak('banned', { station: station.name, stationId: station.id })
    // 'idle' is a station that has never been started; 'stopped' is one the
    // owner switched off; 'error' is one that gave up. None of them can be
    // listened to, and a socket that dribbles silence explains nothing.
    if (['idle', 'stopped', 'error'].includes(station.state)) {
      return speak('off-air', { station: station.name, stationId: station.id })
    }
    if (station.subscribers.size >= (station.options.maxListeners ?? Infinity)) {
      return speak('full', { station: station.name, stationId: station.id })
    }

    const headers = {
      'content-type': 'audio/mpeg',
      'access-control-allow-origin': cors,
      'cache-control': 'no-cache, no-store',
      connection: 'close',
      // HTTP headers are latin-1: em dashes & emoji in station text would 500.
      'icy-name': asciiHeader(station.name),
      'icy-genre': asciiHeader(station.genre ?? ''),
      'icy-description': asciiHeader(station.description ?? ''),
      'icy-br': '128',
      'icy-pub': '0',
      // The URL ends in .mp3 and so does the filename: players that save a
      // stream, and the handful that sniff the extension, both behave.
      'content-disposition': `inline; filename="${asciiHeader(station.id)}.mp3"`,
      // A live broadcast has no length and no seeking: say so, or players
      // will try byte ranges and some proxies will try to cache it.
      'accept-ranges': 'none'
    }
    if (wantsMeta) headers['icy-metaint'] = String(metaint)

    res.writeHead(200, headers)
    if (req.method === 'HEAD') return res.end()

    let source
    try {
      source = station.subscribe({ label: `http:${remote}` })
    } catch (error) {
      // Only now do we know it cannot be served, and the headers are gone.
      log.warn(`could not subscribe a listener to ${station.id}: ${error.message}`)
      return res.end()
    }
    log.info(`listener → ${station.id} (${remote}${wantsMeta ? ', icy' : ''})`)

    if (!wantsMeta) {
      source.pipe(res)
      res.on('close', () => source.destroy())
      return
    }

    let counter = 0
    let lastTitle = null
    const titleOf = () => station.nowPlaying()?.title ?? station.name

    source.on('data', (chunk) => {
      let offset = 0
      while (offset < chunk.length) {
        const take = Math.min(metaint - counter, chunk.length - offset)
        res.write(chunk.subarray(offset, offset + take))
        offset += take
        counter += take
        if (counter === metaint) {
          counter = 0
          const title = titleOf()
          if (title !== lastTitle) {
            res.write(buildIcyMetadataBlock(title))
            lastTitle = title
          } else res.write(Buffer.from([0]))
        }
      }
    })

    res.on('close', () => source.destroy())
  }

  /* ------------------------------- statics ------------------------------ */

  // The web console is a static export (web/out). Serving it from this same
  // process means one port, one origin, no CORS and no second runtime — and
  // the browser never learns that an "API host" exists at all.
  const webRoots = [config.web?.enabled === false ? null : config.web?.dir, paths.public].filter(Boolean)

  function serveStatic(res, urlPath) {
    for (const root of webRoots) {
      const file = resolveStaticFile(root, urlPath)
      if (file) return sendFile(res, file)
    }
    return false
  }

  /** Single-page fallback so /owner and /station?id=… survive a hard refresh. */
  function serveApp(res) {
    for (const root of webRoots) {
      const index = resolveStaticFile(root, '/')
      if (index) return sendFile(res, index, { headers: { 'cache-control': 'no-cache' } })
    }
    return false
  }

  // What a listener hears when a stream cannot be served (see streamErrors.js).
  const streamErrors = new StreamErrorVoice({ tts, store, settings: config.streamErrors })
  // Words for what is on air. Fetched here, never by the listener's browser.
  const lyrics = new Lyrics({ store, ...(config.lyrics ?? {}) })
  const ownerRoutes = createOwnerRouter({ manager, config, sources, store, tts, plugins, streamErrors })

  /* -------------------------------- router ------------------------------ */

  return async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    const seg = url.pathname.split('/').filter(Boolean)
    const method = req.method.toUpperCase()

    if (method === 'OPTIONS') {
      return send(res, 204, '', {
        'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type,icy-metadata,x-owner-key'
      })
    }

    try {
      if (url.pathname === '/health') return send(res, 200, { status: 'ok', uptime: Date.now() - startedAt, ...manager.stats() })

      // `/stream/<id>.mp3` is the *only* stream address. Not `/stream/<id>`,
      // not `.m3u`, not `.pls`: one canonical URL means one thing to cache,
      // one thing to log and one thing to get right. Everything else under
      // /stream is a 404 — and because the caller is usually a media player
      // rather than a browser, the 404 is spoken (see streamErrors.js).
      if (seg[0] === 'stream') {
        const raw = seg[1] ? decodeURIComponent(seg[1]) : ''
        const speak = (reason, extra = {}) =>
          failStream(req, res, { voice: streamErrors, reason, node: config.name ?? 'this node', cors, ...extra })

        if (seg.length !== 2 || !raw.toLowerCase().endsWith('.mp3')) {
          log.debug(`not a stream address: ${url.pathname}`)
          return speak('not-a-stream', { stationId: raw || null })
        }

        const id = raw.slice(0, -4)
        const station = manager.find(id)
        if (!station) {
          log.debug(`unknown station requested: ${id}`)
          return speak('unknown-station', { stationId: id, station: id })
        }
        return handleStream(req, res, station, speak)
      }

      if (seg[0] === 'api' && seg[1] === 'v1') {
        const [, , resource, id, action, param] = seg

        // Everything an owner can do lives behind one key (see server/owner.js).
        if (resource === 'owner') {
          return await ownerRoutes({ req, res, url, seg, method, send, fail, readJson })
        }

        // Plugin endpoints live under /api/v1/x/<plugin>/… so they can never
        // collide with (or shadow) a core route.
        if (resource === 'x') {
          if (plugins && (await plugins.handle({ req, res, url, method, send, fail, readJson }))) return
          return fail(res, 404, 'No such plugin endpoint')
        }

        // What the node can say, and in which languages — a console builds
        // its language picker from this, with no owner key needed.
        // Words for whatever is on air, with the position to sync them to.
        // The console hands `lrc` straight to <am-lyrics>; a player that
        // renders its own can use `lines`.
        if (resource === 'lyrics' && method === 'GET') {
          const stationId = url.searchParams.get('station')
          const station = stationId ? manager.find(stationId) : null
          if (stationId && !station) return fail(res, 404, `Unknown station "${stationId}"`)

          const playing = station?.nowPlaying() ?? null
          const track = station
            ? playing?.track
            : {
                artist: url.searchParams.get('artist') ?? '',
                title: url.searchParams.get('title') ?? '',
                album: url.searchParams.get('album') ?? undefined,
                duration: Number(url.searchParams.get('duration')) || undefined
              }

          if (!track?.title) {
            return send(res, 200, { found: false, reason: 'nothing on air', station: station?.id ?? null, positionMs: 0 })
          }

          const found = await lyrics.find(track)
          return send(res, 200, {
            ...found,
            // Where the station is in the song right now, so the client can
            // start its own clock from here and interpolate.
            positionMs: playing?.positionMs ?? 0,
            serverTime: Date.now(),
            track: playing?.track ?? { artist: track.artist, title: track.title },
            station: station?.id ?? null
          })
        }

        if (resource === 'tts' && method === 'GET') {
          return send(res, 200, {
            enabled: Boolean(tts),
            language: tts?.language ?? config.tts?.language ?? 'en',
            // The catalogue is knowledge, not a capability: a node with TTS
            // switched off still knows which languages it would speak, and a
            // console can show the picker either way.
            languages: tts?.languages ?? LANGUAGES,
            spokenErrors: streamErrors.settings.enabled,
            errorLanguages: streamErrors.languages
          })
        }

        if (resource === 'info') {
          return send(res, 200, {
            name: 'nodecast',
            version: VERSION,
            uptime: Date.now() - startedAt,
            sources: sources.sources.map((s) => s.name),
            defaultSearch: sources.defaultSearch,
            transitions: [...EFFECTS],
            stations: manager.size,
            language: tts?.language ?? config.tts?.language ?? 'en',
            // First run: the console shows the setup flow instead of an empty grid.
            setup: { needed: manager.size === 0, protected: Boolean(ownerKey(config)) }
          })
        }

        if (resource === 'stats') {
          const mem = process.memoryUsage()
          return send(res, 200, {
            uptime: Date.now() - startedAt,
            rssMb: +(mem.rss / 1048576).toFixed(1),
            heapMb: +(mem.heapUsed / 1048576).toFixed(1),
            ...manager.stats()
          })
        }

        // What a brand-new install needs to know, and nothing else: no paths,
        // no environment, no upstream URLs.
        if (resource === 'setup' && method === 'GET') {
          return send(res, 200, {
            configured: manager.size > 0,
            stations: manager.size,
            protected: Boolean(ownerKey(config)),
            owner: isOwner(req, config, url) && Boolean(ownerKey(config)),
            sources: sources.sources.map((s) => ({ name: s.name, prefixes: s.prefixes ?? [] })),
            transitions: [...EFFECTS],
            defaults: {
              crossfadeMs: config.stationDefaults?.automix?.crossfadeMs ?? 6000,
              effect: config.stationDefaults?.automix?.effect ?? 'crossfade',
              beatmatch: config.stationDefaults?.automix?.beatmatch !== false,
              dj: config.stationDefaults?.automix?.dj?.enabled !== false
            }
          })
        }

        if (resource === 'search' && method === 'GET') {
          const q = url.searchParams.get('q')
          if (!q) return fail(res, 400, 'Missing ?q=')
          const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 50)
          // `?provider=` is what the console sends; `?source=` was the
          // original spelling and still works.
          const provider = url.searchParams.get('provider') ?? url.searchParams.get('source') ?? 'all'
          const found = await sources.search(q, limit, provider)
          // Search results keep their playable handle (id + source) but not
          // the upstream media URL the node resolved.
          return send(res, 200, { query: q, source: provider, tracks: found.map(publicTrack) })
        }

        if (resource === 'sources' && method === 'GET') {
          return send(res, 200, {
            sources: sources.sources.map((s) => ({ name: s.name, prefixes: s.prefixes ?? [], hiRes: s.hiRes === true })),
            hiRes: { enabled: sources.hiRes, minKbps: sources.hiResMinKbps },
            fallbackOrder: sources.fallbackOrder,
            liveFallback: sources.liveFallback
          })
        }

        if (resource === 'resolve' && method === 'GET') {
          const q = url.searchParams.get('q')
          if (!q) return fail(res, 400, 'Missing ?q=')
          const resolved = await sources.resolve(q)
          return send(res, 200, { ...resolved, tracks: resolved.tracks.map(publicTrack) })
        }

        if (resource === 'stations') {
          if (!id) {
            if (method === 'GET') return send(res, 200, { stations: manager.list({ queue: url.searchParams.has('queue') }) })
            if (method === 'POST') {
              if (!authorized(req, url)) return fail(res, 401, 'Unauthorized')
              const body = await readJson(req)
              const station = manager.add(body)
              if (body.autoStart !== false) {
                station.load().then(() => station.start()).catch((e) => log.warn(e.message))
              }
              return send(res, 201, station.info())
            }
            return fail(res, 405, 'Method not allowed')
          }

          const station = manager.find(decodeURIComponent(id))
          if (!station) return fail(res, 404, `Unknown station "${id}"`)

          if (!action) {
            if (method === 'GET') return send(res, 200, station.info({ queue: url.searchParams.has('queue') }))
            if (method === 'PATCH') {
              if (!authorized(req, url)) return fail(res, 401, 'Unauthorized')
              return send(res, 200, manager.update(station.id, await readJson(req)).info())
            }
            if (method === 'DELETE') {
              if (!authorized(req, url)) return fail(res, 401, 'Unauthorized')
              manager.remove(station.id)
              return send(res, 200, { removed: station.id })
            }
            return fail(res, 405, 'Method not allowed')
          }

          if (action === 'nowplaying' && method === 'GET') return send(res, 200, station.nowPlaying() ?? {})

          /* ----- listener requests: open to everyone ----- */
          if (action === 'requests' && method === 'GET') {
            return send(res, 200, {
              allowRequests: station.options.allowRequests === true,
              requests: station.publicRequests(),
              voteSkips: station.info().voteSkips
            })
          }

          if (action === 'request' && method === 'POST') {
            const body = await readJson(req)
            try {
              const result = await station.request({
                query: body.query,
                track: body.track,
                by: body.by ?? 'anonymous',
                requesterId: body.requesterId ?? requesterId(req, body)
              })
              return send(res, 200, result)
            } catch (error) {
              return fail(res, error.status ?? 400, error.message)
            }
          }

          if (action === 'requests' && param && seg[6] === 'vote' && method === 'POST') {
            const body = await readJson(req)
            try {
              return send(res, 200, station.voteRequest(param, body.voter ?? requesterId(req, body)))
            } catch (error) {
              return fail(res, error.status ?? 400, error.message)
            }
          }

          if (action === 'requests' && param && method === 'DELETE') {
            if (!authorized(req, url)) return fail(res, 401, 'Unauthorized')
            const removed = station.removeRequest(param)
            return removed ? send(res, 200, { removed }) : fail(res, 404, 'No such request')
          }

          if (action === 'voteskip' && method === 'POST') {
            const body = await readJson(req)
            try {
              return send(res, 200, station.voteSkip(body.voter ?? requesterId(req, body)))
            } catch (error) {
              return fail(res, error.status ?? 400, error.message)
            }
          }
          if (action === 'history' && method === 'GET') return send(res, 200, { history: station.history.map(publicTrack) })

          if (action === 'queue') {
            if (method === 'GET') return send(res, 200, { queue: station.queue.map(publicTrack), length: station.queue.length })
            if (!authorized(req, url)) return fail(res, 401, 'Unauthorized')

            if (method === 'POST') {
              const body = await readJson(req)
              let tracks = body.track ? [body.track] : body.tracks
              if (!tracks) {
                if (!body.query) return fail(res, 400, 'Provide "query", "track" or "tracks"')
                const resolved = await sources.resolve(body.query, { limit: body.limit ?? 50 })
                tracks = resolved.tracks
              }
              if (!tracks?.length) return fail(res, 404, 'Nothing found for that query')
              station.enqueue(tracks, { position: body.next ? 0 : -1 })
              if (station.state === 'idle') station.start()
              return send(res, 200, { added: tracks.length, tracks: tracks.map(publicTrack), queueLength: station.queue.length })
            }

            if (method === 'DELETE') {
              if (param == null) {
                station.clearQueue()
                return send(res, 200, { cleared: true })
              }
              const removed = station.removeAt(Number(param))
              return removed ? send(res, 200, { removed }) : fail(res, 404, 'No such queue index')
            }
          }

          if (method === 'POST') {
            if (!authorized(req, url)) return fail(res, 401, 'Unauthorized')
            if (action === 'skip') {
              station.skip()
              return send(res, 200, { skipped: true })
            }
            if (action === 'shuffle') {
              station.shuffle()
              return send(res, 200, { shuffled: station.queue.length })
            }
            if (action === 'start') {
              await station.load()
              await station.start()
              return send(res, 200, station.info())
            }
            if (action === 'stop') {
              station.stop('api')
              return send(res, 200, station.info())
            }
            if (action === 'reload') {
              station.clearQueue()
              await station.load(true)
              return send(res, 200, { queueLength: station.queue.length })
            }
          }

          return fail(res, 404, 'Unknown station action')
        }

        return fail(res, 404, 'Unknown API route')
      }

      // The web app is a plugin: plugin mounts are consulted first, and the
      // node's own `public/` is only a fallback for installs that keep one.
      if ((method === 'GET' || method === 'HEAD') && plugins?.serve({ req, res, url })) return
      if (method === 'GET' && serveStatic(res, url.pathname)) return
      if (method === 'GET' && !url.pathname.startsWith('/api/') && serveApp(res)) return
      return fail(res, 404, 'Not found')
    } catch (error) {
      // Bad input is answered as bad input; anything else is ours to own.
      const status = Number(error.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 500
      if (status >= 500) log.error(error) // the detail stays in the log …
      else log.debug(`${status}: ${error.message}`)
      if (!res.headersSent) return fail(res, status, status >= 500 ? publicMessage(error) : error.message) // … not in the response
      res.destroy()
    }
  }
}

export default createRequestHandler
