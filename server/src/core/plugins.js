/**
 * Plugin host.
 *
 * Everything in `plugins/` is loaded at boot and can extend the node without
 * touching its source: add a music source, add a transition, add an HTTP
 * endpoint, or just listen to what the stations are doing.
 *
 *   plugins/
 *     now-playing/            ← folder plugin
 *       plugin.json           ← { "name": …, "version": …, "main": "index.js" }
 *       index.js
 *     backspin.js             ← single-file plugin
 *
 * A plugin module exports `setup` (or a default function):
 *
 *   export const manifest = { name: 'now-playing', version: '1.0.0' }
 *   export default function setup(ctx) {
 *     ctx.on('track', ({ station, track }) => ctx.log.info(`${station.id}: ${track.title}`))
 *     return () => {}        // optional teardown
 *   }
 *
 * A plugin can also own a slice of the URL space: `registerStatic()` mounts a
 * directory (that is how the web console is shipped — the UI is a plugin, not
 * part of the node) and `registerRoute()` adds JSON endpoints under
 * `/api/v1/x/<plugin>/…`, patterns with `:params` included.
 *
 * Plugins are loaded once per process, but they do not have to apply to every
 * station. A plugin declares a `scope` in its manifest — `stations` (the
 * default: switchable per station) or `global` (the console, say) — and the
 * owner can then switch it on or off **per station**. Scoping is enforced by
 * the host, not by good behaviour: a plugin that is off for a station never
 * sees its events and cannot see it through `ctx.stations`.
 *
 * Guarantees the host gives you:
 *   • a broken plugin never takes the node down — it is marked `error`;
 *   • disabling one removes its sources, effects, routes and listeners;
 *   • enabled/disabled state, per-plugin settings and per-station choices all
 *     live in SQLite;
 *   • plugins get a scoped logger, never the owner key or raw config secrets.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import createLogger from '../util/logger.js'
import { normaliseSchema, defaultsOf, validate as validateSettings, describe as describeSettings } from './pluginSchema.js'
import { resolveStaticFile, sendFile } from '../util/files.js'
import { isOwner } from '../server/owner.js'
import { registerEffect, unregisterEffect, EFFECTS } from './automix.js'

const log = createLogger('plugins')

/**
 * Manifest defaults, then the schema's defaults, then whatever the owner
 * saved — each layer checked against the schema when there is one.
 *
 * Settings that no longer validate (a plugin tightened a range, somebody
 * hand-edited the database) are dropped back to their default and logged
 * rather than carried around as a landmine.
 */
function cleanSettings(schema, manifestSettings, storedSettings, pluginId = '?') {
  const merged = { ...(manifestSettings ?? {}), ...(storedSettings ?? {}) }
  if (schema.length === 0) return merged

  const base = { ...defaultsOf(schema), ...merged }
  const { value, errors } = validateSettings(schema, base, { partial: false })
  for (const problem of errors) {
    log.warn(`plugin \"${pluginId}\" setting ignored — ${problem.message}`)
  }
  return value
}

/** Events a plugin may subscribe to, mapped from the station bus. */
const STATION_EVENTS = ['state', 'track', 'queue', 'listeners', 'requests', 'voteskip', 'announcement', 'automix', 'added', 'removed', 'updated']

const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/i


/**
 * Load a plugin's module, re-reading the file even when it has changed.
 *
 * `import(url + '?v=' + Date.now())` is the usual trick on Node: a distinct
 * URL is a distinct module, so an edit on disk is picked up by `reload()`.
 * Bun does not honour it — it keys its module registry on the *resolved path*
 * and hands back the first copy forever, so a plugin reload silently kept
 * running the old code (and a test that rewrites a plugin and reloads it can
 * never pass there).
 *
 * Reading the file and importing it as text works on both: a `data:` URL for a
 * module with no imports, or a `blob:`-like URL where one has. The general
 * answer is a temporary file next to the original, which keeps relative
 * imports and `import.meta` sane — a plugin directory is the right place for
 * it, and it is removed straight after the import.
 */
async function loadPluginModule(file) {
  const source = await import('node:fs').then((fs) => fs.promises.readFile(file, 'utf8'))
  // No static imports: a data: URL is enough and leaves nothing on disk.
  if (!/^\s*(import|export)\s[^;]*\bfrom\s/m.test(source) && !/\bimport\s*\(/.test(source)) {
    try {
      // A trailing comment on its own line makes the module text unique per
      // load. Both Node and Bun key a `data:` module on its *bytes*, so the
      // same plugin loaded twice in one process (a reload, or a second host in
      // a test) would otherwise share module state — two `seen` objects where
      // the caller expects one.
      const unique = `${source}\n// livy-load:${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}\n`
      return await import(`data:text/javascript;base64,${Buffer.from(unique).toString('base64')}`)
    } catch {
      /* fall through to the temp-file path */
    }
  }

  const { writeFileSync, rmSync } = await import('node:fs')
  const { dirname, basename, join } = await import('node:path')
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.mjs`)
  try {
    writeFileSync(temporary, source)
    return await import(pathToFileURL(temporary).href)
  } finally {
    try {
      rmSync(temporary, { force: true })
    } catch {
      /* a read-only plugin directory: the import already succeeded */
    }
  }
}

export class PluginHost extends EventEmitter {
  /**
   * @param {object} deps
   * @param {string} deps.dir            plugins directory
   * @param {object} deps.manager        StationManager (event bus + control)
   * @param {object} deps.sources        SourceRegistry
   * @param {object} deps.store          Store (plugin state + settings)
   * @param {object} deps.config         full node config (never handed over raw)
   * @param {string} deps.version        node version string
   * @param {object} [deps.tts]
   */
  constructor({ dir, manager, sources, store, config, version, tts = null }) {
    super()
    this.setMaxListeners(0)
    this.dir = dir
    this.manager = manager
    this.sources = sources
    this.store = store
    this.config = config
    this.version = version
    this.tts = tts
    /** @type {Map<string, object>} */
    this.plugins = new Map()
    this.routes = [] // { pluginId, method, path, segments, handler }
    this.mounts = [] // { pluginId, mount, dir, spa, index }

    // One subscription per station event, fanned out to plugin listeners.
    this.#bridge()
  }

  #bridge() {
    if (!this.manager) return
    for (const event of STATION_EVENTS) {
      this.manager.on(event, (station, data) => {
        this.emit(event, { station, data, track: data?.track ?? data })
      })
    }

    // A deleted station takes its per-station plugin choices with it, so a
    // later station reusing the id does not inherit them.
    this.manager.on('removed', (station) => {
      const id = station?.id ?? station
      if (!id) return
      for (const record of this.plugins.values()) {
        if (!record.stations?.[id]) continue
        const { [id]: gone, ...rest } = record.stations
        record.stations = rest
      }
      this.store?.clearStationPlugins?.({ stationId: id })
    })
  }

  /* ----------------------------- discovery ---------------------------- */

  /** Look at the directory and return manifests, without executing anything. */
  discover() {
    if (!this.dir || !fs.existsSync(this.dir)) return []

    const found = []
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue

      if (entry.isDirectory()) {
        const base = path.join(this.dir, entry.name)
        let manifest = {}
        const manifestFile = path.join(base, 'plugin.json')
        if (fs.existsSync(manifestFile)) {
          try {
            manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
          } catch (error) {
            log.warn(`plugin "${entry.name}": plugin.json is not valid JSON (${error.message})`)
            continue
          }
        }
        const main = path.join(base, manifest.main ?? 'index.js')
        if (!fs.existsSync(main)) {
          log.warn(`plugin "${entry.name}": no entry file (${path.relative(this.dir, main)})`)
          continue
        }
        found.push({ id: manifest.id ?? entry.name, dir: base, file: main, manifest })
      } else if (entry.isFile() && /\.(m?js)$/.test(entry.name) && entry.name !== 'README.md') {
        const id = entry.name.replace(/\.m?js$/, '')
        found.push({ id, dir: this.dir, file: path.join(this.dir, entry.name), manifest: {} })
      }
    }

    return found.filter((p) => {
      if (SAFE_ID.test(p.id)) return true
      log.warn(`ignoring plugin with unusable id "${p.id}"`)
      return false
    })
  }

  /* ------------------------------ loading ----------------------------- */

  /** Discover and start every plugin that is not disabled in the database. */
  /**
   * @param {object} [options]
   * @param {string[]} [options.only] load only these ids. A serverless host
   *   cannot let a plugin write to the bundle, so it names the ones that only
   *   read (the console) and skips the rest.
   */
  async loadAll({ only = null } = {}) {
    const allow = Array.isArray(only) ? new Set(only) : null
    const discovered = this.discover().filter((found) => !allow || allow.has(found.id))
    for (const found of discovered) {
      const scope = found.manifest.scope === 'global' ? 'global' : 'stations'
      const state = this.store?.registerPlugin(found.id, found.manifest.version, {
        defaultEnabled: found.manifest.enabled !== false,
        scope
      }) ?? { enabled: found.manifest.enabled !== false, settings: {}, stations: {} }
      const schema = normaliseSchema(found.manifest.settingsSchema)
      const record = {
        id: found.id,
        name: found.manifest.name ?? found.id,
        version: found.manifest.version ?? '0.0.0',
        description: found.manifest.description ?? '',
        author: found.manifest.author ?? null,
        file: found.file,
        dir: found.dir,
        manifest: found.manifest,
        enabled: state.enabled,
        scope,
        stations: state.stations ?? {}, // per-station overrides, by station id
        // A plugin may describe its settings (see core/pluginSchema.js); if
        // it does, everything stored is coerced through that description, so
        // a plugin never has to defend itself against "thirty" where it
        // wanted 30.
        schema,
        settings: cleanSettings(schema, found.manifest.settings, state.settings, found.id),
        status: state.enabled ? 'loading' : 'disabled',
        error: null,
        provides: { sources: [], effects: [], routes: [], static: [], relays: [] },
        listeners: [],
        scopeListeners: [],
        teardown: null,
        loadedAt: null
      }
      this.plugins.set(record.id, record)
      if (state.enabled) await this.#start(record)
    }

    const on = [...this.plugins.values()].filter((p) => p.status === 'ready')
    if (discovered.length === 0) log.debug(`no plugins in ${this.dir}`)
    else log.info(`plugins: ${on.length}/${this.plugins.size} active`, { ids: on.map((p) => p.id).join(',') || 'none' })
    return this.list()
  }

  async #start(record) {
    const started = Date.now()
    try {
      const module = await loadPluginModule(record.file)
      const setup = module.setup ?? module.default
      if (typeof setup !== 'function') throw new Error('module exports no setup() function')

      if (module.manifest) {
        record.name = module.manifest.name ?? record.name
        record.version = module.manifest.version ?? record.version
        record.description = module.manifest.description ?? record.description
      }

      const teardown = await setup(this.#context(record))
      record.teardown = typeof teardown === 'function' ? teardown : null
      record.status = 'ready'
      record.error = null
      record.loadedAt = Date.now()
      log.info(`loaded ${record.id}@${record.version}`, {
        ms: Date.now() - started,
        ...(record.provides.sources.length ? { sources: record.provides.sources.join(',') } : {}),
        ...(record.provides.effects.length ? { effects: record.provides.effects.join(',') } : {}),
        ...(record.provides.routes.length ? { routes: record.provides.routes.length } : {}),
        ...(record.provides.static.length ? { serving: record.provides.static.join(',') } : {})
      })
    } catch (error) {
      record.status = 'error'
      record.error = error.message
      log.error(`plugin "${record.id}" failed to load`, error)
      this.#revoke(record) // never leave half-registered extensions behind
    }
    return record
  }

  /** Undo everything a plugin registered. */
  #revoke(record) {
    for (const off of record.listeners) {
      try {
        off()
      } catch {
        /* ignore */
      }
    }
    record.listeners = []
    record.scopeListeners = []

    for (const name of record.provides.sources) this.sources?.unregister?.(name)
    for (const name of record.provides.effects) unregisterEffect(name)
    this.routes = this.routes.filter((r) => r.pluginId !== record.id)
    this.mounts = this.mounts.filter((m) => m.pluginId !== record.id)
    record.provides = { sources: [], effects: [], routes: [], static: [], relays: [] }
  }

  async #stop(record) {
    if (record.teardown) {
      try {
        await record.teardown()
      } catch (error) {
        log.warn(`plugin "${record.id}" teardown failed: ${error.message}`)
      }
      record.teardown = null
    }
    this.#revoke(record)
    record.loadedAt = null
  }

  /* --------------------------- station scope -------------------------- */

  /**
   * Does `pluginId` apply to `stationId`?
   *
   * A global plugin always does. Otherwise the answer is the station's own
   * override, and where there is none, the plugin's global state — so the
   * table only ever records deliberate decisions and a brand new station
   * inherits whatever the node already does.
   */
  appliesTo(pluginId, stationId) {
    const record = typeof pluginId === 'object' ? pluginId : this.plugins.get(pluginId)
    if (!record || record.status !== 'ready') return false
    if (record.scope === 'global' || !stationId) return true
    const override = record.stations?.[stationId]
    return override ? override.enabled !== false : true
  }

  /** Settings as this plugin sees them for one station (station wins). */
  /**
   * Check a settings patch for one plugin.
   * @returns {{ value: object, errors: Array<{field: string, message: string}>, unknown: string[] }}
   */
  validateSettings(pluginId, patch = {}) {
    const record = typeof pluginId === 'object' ? pluginId : this.plugins.get(pluginId)
    if (!record) return { value: {}, errors: [{ field: null, message: 'no such plugin' }], unknown: [] }
    if (!record.schema?.length) return { value: { ...patch }, errors: [], unknown: [] }
    return validateSettings(record.schema, patch)
  }

  /** The settings form for one plugin, optionally for one station. */
  schemaFor(pluginId, stationId = null) {
    const record = typeof pluginId === 'object' ? pluginId : this.plugins.get(pluginId)
    if (!record) return []
    const settings = stationId ? this.settingsFor(record, stationId) : record.settings
    return describeSettings(record.schema ?? [], settings)
  }

  settingsFor(pluginId, stationId) {
    const record = typeof pluginId === 'object' ? pluginId : this.plugins.get(pluginId)
    if (!record) return {}
    return { ...record.settings, ...(record.stations?.[stationId]?.settings ?? {}) }
  }

  /** Station ids this plugin currently applies to. */
  stationsFor(pluginId) {
    const record = typeof pluginId === 'object' ? pluginId : this.plugins.get(pluginId)
    if (!record) return []
    return [...(this.manager?.stations?.keys() ?? [])].filter((id) => this.appliesTo(record, id))
  }

  #scopeSummary(record) {
    const all = [...(this.manager?.stations?.keys() ?? [])]
    const off = all.filter((id) => !this.appliesTo(record, id))
    return {
      scope: record.scope,
      mode: record.scope === 'global' ? 'global' : off.length === 0 ? 'all' : off.length === all.length ? 'none' : 'some',
      on: all.filter((id) => this.appliesTo(record, id)),
      off,
      overrides: Object.fromEntries(Object.entries(record.stations ?? {}).map(([id, value]) => [id, value.enabled !== false]))
    }
  }

  /** Tell a plugin its world changed, so it can re-read `ctx.stations`. */
  #announceScope(record, change) {
    for (const listener of record.scopeListeners ?? []) {
      try {
        listener(change)
      } catch (error) {
        log.warn(`plugin "${record.id}" scope handler threw: ${error.message}`)
      }
    }
    this.emit('scope', { plugin: record.id, ...change })
  }

  /**
   * Switch a plugin on or off for a single station. The plugin stays loaded —
   * it simply stops seeing that station, which is what makes this cheap
   * enough to toggle from the console while everything is on air.
   */
  setStationState(pluginId, stationId, enabled, { settings } = {}) {
    const record = this.plugins.get(pluginId)
    if (!record) throw Object.assign(new Error(`No plugin "${pluginId}"`), { status: 404 })
    if (record.scope === 'global') {
      throw Object.assign(new Error(`"${pluginId}" is a global plugin — it cannot be switched per station`), { status: 400 })
    }
    if (this.manager && !this.manager.get?.(stationId)) {
      throw Object.assign(new Error(`No station "${stationId}"`), { status: 404 })
    }

    const saved = this.store?.setStationPlugin(stationId, pluginId, { enabled, settings })
    record.stations = { ...record.stations, [stationId]: { enabled, settings: saved?.settings ?? settings ?? {} } }
    log.info(`${pluginId}: ${enabled ? 'enabled' : 'disabled'} for station "${stationId}"`)
    this.#announceScope(record, { station: stationId, enabled })
    return this.list().find((p) => p.id === pluginId)
  }

  /** Drop the override: the station follows the plugin's global state again. */
  clearStationState(pluginId, stationId) {
    const record = this.plugins.get(pluginId)
    if (!record) throw Object.assign(new Error(`No plugin "${pluginId}"`), { status: 404 })
    this.store?.clearStationPlugin(stationId, pluginId)
    const { [stationId]: removed, ...rest } = record.stations ?? {}
    record.stations = rest
    if (removed) {
      log.info(`${pluginId}: station "${stationId}" follows the node again`)
      this.#announceScope(record, { station: stationId, enabled: this.appliesTo(record, stationId), cleared: true })
    }
    return this.list().find((p) => p.id === pluginId)
  }

  /**
   * The per-station view the owner console draws: every plugin that *could*
   * apply to this station, and whether it does.
   */
  stationView(stationId) {
    return [...this.plugins.values()]
      .filter((record) => record.scope !== 'global')
      .map((record) => {
        const override = record.stations?.[stationId]
        return {
          id: record.id,
          name: record.name,
          description: record.description,
          version: record.version,
          status: record.status,
          node: record.enabled, // on for the node as a whole?
          enabled: this.appliesTo(record, stationId), // …and on here?
          source: override ? 'station' : 'node',
          settings: override?.settings ?? {},
          provides: {
            sources: [...record.provides.sources],
            effects: [...record.provides.effects],
            routes: record.provides.routes.length
          }
        }
      })
  }

  /* ------------------------------ context ----------------------------- */

  #context(record) {
    const pluginLog = createLogger(`plugin:${record.id}`)

    // Plugins get facts, not secrets: no owner key, no passwords, no store file.
    const safeConfig = Object.freeze({
      version: this.version,
      port: this.config?.server?.port,
      stationDefaults: structuredClone(this.config?.stationDefaults ?? {}),
      sources: Object.freeze({ defaultSearch: this.config?.sources?.defaultSearch })
    })

    const track = (kind, name) => record.provides[kind].push(name)

    /** `/a/:id/b` → matcher that yields `{ id }`, or null. */
    const compile = (routePath) => {
      const segments = routePath.split('/').filter(Boolean)
      return (candidate) => {
        const parts = candidate.split('/').filter(Boolean)
        if (segments.length !== parts.length && segments.at(-1) !== '*') return null
        const params = {}
        for (let i = 0; i < segments.length; i += 1) {
          const segment = segments[i]
          if (segment === '*') return { ...params, rest: parts.slice(i).join('/') }
          if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(parts[i] ?? '')
          else if (segment !== parts[i]) return null
        }
        return params
      }
    }

    return {
      id: record.id,
      name: record.name,
      version: record.version,
      dir: record.dir,
      log: pluginLog,
      config: safeConfig,
      settings: record.settings,

      /**
       * Persist this plugin's settings (merged, survives restarts).
       *
       * Checked against the plugin's own schema when it has one, so a plugin
       * cannot write a value it would later refuse to read.
       */
      saveSettings: (patch) => {
        const { value, errors } = this.validateSettings(record, patch)
        if (errors.length) pluginLog.warn(`settings rejected — ${errors.map((problem) => problem.message).join('; ')}`)
        record.settings = { ...record.settings, ...value }
        this.store?.setPluginSettings(record.id, record.settings)
        return record.settings
      },

      /** The plugin's own schema, as the console sees it. */
      schema: () => describeSettings(record.schema ?? [], record.settings),

      /* ---------------------------- the node --------------------------- */
      /**
       * Only the stations this plugin applies to. Scoping is enforced here
       * rather than trusted to the plugin: a station it is switched off for
       * is simply not in the list, and `get()` does not return it.
       */
      stations: {
        list: () => (this.manager?.list() ?? []).filter((station) => this.appliesTo(record, station.id)),
        get: (id) => (this.appliesTo(record, id) ? this.manager?.get(id) : undefined),
        all: () => [...(this.manager?.stations.values() ?? [])].filter((station) => this.appliesTo(record, station.id)),
        /** Every station on the node, including the ones out of scope. */
        every: () => [...(this.manager?.stations.values() ?? [])],
        /** Is this plugin on for that station? */
        applies: (id) => this.appliesTo(record, id),
        /** Plugin settings with this station's overrides layered on top. */
        settings: (id) => this.settingsFor(record, id),
        /** React to being switched on/off for a station while running. */
        onScopeChange: (handler) => {
          record.scopeListeners.push(handler)
          return () => {
            record.scopeListeners = record.scopeListeners.filter((fn) => fn !== handler)
          }
        }
      },
      store: this.store,
      tts: this.tts,
      /** Resolve/search through the registry (respects every source). */
      resolve: (query, options) => this.sources.resolve(query, options),
      search: (query, limit, provider) => this.sources.search(query, limit, provider),

      /* ------------------------------ relay ---------------------------- */
      /**
       * Put a live stream on air, straight from the plugin.
       *
       *     const feed = await fetch(url)
       *     ctx.relay('city-fm', feed.body, { title: 'Breakfast show' })
       *
       * `input` is anything that yields MP3 bytes — an HTTP body, a socket,
       * a child process's stdout, an async generator. MetroS re-frames it
       * (natively when libmetro is installed) and the station airs it in
       * contiguous blocks: nothing is decoded and nothing is re-encoded, so
       * the cost per listener is a socket write.
       *
       * Returns `{ stop, stats, done }`. Out-of-scope stations refuse, the
       * same as everywhere else in this API.
       */
      relay: (stationId, input, options = {}) => {
        const station = this.appliesTo(record, stationId) ? this.manager?.get(stationId) : null
        if (!station) throw new Error(`no station "${stationId}" for this plugin`)
        if (!input) throw new Error('relay needs a stream of mp3 bytes')
        const handle = station.relay(input, { artist: options.artist ?? record.manifest?.name ?? record.id, ...options })
        record.listeners.push(() => handle.stop('plugin unloaded'))
        track('relays', `${stationId}: ${options.title ?? 'live relay'}`)
        return handle
      },

      /* ---------------------------- listeners -------------------------- */
      /** `ctx.on('track', ({ station, data }) => …)` — auto-removed on unload. */
      on: (event, handler) => {
        const wrapped = (payload) => {
          // Station scope is enforced at the bus: events from a station this
          // plugin is switched off for are never delivered at all.
          const stationId = payload?.station?.id ?? payload?.station
          if (stationId && !this.appliesTo(record, stationId)) return
          try {
            handler(payload)
          } catch (error) {
            pluginLog.warn(`handler for "${event}" threw: ${error.message}`)
          }
        }
        this.on(event, wrapped)
        record.listeners.push(() => this.off(event, wrapped))
        return () => this.off(event, wrapped)
      },

      /** A repeating job that is cleared when the plugin unloads. */
      every: (ms, fn) => {
        const timer = setInterval(() => {
          try {
            fn()
          } catch (error) {
            pluginLog.warn(`interval threw: ${error.message}`)
          }
        }, ms)
        timer.unref?.()
        record.listeners.push(() => clearInterval(timer))
        return () => clearInterval(timer)
      },

      /* --------------------------- extensions -------------------------- */
      /** Add a music source: `{ name, prefixes, canResolve, resolve, search, stream }`. */
      registerSource: (provider) => {
        if (!provider?.name) throw new Error('a source needs a name')
        this.sources.register(provider, { before: provider.before })
        track('sources', provider.name)
        return provider
      },

      /** Add an automix transition: `registerEffect('backspin', ctx => …)`. */
      registerEffect: (name, renderer) => {
        registerEffect(name, renderer)
        track('effects', name)
        return name
      },

      /**
       * Add an HTTP endpoint under `/api/v1/x/<plugin>/…`.
       * `handler({ req, res, url, send, fail, body })` → return true when handled.
       */
      registerRoute: (method, routePath, handler) => {
        const clean = `/${String(routePath).replace(/^\/+/, '')}`
        this.routes.push({ pluginId: record.id, method: method.toUpperCase(), path: clean, match: compile(clean), handler })
        track('routes', `${method.toUpperCase()} ${clean}`)
      },

      /**
       * Serve a directory of files at a URL prefix — this is how a plugin
       * ships a web app. `spa: true` answers unknown paths with the mount's
       * index.html so client-side routes survive a hard refresh.
       *
       * The node serves plugin mounts *before* its own built-in static files,
       * and stops serving them the moment the plugin is switched off.
       */
      registerStatic: (dir, { mount = '/', spa = false, index = 'index.html', optional = false, fallback = null } = {}) => {
        const root = dir ? path.resolve(record.dir, dir) : null
        if (!optional && (!root || !fs.existsSync(root))) {
          throw new Error(`static directory not found: ${path.basename(root ?? String(dir))}`)
        }
        const at = `/${String(mount).replace(/^\/+|\/+$/g, '')}`
        const entry = {
          pluginId: record.id,
          mount: at === '/' ? '' : at,
          dir: root && fs.existsSync(root) ? root : null,
          spa,
          index,
          // Answers anything the directory could not — a build that is not
          // there yet, say. Returning false falls through to the next mount.
          fallback
        }
        this.mounts.push(entry)
        // Longest prefix first: a plugin mounted at /tv must win over one at /.
        this.mounts.sort((a, b) => b.mount.length - a.mount.length)
        track('static', at)

        // The handle lets a plugin attach the directory later (and the console
        // does exactly that when `npm run build:web` finally runs).
        return {
          mount: at,
          toString: () => at,
          get dir() {
            return entry.dir
          },
          serving: () => Boolean(entry.dir),
          setDir: (next) => {
            const resolved = next ? path.resolve(record.dir, next) : null
            entry.dir = resolved && fs.existsSync(resolved) ? resolved : null
            return entry.dir
          },
          setFallback: (handler) => {
            entry.fallback = handler
          },
          remove: () => {
            this.mounts = this.mounts.filter((m) => m !== entry)
          }
        }
      },

      /** Is this request carrying the owner key? Use it to guard writes. */
      isOwner: (req, url) => isOwner(req, this.config, url)
    }
  }

  /* ------------------------------ control ----------------------------- */

  list() {
    return [...this.plugins.values()].map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      description: p.description,
      author: p.author,
      enabled: p.enabled,
      status: p.status,
      error: p.error,
      settings: p.settings,
      // A console renders a real form when this is here, and raw JSON when
      // it is not — so a plugin without a schema still works.
      schema: describeSettings(p.schema ?? [], p.settings),
      scope: p.scope,
      stations: this.#scopeSummary(p),
      provides: {
        sources: [...p.provides.sources],
        effects: [...p.provides.effects],
        routes: p.provides.routes.map((r) => `/api/v1/x/${p.id}${r.split(' ')[1]}`),
        static: [...(p.provides.static ?? [])],
        relays: [...(p.provides.relays ?? [])]
      },
      loadedAt: p.loadedAt
    }))
  }

  get(id) {
    return this.plugins.get(id)
  }

  async enable(id) {
    const record = this.plugins.get(id)
    if (!record) throw new Error(`No plugin "${id}"`)
    if (record.status === 'ready') return this.list().find((p) => p.id === id)
    record.enabled = true
    this.store?.setPluginEnabled(id, true)
    await this.#start(record)
    return this.list().find((p) => p.id === id)
  }

  async disable(id) {
    const record = this.plugins.get(id)
    if (!record) throw new Error(`No plugin "${id}"`)
    await this.#stop(record)
    record.enabled = false
    record.status = 'disabled'
    record.error = null
    this.store?.setPluginEnabled(id, false)
    log.info(`disabled ${id}`)
    return this.list().find((p) => p.id === id)
  }

  async reload(id) {
    const record = this.plugins.get(id)
    if (!record) throw new Error(`No plugin "${id}"`)
    await this.#stop(record)
    record.status = 'loading'
    if (!record.enabled) {
      record.enabled = true
      this.store?.setPluginEnabled(id, true)
    }
    await this.#start(record)
    return this.list().find((p) => p.id === id)
  }

  /** Re-scan the directory: pick up plugins added since boot. */
  async rescan() {
    const known = new Set(this.plugins.keys())
    const discovered = this.discover()
    for (const found of discovered) {
      if (known.has(found.id)) continue
      const scope = found.manifest.scope === 'global' ? 'global' : 'stations'
      const state = this.store?.registerPlugin(found.id, found.manifest.version, {
        defaultEnabled: found.manifest.enabled !== false,
        scope
      }) ?? { enabled: found.manifest.enabled !== false, settings: {}, stations: {} }
      this.plugins.set(found.id, {
        id: found.id,
        name: found.manifest.name ?? found.id,
        version: found.manifest.version ?? '0.0.0',
        description: found.manifest.description ?? '',
        author: found.manifest.author ?? null,
        file: found.file,
        dir: found.dir,
        manifest: found.manifest,
        enabled: state.enabled,
        scope,
        stations: state.stations ?? {},
        schema: normaliseSchema(found.manifest.settingsSchema),
        settings: cleanSettings(normaliseSchema(found.manifest.settingsSchema), found.manifest.settings, state.settings, found.id),
        status: state.enabled ? 'loading' : 'disabled',
        error: null,
        provides: { sources: [], effects: [], routes: [], static: [], relays: [] },
        listeners: [],
        scopeListeners: [],
        teardown: null,
        loadedAt: null
      })
      if (state.enabled) await this.#start(this.plugins.get(found.id))
    }
    // Forget plugins whose files disappeared.
    for (const id of known) {
      if (!discovered.some((d) => d.id === id) && !fs.existsSync(this.plugins.get(id).file)) {
        await this.#stop(this.plugins.get(id))
        this.plugins.delete(id)
      }
    }
    return this.list()
  }

  /** Effects contributed by plugins, for the UI's transition picker. */
  effects() {
    return EFFECTS
  }

  /** Route dispatch for rest.js — returns true when a plugin handled it. */
  async handle({ req, res, url, method, send, fail, readJson }) {
    const prefix = '/api/v1/x/'
    if (!url.pathname.startsWith(prefix)) return false

    const rest = url.pathname.slice(prefix.length)
    const slash = rest.indexOf('/')
    const pluginId = slash === -1 ? rest : rest.slice(0, slash)
    const routePath = slash === -1 ? '/' : rest.slice(slash)

    const record = this.plugins.get(pluginId)
    if (!record || record.status !== 'ready') return false

    let params = null
    const route = this.routes.find((r) => {
      if (r.pluginId !== pluginId || r.method !== method) return false
      params = r.match(routePath)
      return params !== null
    })
    if (!route) return false

    try {
      const body = method === 'POST' || method === 'PATCH' || method === 'PUT' ? await readJson(req) : null
      const handled = await route.handler({
        req,
        res,
        url,
        method,
        body,
        params: params ?? {},
        send,
        fail,
        sendFile: (file, options) => sendFile(res, file, options),
        owner: isOwner(req, this.config, url),
        // Handy for per-station endpoints: `if (!applies(id)) return fail(…)`.
        applies: (stationId) => this.appliesTo(record, stationId),
        settingsFor: (stationId) => this.settingsFor(record, stationId)
      })
      return handled !== false
    } catch (error) {
      log.warn(`plugin "${pluginId}" route ${method} ${routePath} threw: ${error.message}`)
      fail(res, 500, 'Plugin route failed')
      return true
    }
  }

  /**
   * Static dispatch for rest.js: does a plugin own this URL?
   * Called for GET/HEAD on anything that is not an API route.
   */
  serve({ req, res, url }) {
    if (this.mounts.length === 0) return false
    const pathname = url.pathname

    for (const mount of this.mounts) {
      if (mount.mount && !(pathname === mount.mount || pathname.startsWith(`${mount.mount}/`))) continue
      const record = this.plugins.get(mount.pluginId)
      if (!record || record.status !== 'ready') continue

      const rel = pathname.slice(mount.mount.length) || '/'

      if (mount.dir) {
        const file = resolveStaticFile(mount.dir, rel, { index: mount.index })
        if (file) {
          if (req.method === 'HEAD') {
            res.writeHead(200)
            res.end()
            return true
          }
          return sendFile(res, file)
        }

        // Single-page fallback: never for asset-looking paths, so a missing
        // script 404s instead of quietly returning HTML.
        if (mount.spa && !path.extname(rel)) {
          const index = resolveStaticFile(mount.dir, '/', { index: mount.index })
          if (index) return sendFile(res, index, { headers: { 'cache-control': 'no-cache' } })
        }
      }

      // Nothing on disk answered. A mount may still have something to say —
      // this is how the console explains itself before it has been built.
      if (mount.fallback) {
        try {
          if (mount.fallback({ req, res, url, path: rel }) !== false) return true
        } catch (error) {
          log.warn(`plugin "${mount.pluginId}" static fallback threw: ${error.message}`)
        }
      }
    }
    return false
  }

  async close() {
    for (const record of this.plugins.values()) await this.#stop(record)
    this.removeAllListeners()
  }
}

export default PluginHost
