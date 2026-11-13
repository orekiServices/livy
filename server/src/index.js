#!/usr/bin/env node
/**
 * Livy — Node.js + Icecast-style multi-station MP3 radio, in one process.
 *
 * Boot order: config → logging → owner key → SQLite (migrated) → speech →
 * sources → stations → plugins → HTTP + WebSocket + the web console, all on
 * one port. No transcoding, no Java, no external media tools.
 */
import http from 'node:http'
import { createRequire } from 'node:module'

import { loadConfig, ensureOwnerKey, paths, deepMerge, isServerless } from './config.js'
import SourceRegistry from './sources/index.js'
import StationManager from './core/stationManager.js'
import PluginHost from './core/plugins.js'
import Store from './store/index.js'
import TtsEngine from './tts/index.js'
import createRequestHandler from './server/rest.js'
import Gateway from './server/gateway.js'
import createLogger, { configureLogging, banner } from './util/logger.js'
import Memory from './core/memory.js'
import SmartQueue from './core/smartQueue.js'
import { engineInfo } from './util/metro.js'
import { hostInfo } from './util/platform.js'
import { fxEngine, fxInfo } from './util/fx.js'
import { AutoTrainer, configureModels } from './core/models/index.js'
import { prepareOwnerAuth } from './server/owner/password.js'

const log = createLogger('livy')
const VERSION = createRequire(import.meta.url)('../package.json').version

export async function createRadioServer(overrides = {}) {
  // Deep, not shallow: `createRadioServer({ server: { port: 0 } })` must keep
  // the rest of the server block (cors, password…) rather than replacing it.
  const config = deepMerge(loadConfig(), overrides)
  configureLogging(config.logging)

  // One credential unlocks the owner console. A password may come from the
  // environment or from a previous first-run setup; otherwise a key is
  // generated once and printed. Never both by accident.
  const auth = prepareOwnerAuth(config)
  if (auth.problem) log.warn(`the owner credential from the environment was ignored: ${auth.problem}`)
  if (auth.fromEnv) log.info('owner credential loaded from the environment')
  if (auth.configured && !auth.persisted) log.warn('the owner credential is valid for this process only (data folder is not writable)')
  const owner = ensureOwnerKey(config)
  if (!owner.key && !auth.configured) log.warn('no owner credential configured — the console is open to anyone who can reach it')
  if (owner.created) log.info(`owner key generated: ${owner.key}  (saved next to the database — keep it)`)

  // Persistence: SQLite, migrated to the current schema on open.
  //
  // In a serverless function there is nowhere durable to put the file, and a
  // store that silently forgets every request is worse than no store: the
  // in-memory driver below says so out loud in `/api/v1/info` instead. Set
  // LIVY_STORE=lazy to attempt a real file anyway (a mounted volume), or
  // LIVY_DATA_DIR to give it somewhere to live.
  const platform = isServerless()
  const store =
    config.store?.enabled === false
      ? null
      : await Store.open(config.store?.file ?? `${paths.data}/livy.db`, {
          migrate: config.store?.migrate !== false,
          // Nothing durable exists on a serverless host unless the operator
          // mounted one; `Store.open` then falls back to a memory driver.
          memory: platform && !process.env.LIVY_DATA_DIR
        }).catch((error) => {
          log.warn(`store unavailable (${error.message}); running without persistence`)
          return null
        })

  // The learned automix policy: settings are read from config and the store,
  // then the background trainer is created once there is a manager to watch.
  configureModels({ config, store })

  // Speech: station idents, owner announcements, the DJ.
  const tts =
    config.tts?.enabled === false
      ? null
      : new TtsEngine({ cacheDir: config.tts?.cacheDir ?? paths.tts, provider: config.tts?.provider, language: config.tts?.language })

  const sources = new SourceRegistry(config.sources ?? {}, { tts })
  // What the node remembers across a restart (see core/memory.js) and what
  // it plays when the rotation runs dry (core/smartQueue.js). Both are
  // optional and both degrade to "as before" when switched off.
  const memory = new Memory({ store, ...(config.memory ?? {}) })
  const smartQueue = new SmartQueue({ sources, memory, store, options: config.smartQueue ?? {} })

  const manager = new StationManager({ defaults: config.stationDefaults, sources, store, tts, memory, smartQueue })

  // Trains while stations play: a cheap poll for new seams, a fast multi-run
  // in the event-loop gaps, and the winner swapped in at the next seam.
  const autoTrainer = new AutoTrainer({ manager, store, config })

  // Plugins extend the node before any station goes on air, so a plugin can
  // contribute a source or a transition that a station is configured to use.
  const plugins =
    config.plugins?.enabled === false
      ? null
      : new PluginHost({ dir: config.plugins?.dir ?? paths.plugins, manager, sources, store, config, version: VERSION, tts })
  if (plugins) await plugins.loadAll()

  // config.json stations first, then anything the owner created at runtime.
  // A fresh install has neither: Livy comes up empty and the web console
  // walks the owner through creating the first station.
  const owned = store?.listStations() ?? []
  const stationConfigs = [...(config.stations ?? []), ...owned.filter((s) => !(config.stations ?? []).some((c) => c.id === s.id))]

  for (const stationConfig of stationConfigs) {
    try {
      manager.add(stationConfig)
    } catch (error) {
      log.error(`station "${stationConfig.id}" could not start`, error, { station: stationConfig.id })
    }
  }

  // The owner's voice choices outlive a restart: which service, which
  // language, how fast, and whichever voice that service was using.
  if (tts) {
    const savedProvider = store?.get?.('tts.provider')
    const savedLanguage = store?.get?.('tts.language')
    const savedSpeed = store?.get?.('tts.speed')
    const savedProviders = store?.get?.('tts.providers')
    const savedFallback = store?.get?.('tts.fallback')

    try {
      if (savedProvider) tts.setProvider(savedProvider)
    } catch (error) {
      log.warn(`saved voice provider ignored: ${error.message}`)
    }
    if (savedLanguage) tts.setLanguage(savedLanguage)
    if (Number.isFinite(savedSpeed)) tts.speed = savedSpeed
    if (typeof savedFallback === 'boolean') tts.fallback = savedFallback
    for (const [id, settings] of Object.entries(savedProviders ?? {})) {
      try {
        tts.setProviderSettings(id, settings)
      } catch {
        /* a provider that no longer exists */
      }
    }
  }

  const handler = createRequestHandler({ manager, config, sources, store, tts, plugins, autoTrainer, version: VERSION })
  const server = http.createServer(handler)
  // A listener holds its socket open for as long as the browser or the player
  // does — that is the point of an internet radio. On Bun, though, HTTP/1.1
  // keep-alive is honoured more aggressively than on Node, and a socket that
  // is never reaped keeps `close()` from completing. One hour is far longer
  // than any player needs between requests and short enough to be reaped.
  server.keepAliveTimeout = 3_600_000
  server.headersTimeout = 30_000
  server.requestTimeout = 0

  // A serverless function has no socket of its own to upgrade, and no
  // long-lived connection to keep: the platform owns both. `createApp()` is
  // the entry point there, and it never gets here.
  const gateway = new Gateway({ server, manager, config })

  let port = null
  if (!platform) {
    await new Promise((resolve) => server.listen(config.server.port, config.server.host, resolve))
    port = server.address().port
  }

  if (!platform) banner({
    version: VERSION,
    host: config.server.host,
    port,
    stations: manager.size,
    store: store ? `${store.driver} · schema v${store.schemaVersion}` : 'disabled',
    plugins: plugins ? `${plugins.list().filter((p) => p.status === 'ready').length}/${plugins.list().length} active` : 'off',
    // Which relay engine is in play: native libmetro, or the JS fallback.
    engine: engineInfo().describe,
    // MetroFX native filter kernels, or the JavaScript reference path.
    fx: fxEngine === 'native' ? fxInfo().describe : 'javascript (MetroFX not built for this host)',
    // `android` on a Termux node: smaller models, node:sqlite, no GPU probe.
    device: hostInfo().mobile ? `${hostInfo().profile}${hostInfo().termux ? ' (Termux)' : ''} · ${hostInfo().cpus} cores · ${hostInfo().memoryMb} MB` : null
  })
  if (manager.size === 0 && !platform) log.info(`first run: open http://${config.server.host}:${port}/ and create your first station`)

  // Warm up stations in parallel (resolve playlists, then go on air).
  const boot = [...manager.stations.values()]
    .filter((s) => s.options.autoStart !== false)
    .map((station) =>
      station
        .load()
        // Memory comes *after* the playlist so a resumed track goes to the
        // front of a queue that already exists.
        .then(() => station.resumeFromMemory())
        .then(() => station.start())
        .catch((error) => log.warn(`station ${station.id} did not start: ${error.message}`, { station: station.id }))
    )
  Promise.allSettled(boot).then(() => log.info('all stations on air'))
  if (!platform) autoTrainer.start()

  const close = async () => {
    // Write everything down before the lights go out — this is what makes
    // the next boot pick up mid-song.
    for (const station of manager.stations.values()) memory.save(station, { force: true })
    autoTrainer.stop()
    gateway.close()
    await plugins?.close()
    manager.stopAll()
    store?.close()

    // `keepAliveTimeout = 0` is deliberate on a long-running node: a player
    // holds one connection for hours. It also means `server.close()` will
    // never call back while any keep-alive socket is still open — on Node the
    // process exits and nobody notices, under Bun (or a test runner that
    // waits) shutdown hangs forever. Drop the idle sockets first.
    await new Promise((resolve) => {
      const done = () => resolve()
      server.close(done)
      // Sockets that are mid-request get `closeAllConnections` once the
      // response is flushed; idle ones are dropped immediately.
      server.closeIdleConnections?.()
      const timer = setTimeout(() => {
        server.closeAllConnections?.()
        resolve()
      }, 1000)
      timer.unref?.()
    })
  }

  return { config, manager, sources, store, tts, plugins, memory, smartQueue, autoTrainer, server, gateway, close, port, version: VERSION }
}

/**
 * A boot-once, handle-once entry point for a serverless platform.
 *
 * A Vercel Function is not a server: it receives one request, runs it to
 * completion, and may be frozen or destroyed afterwards. Three things follow,
 * and they are the whole difference from `createRadioServer`:
 *
 *   1. **No `listen`.** The platform hands us `(req, res)`; there is no socket
 *      of our own to bind.
 *   2. **No WebSocket gateway.** An upgrade in a function is meaningless —
 *      there is no long-lived connection — so the REST surface is what exists.
 *      `/api/v1/events` therefore answers 501 with an explanation instead of
 *      hanging.
 *   3. **No audio pacer.** A station's pacer is a `setTimeout` loop that
 *      expects to run forever. In a function it never gets the chance, so
 *      continuous ICY streaming is *not* available on Vercel (that is a
 *      platform limit, not a bug: no long-lived TCP). What is available is
 *      everything that fits in a request: the console, search, resolution,
 *      metadata, queue management, and the automix/filter *rendering*, which
 *      is CPU work with a beginning and an end.
 *
 * The instance is cached in module scope, because a warm function reuses it
 * and a cold one rebuilds it. That is the same lifecycle Vercel documents for
 * database clients.
 */
let appPromise = null

export function createApp(overrides = {}) {
  appPromise ??= (async () => {
    const config = deepMerge(loadConfig(), overrides)
    configureLogging(config.logging)
    const auth = prepareOwnerAuth(config)
    if (auth.problem) log.warn(`the owner credential from the environment was ignored: ${auth.problem}`)
    const owner = ensureOwnerKey(config)

    const store =
      config.store?.enabled === false
        ? null
        : await Store.open(config.store?.file ?? `${paths.data}/livy.db`, {
            migrate: config.store?.migrate !== false,
            memory: !process.env.LIVY_DATA_DIR
          }).catch((error) => {
            log.warn(`store unavailable (${error.message}); continuing without persistence`)
            return null
          })

    const tts =
      config.tts?.enabled === false
        ? null
        : new TtsEngine({ cacheDir: config.tts?.cacheDir ?? paths.tts, provider: config.tts?.provider, language: config.tts?.language })
    const sources = new SourceRegistry(config.sources ?? {}, { tts })
    const memory = new Memory({ store, ...(config.memory ?? {}) })
    const smartQueue = new SmartQueue({ sources, memory, store, options: config.smartQueue ?? {} })
    const manager = new StationManager({ defaults: config.stationDefaults, sources, store, tts, memory, smartQueue })

  // Trains while stations play: a cheap poll for new seams, a fast multi-run
  // in the event-loop gaps, and the winner swapped in at the next seam.
  const autoTrainer = new AutoTrainer({ manager, store, config })

    const plugins =
      config.plugins?.enabled === false
        ? null
        : new PluginHost({ dir: config.plugins?.dir ?? paths.plugins, manager, sources, store, config, version: VERSION, tts })
    if (plugins) {
      // A plugin is allowed to write next to itself; on a serverless host
      // nothing can. `LIVY_PLUGINS` picks the survivors (the console, which
      // only reads, is the one that matters), and a plugin that cannot write
      // is skipped rather than allowed to fail every request.
      const allow = process.env.LIVY_PLUGINS ? new Set(process.env.LIVY_PLUGINS.split(',').map((name) => name.trim()).filter(Boolean)) : null
      await plugins.loadAll(allow ? { only: [...allow] } : {})
    }

    for (const stationConfig of [...(config.stations ?? []), ...(store?.listStations() ?? [])]) {
      if (manager.get?.(stationConfig.id)) continue
      try {
        manager.add(stationConfig)
      } catch (error) {
        log.warn(`station "${stationConfig.id}" could not start: ${error.message}`)
      }
    }

    const handler = createRequestHandler({ manager, config, sources, store, tts, plugins, autoTrainer, version: VERSION })

    log.info(`serverless app ready · ${manager.size} station(s) · store ${store ? store.driver : 'off'} · writable ${paths.writable}`)
    if (owner.created) log.warn('owner key generated for this instance only — set OWNER_KEY in the environment')

    return { config, manager, sources, store, tts, plugins, memory, smartQueue, handler, version: VERSION }
  })()
  return appPromise
}

/**
 * The request handler itself: what `api/index.js` exports as the function.
 *
 * Deliberately never throws: a boot failure in a serverless function becomes a
 * 500 that says why, and the next request retries the boot instead of caching
 * the failure forever.
 */
export async function handleRequest(req, res) {
  try {
    const app = await createApp()
    return app.handler(req, res)
  } catch (error) {
    appPromise = null
    log.error('serverless boot failed', error instanceof Error ? error : new Error(String(error)))
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
    }
    res.end(JSON.stringify({ error: 'boot_failed', message: error.message }))
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const instance = await createRadioServer()
  let closing = false
  const shutdown = async (signal) => {
    if (closing) return
    closing = true
    log.info(`received ${signal}, shutting down`)
    await instance.close()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('unhandledRejection', (error) => log.error('unhandled rejection', error instanceof Error ? error : new Error(String(error))))
  process.on('uncaughtException', (error) => log.fatal('uncaught exception', error))
}

export { StationManager, SourceRegistry, PluginHost, Store }
export { Station } from './core/station.js'
export default createRadioServer
