#!/usr/bin/env node
/**
 * Nodecast — Node.js + Icecast-style multi-station MP3 radio, in one process.
 *
 * Boot order: config → logging → owner key → SQLite (migrated) → speech →
 * sources → stations → plugins → HTTP + WebSocket + the web console, all on
 * one port. No transcoding, no Java, no external media tools.
 */
import http from 'node:http'
import { createRequire } from 'node:module'

import { loadConfig, ensureOwnerKey, paths, deepMerge } from './config.js'
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

const log = createLogger('nodecast')
const VERSION = createRequire(import.meta.url)('../package.json').version

export async function createRadioServer(overrides = {}) {
  // Deep, not shallow: `createRadioServer({ server: { port: 0 } })` must keep
  // the rest of the server block (cors, password…) rather than replacing it.
  const config = deepMerge(loadConfig(), overrides)
  configureLogging(config.logging)

  // One key unlocks the owner console. Generated once on a fresh install.
  const owner = ensureOwnerKey(config)
  if (owner.created) log.info(`owner key generated: ${owner.key}  (saved next to the database — keep it)`)

  // Persistence: SQLite, migrated to the current schema on open.
  const store =
    config.store?.enabled === false
      ? null
      : await Store.open(config.store?.file ?? `${paths.data}/nodecast.db`, { migrate: config.store?.migrate !== false })

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

  // Plugins extend the node before any station goes on air, so a plugin can
  // contribute a source or a transition that a station is configured to use.
  const plugins =
    config.plugins?.enabled === false
      ? null
      : new PluginHost({ dir: config.plugins?.dir ?? paths.plugins, manager, sources, store, config, version: VERSION, tts })
  if (plugins) await plugins.loadAll()

  // config.json stations first, then anything the owner created at runtime.
  // A fresh install has neither: Nodecast comes up empty and the web console
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

  const server = http.createServer(createRequestHandler({ manager, config, sources, store, tts, plugins, version: VERSION }))
  server.keepAliveTimeout = 0
  server.headersTimeout = 30_000
  server.requestTimeout = 0

  const gateway = new Gateway({ server, manager, config })

  await new Promise((resolve) => server.listen(config.server.port, config.server.host, resolve))
  const { port } = server.address()

  banner({
    version: VERSION,
    host: config.server.host,
    port,
    stations: manager.size,
    store: store ? `${store.driver} · schema v${store.schemaVersion}` : 'disabled',
    plugins: plugins ? `${plugins.list().filter((p) => p.status === 'ready').length}/${plugins.list().length} active` : 'off',
    // Which relay engine is in play: native libmetro, or the JS fallback.
    engine: engineInfo().describe
  })
  if (manager.size === 0) log.info(`first run: open http://${config.server.host}:${port}/ and create your first station`)

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

  const close = async () => {
    // Write everything down before the lights go out — this is what makes
    // the next boot pick up mid-song.
    for (const station of manager.stations.values()) memory.save(station, { force: true })
    gateway.close()
    await plugins?.close()
    manager.stopAll()
    store?.close()
    await new Promise((resolve) => server.close(resolve))
  }

  return { config, manager, sources, store, tts, plugins, memory, smartQueue, server, gateway, close, port, version: VERSION }
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
