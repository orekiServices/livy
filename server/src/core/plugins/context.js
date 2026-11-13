/**
 * The object a plugin module receives from `setup(ctx)`.
 *
 * A plugin gets facts and scoped handles, never the owner key or raw config.
 * Kept here rather than inside PluginHost so the host reads as lifecycle and
 * this file reads as the plugin API.
 */
import fs from 'node:fs'
import path from 'node:path'
import createLogger from '../../util/logger.js'
import { describe as describeSettings } from '../pluginSchema.js'
import { isOwner } from '../../server/owner.js'
import { registerEffect } from '../automix.js'

export function buildContext(host, record) {
    const pluginLog = createLogger(`plugin:${record.id}`)

    // Plugins get facts, not secrets: no owner key, no passwords, no store file.
    const safeConfig = Object.freeze({
      version: host.version,
      port: host.config?.server?.port,
      stationDefaults: structuredClone(host.config?.stationDefaults ?? {}),
      sources: Object.freeze({ defaultSearch: host.config?.sources?.defaultSearch })
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
        const { value, errors } = host.validateSettings(record, patch)
        if (errors.length) pluginLog.warn(`settings rejected — ${errors.map((problem) => problem.message).join('; ')}`)
        record.settings = { ...record.settings, ...value }
        host.store?.setPluginSettings(record.id, record.settings)
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
        list: () => (host.manager?.list() ?? []).filter((station) => host.appliesTo(record, station.id)),
        get: (id) => (host.appliesTo(record, id) ? host.manager?.get(id) : undefined),
        all: () => [...(host.manager?.stations.values() ?? [])].filter((station) => host.appliesTo(record, station.id)),
        /** Every station on the node, including the ones out of scope. */
        every: () => [...(host.manager?.stations.values() ?? [])],
        /** Is this plugin on for that station? */
        applies: (id) => host.appliesTo(record, id),
        /** Plugin settings with this station's overrides layered on top. */
        settings: (id) => host.settingsFor(record, id),
        /** React to being switched on/off for a station while running. */
        onScopeChange: (handler) => {
          record.scopeListeners.push(handler)
          return () => {
            record.scopeListeners = record.scopeListeners.filter((fn) => fn !== handler)
          }
        }
      },
      store: host.store,
      tts: host.tts,
      /** Resolve/search through the registry (respects every source). */
      resolve: (query, options) => host.sources.resolve(query, options),
      search: (query, limit, provider) => host.sources.search(query, limit, provider),

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
        const station = host.appliesTo(record, stationId) ? host.manager?.get(stationId) : null
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
          if (stationId && !host.appliesTo(record, stationId)) return
          try {
            handler(payload)
          } catch (error) {
            pluginLog.warn(`handler for "${event}" threw: ${error.message}`)
          }
        }
        host.on(event, wrapped)
        record.listeners.push(() => host.off(event, wrapped))
        return () => host.off(event, wrapped)
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
        host.sources.register(provider, { before: provider.before })
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
        host.routes.push({ pluginId: record.id, method: method.toUpperCase(), path: clean, match: compile(clean), handler })
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
        host.mounts.push(entry)
        // Longest prefix first: a plugin mounted at /tv must win over one at /.
        host.mounts.sort((a, b) => b.mount.length - a.mount.length)
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
            host.mounts = host.mounts.filter((m) => m !== entry)
          }
        }
      },

      /** Is this request carrying the owner key? Use it to guard writes. */
      isOwner: (req, url) => isOwner(req, host.config, url)
    }
  }

