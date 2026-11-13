/**
 * Plugin administration, split out of the owner router.
 */
import createLogger from '../../util/logger.js'

const log = createLogger('owner-plugins')

export async function pluginRoutes({ req, res, url, seg, method, send, fail, readJson, plugins, manager, store }) {
  const [, , , section, id, action, param] = seg
  if (section !== 'plugins') return false
  if (!plugins) return fail(res, 503, 'Plugins are disabled')

/* ------------------------------- plugins ---------------------------- */

  if (!plugins) return fail(res, 503, 'Plugins are disabled on this node')

  if (method === 'GET' && !id) {
    return send(res, 200, {
      dir: 'plugins/',
      plugins: plugins.list(),
      transitions: plugins.effects(),
      stations: manager.list().map((station) => ({ id: station.id, name: station.name }))
    })
  }

  if (id === 'rescan' && method === 'POST') {
    const list = await plugins.rescan()
    log.info('plugins rescanned', { count: list.length })
    return send(res, 200, { plugins: list })
  }

  if (id) {
    const pluginId = decodeURIComponent(id)
    if (!plugins.get(pluginId)) return fail(res, 404, `Unknown plugin "${pluginId}"`)

    // …/plugins/:id/schema[?station=lofi] — the form, on its own, with
    // the values that would apply here.
    if (method === 'GET' && action === 'schema') {
      const station = url.searchParams.get('station')
      if (station && !manager.find(station)) return fail(res, 404, `Unknown station "${station}"`)
      return send(res, 200, {
        plugin: pluginId,
        station: station ?? null,
        fields: plugins.schemaFor(pluginId, station ?? null),
        settings: station ? plugins.settingsFor(pluginId, station) : plugins.get(pluginId).settings
      })
    }

    if (method === 'GET') return send(res, 200, plugins.list().find((p) => p.id === pluginId))

    if (method === 'POST' && ['enable', 'disable', 'reload'].includes(action)) {
      try {
        const result = await plugins[action](pluginId)
        log.info(`plugin ${action}d: ${pluginId}`)
        return send(res, 200, result)
      } catch (error) {
        return fail(res, 400, error.message)
      }
    }

    if (method === 'PATCH') {
      const body = await readJson(req)
      const record = plugins.get(pluginId)
      if (body.settings && typeof body.settings === 'object') {
        // Checked against the plugin's schema when it has one: a bad
        // field is reported with its label, and nothing is saved until
        // the whole patch is good. Editing settings should not be a way
        // to break a running station.
        const { value, errors, unknown } = plugins.validateSettings(pluginId, body.settings)
        if (errors.length) return fail(res, 400, errors.map((problem) => problem.message).join('; '))
        if (unknown.length) log.debug(`plugin ${pluginId}: settings not in its schema — ${unknown.join(', ')}`)

        record.settings = { ...record.settings, ...value }
        store?.setPluginSettings(pluginId, record.settings)
        // Settings are read at setup(), so apply them by restarting it.
        if (record.status === 'ready') await plugins.reload(pluginId)
      }
      // `{ stations: { lofi: false, jazz: true, chill: null } }` — false is
      // off for that station, true is on, null forgets the override.
      if (body.stations && typeof body.stations === 'object') {
        try {
          for (const [stationId, value] of Object.entries(body.stations)) {
            if (value === null) plugins.clearStationState(pluginId, stationId)
            else plugins.setStationState(pluginId, stationId, value !== false)
          }
        } catch (error) {
          return fail(res, error.status ?? 400, error.message)
        }
      }
      return send(res, 200, plugins.list().find((p) => p.id === pluginId))
    }
  }

  return fail(res, 404, 'Unknown plugin route')
}

export default pluginRoutes
