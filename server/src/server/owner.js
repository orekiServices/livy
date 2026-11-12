/**
 * Owner control plane — everything a station owner can do, behind one key.
 *
 * Auth: `x-owner-key: <key>`, `Authorization: Bearer <key>` or `?key=<key>`.
 * The key comes from config.owner.key / env OWNER_KEY (falls back to
 * server.password). A fresh install generates one on first boot and prints it
 * once; if none is set the node is in "open" mode — fine for a laptop, not
 * for the internet.
 *
 *   GET    /api/v1/owner                       overview (stations, bans, store…)
 *   GET    /api/v1/owner/whoami                key check for the console
 *   POST   /api/v1/owner/stations              create a station (persisted)
 *   PATCH  /api/v1/owner/stations/:id          rename / re-genre / re-programme
 *   DELETE /api/v1/owner/stations/:id          delete a station
 *   POST   /api/v1/owner/stations/:id/say      { text } live announcement
 *   POST   /api/v1/owner/stations/:id/intro    { tts | file } station ident
 *   POST   /api/v1/owner/stations/:id/queue    { query | track, position, top }
 *   POST   /api/v1/owner/stations/:id/skip|start|stop|shuffle|reload|clear
 *   DELETE /api/v1/owner/stations/:id/requests[/:rid]
 *   GET    /api/v1/owner/stations/:id/plays
 *   GET/POST/DELETE /api/v1/owner/bans[/:voter]
 */
import createLogger, { tail, loggingState } from '../util/logger.js'
import { engineInfo } from '../util/metro.js'
import { REASONS, REASON_IDS, LINES, SHIPPED_LANGUAGES } from './streamErrors.js'
import { LANGUAGES, normaliseLanguage } from '../tts/index.js'
import { publicTrack } from '../core/station.js'
import { EFFECTS, EFFECT_TRAITS, AUTO_EFFECT, DEFAULT_AUTOMIX } from '../core/automix.js'
import { previewTransition } from '../core/preview.js'

const log = createLogger('owner')

export function ownerKey(config) {
  return config.owner?.key || config.server?.password || ''
}

export function isOwner(req, config, url) {
  const key = ownerKey(config)
  if (!key) return true // open mode
  const header = req.headers['x-owner-key'] ?? ''
  const auth = req.headers.authorization ?? ''
  const query = url?.searchParams?.get('key') ?? ''
  return header === key || auth === key || auth === `Bearer ${key}` || query === key
}

/**
 * @returns {(ctx: object) => Promise<boolean>} handled?
 */
/**
 * Lines a station owner ends up needing at two in the morning, when typing
 * a sentence into a phone is the last thing they want to do. `{station}`
 * and `{node}` are filled in before the words are spoken.
 */
export const ANNOUNCEMENT_PRESETS = {
  'station-id': { title: 'Station ident', text: 'You are listening to {station}.' },
  'back-soon': { title: 'Back soon', text: 'We are taking a short break. {station} will be back in a few minutes.' },
  'technical': { title: 'Technical trouble', text: 'Apologies — we are having a technical problem. Normal service will return shortly.' },
  'requests-open': { title: 'Requests open', text: 'The request line is open. Send us what you want to hear on {station}.' },
  'good-morning': { title: 'Good morning', text: 'Good morning, and welcome to {station}.' },
  'good-evening': { title: 'Good evening', text: 'Good evening, you are with {station}.' },
  'goodnight': { title: 'Goodnight', text: 'That is all from us tonight. Thank you for listening to {station}.' }
}

export function createOwnerRouter({ manager, config, sources, store, tts, plugins = null, streamErrors = null }) {
  return async function ownerRoutes({ req, res, url, seg, method, send, fail, readJson }) {
    // /api/v1/owner/<section>/<id>/<action>/<param>
    const [, , , section, id, action, param] = seg

    if (!isOwner(req, config, url)) return fail(res, 401, 'Owner key required (x-owner-key)')

    const station = () => {
      const found = manager.find(decodeURIComponent(id ?? ''))
      if (!found) fail(res, 404, `Unknown station "${id}"`)
      return found
    }

    /* ------------------------------ overview ---------------------------- */

    if (!section) {
      return send(res, 200, {
        owner: config.owner?.name ?? 'owner',
        defaults: {
          crossfadeMs: config.stationDefaults?.automix?.crossfadeMs,
          effect: config.stationDefaults?.automix?.effect,
          beatmatch: config.stationDefaults?.automix?.beatmatch !== false,
          dj: config.stationDefaults?.automix?.dj?.enabled !== false
        },
        protected: Boolean(ownerKey(config)),
        stations: manager.list({ owner: true }),
        bans: store?.listBans() ?? [],
        store: store ? { driver: store.driver, ...store.stats() } : null,
        sources: sources.sources.map((s) => s.name),
        // Which relay engine the node is running (native libmetro or the
        // JavaScript fallback) — the owner should not have to read logs.
        engine: engineInfo(),
        // What the node remembers, and what it plays when the rotation runs
        // dry. Both are cheap to report and the first thing to check when a
        // station behaves unexpectedly after a restart.
        memory: manager.memory?.stats?.() ?? { enabled: false },
        smartQueue: manager.smartQueue ? { ...manager.smartQueue.options, ...manager.smartQueue.stats } : { enabled: false },
        stats: manager.stats()
      })
    }

    if (section === 'whoami') return send(res, 200, { owner: true, name: config.owner?.name ?? 'owner' })

    /* ------------------------------ stations ---------------------------- */

    if (section === 'stations') {
      if (!id) {
        if (method === 'GET') return send(res, 200, { stations: manager.list({ queue: true, owner: true }) })
        if (method === 'POST') {
          const body = await readJson(req)
          let created
          try {
            created = manager.add({ allowRequests: true, ...body, _owned: true })
          } catch (error) {
            return fail(res, 400, error.message) // duplicate id, no name, …
          }
          if (body.autoStart !== false) {
            created
              .load()
              .then(() => created.start())
              .catch((error) => log.warn(`${created.id}: ${error.message}`))
          }
          log.info(`owner created station "${created.id}"`)
          return send(res, 201, created.info())
        }
        return fail(res, 405, 'Method not allowed')
      }

      const target = station()
      if (!target) return true

      if (!action) {
        if (method === 'GET') return send(res, 200, target.info({ queue: true, owner: true }))
        if (method === 'PATCH') {
          const patch = await readJson(req)
          const updated = manager.update(target.id, patch)
          store?.saveStation({ ...updated.options, id: updated.id, name: updated.name, playlists: updated.playlists })
          return send(res, 200, updated.info())
        }
        if (method === 'DELETE') {
          manager.remove(target.id)
          log.info(`owner deleted station "${target.id}"`)
          return send(res, 200, { removed: target.id })
        }
        return fail(res, 405, 'Method not allowed')
      }

      // /owner/stations/:id/plugins            → what applies here
      // /owner/stations/:id/plugins/:pid/enable | disable | reset
      // PATCH …/plugins/:pid { enabled, settings }
      if (action === 'plugins') {
        if (!plugins) return fail(res, 503, 'Plugins are disabled on this node')
        if (!param) {
          if (method !== 'GET') return fail(res, 405, 'Method not allowed')
          return send(res, 200, { station: target.id, plugins: plugins.stationView(target.id) })
        }

        const pluginId = decodeURIComponent(param)
        if (!plugins.get(pluginId)) return fail(res, 404, `Unknown plugin "${pluginId}"`)
        const verb = seg[7] ? decodeURIComponent(seg[7]) : null

        try {
          if (method === 'POST' && ['enable', 'disable', 'reset'].includes(verb)) {
            const result =
              verb === 'reset'
                ? plugins.clearStationState(pluginId, target.id)
                : plugins.setStationState(pluginId, target.id, verb === 'enable')
            log.info(`plugin ${pluginId} ${verb}d for station "${target.id}"`)
            return send(res, 200, { station: target.id, plugin: result, plugins: plugins.stationView(target.id) })
          }

          if (method === 'PATCH') {
            const body = await readJson(req)
            if (body.enabled === null) {
              plugins.clearStationState(pluginId, target.id)
              return send(res, 200, { station: target.id, plugins: plugins.stationView(target.id) })
            }

            let settings = body.settings
            if (settings && typeof settings === 'object') {
              const checked = plugins.validateSettings(pluginId, settings)
              if (checked.errors.length) return fail(res, 400, checked.errors.map((problem) => problem.message).join('; '))
              // A field marked `perStation: false` is node-wide by design.
              const fixed = plugins.schemaFor(pluginId).filter((field) => field.perStation === false).map((field) => field.key)
              const offered = Object.keys(checked.value).filter((key) => fixed.includes(key))
              if (offered.length) return fail(res, 400, `${offered.join(', ')} cannot be set per station`)
              settings = checked.value
            }

            plugins.setStationState(pluginId, target.id, body.enabled !== false, { settings })
            return send(res, 200, { station: target.id, plugins: plugins.stationView(target.id) })
          }
        } catch (error) {
          return fail(res, error.status ?? 400, error.message)
        }

        return fail(res, 404, 'Unknown station-plugin route')
      }

      /**
       * Say something on air. The whole point is that it should take one
       * request and no thought:
       *
       *   { "text": "Good evening" }                     → now, station language
       *   { "text": "Xin chào", "language": "vi" }       → now, in Vietnamese
       *   { "preset": "back-soon" }                      → a canned line
       *   { "text": "…", "when": "next" }                → after this song
       *   { "text": "…", "preview": true }               → hear it, don't air it
       */
      if (action === 'say' && method === 'POST') {
        const body = await readJson(req)
        const preset = body.preset ? ANNOUNCEMENT_PRESETS[body.preset] : null
        if (body.preset && !preset) {
          return fail(res, 400, `Unknown preset \"${body.preset}\" (try: ${Object.keys(ANNOUNCEMENT_PRESETS).join(', ')})`)
        }

        const raw = body.text ?? preset?.text
        if (!raw) return fail(res, 400, 'Send { text } or { preset }')

        const text = String(raw)
          .replace(/\{station\}/g, target.name)
          .replace(/\{node\}/g, config.name ?? 'Nodecast')
          .slice(0, 500)
        const language = body.language ? normaliseLanguage(body.language) : (target.language ?? undefined)

        // Hear it before the listeners do.
        if (body.preview) {
          if (!tts) return fail(res, 503, 'TTS is disabled')
          const { file, provider } = await tts.speak(text, { language })
          const audio = await import('node:fs/promises').then((fs) => fs.readFile(file))
          res.writeHead(200, {
            'content-type': 'audio/mpeg',
            'content-length': String(audio.length),
            'content-language': language ?? tts.language,
            'x-nodecast-tts': provider,
            'cache-control': 'no-store'
          })
          return res.end(audio)
        }

        const immediate = body.when !== 'next' && body.when !== 'queued'
        const track = target.say(text, {
          artist: body.as ?? config.owner?.name ?? 'owner',
          title: body.title ?? preset?.title,
          language,
          immediate
        })
        log.info(`announcement on ${target.id}${immediate ? '' : ' (after this track)'}: \"${text.slice(0, 60)}\"`)
        return send(res, 200, {
          announced: track.title,
          text,
          language: language ?? tts?.language ?? 'en',
          when: immediate ? 'now' : 'next',
          station: target.id
        })
      }

      // The canned lines, so a console can offer buttons instead of a
      // text box nobody wants to type into on a phone.
      if (action === 'say' && method === 'GET') {
        return send(res, 200, {
          presets: Object.entries(ANNOUNCEMENT_PRESETS).map(([id, preset]) => ({ id, ...preset })),
          language: target.language ?? tts?.language ?? 'en',
          languages: tts?.languages ?? LANGUAGES
        })
      }

      if (action === 'intro' && method === 'POST') {
        const body = await readJson(req)
        const intro = body.clear ? null : { tts: body.tts ?? body.text ?? null, file: body.file ?? null, bundled: body.bundled ?? null }
        target.options.intro = intro
        if (body.idleAnnouncementMs != null) target.options.idleAnnouncementMs = Number(body.idleAnnouncementMs)
        store?.saveStation({ ...target.options, id: target.id, name: target.name, playlists: target.playlists })
        if (intro && body.playNow !== false) target.playAnnouncement({ ...intro, source: 'tts', id: `tts:intro:${target.id}`, title: `${target.name} — ident`, artist: target.name, text: intro.tts ?? '', announcement: true, duration: 0, bitrate: 128, streamable: true })
        return send(res, 200, { intro, station: target.id })
      }

      // Automix: transition style + DJ, changeable while the station is live.
      if (action === 'automix') {
        if (method === 'GET') return send(res, 200, target.automix.info())
        if (method === 'POST' || method === 'PATCH') {
          const body = await readJson(req)
          const patch = {}
          for (const key of ['enabled', 'crossfadeMs', 'curve', 'effect', 'minTrackMs', 'bitrate', 'beatAlign', 'beatmatch', 'maxStretchPercent', 'trimSilence', 'crossoverHz', 'targetLufs', 'ceilingDb', 'maxGainDb']) {
            if (body[key] !== undefined) patch[key] = key === 'enabled' || key === 'beatmatch' || key === 'beatAlign' ? Boolean(body[key]) : body[key]
          }
          if (body.dj !== undefined) {
            patch.dj = typeof body.dj === 'boolean' ? { enabled: body.dj } : body.dj
          }
          let info
          try {
            info = target.setAutomix(patch)
          } catch (error) {
            return fail(res, 400, error.message) // e.g. an unknown transition
          }
          store?.saveStation({ ...target.options, id: target.id, name: target.name, playlists: target.playlists })
          log.info(`owner set automix on "${target.id}": ${JSON.stringify(patch)}`)
          return send(res, 200, info)
        }
        return fail(res, 405, 'Method not allowed')
      }

      if (action === 'queue') {
        if (method === 'GET') return send(res, 200, { queue: target.queue })
        if (method === 'POST') {
          const body = await readJson(req)
          let tracks = body.track ? [body.track] : []
          if (!tracks.length && body.query) {
            const resolved = await sources.resolve(body.query)
            tracks = resolved.tracks ?? []
          }
          if (!tracks.length) return fail(res, 404, 'Nothing found')
          const added = target.enqueue(tracks, { position: body.top ? 0 : body.position })
          return send(res, 200, { added: added?.length ?? tracks.length, queueLength: target.queue.length })
        }
        // What a drag-and-drop console sends: either one move, or the whole
        // order at once. Both are idempotent and neither can lose a track.
        if (method === 'PATCH') {
          const body = await readJson(req)

          if (Array.isArray(body.order)) {
            const queue = target.reorder(body.order)
            return send(res, 200, { queue: queue.map(publicTrack), queueLength: queue.length })
          }

          if (body.from != null) {
            const moved = target.move(Number(body.from), Number(body.to ?? 0))
            if (!moved) return fail(res, 404, 'No such queue index')
            return send(res, 200, { moved: publicTrack(moved), queue: target.queue.map(publicTrack) })
          }

          if (body.next != null) {
            const moved = target.playNext(Number(body.next))
            if (!moved) return fail(res, 404, 'No such queue index')
            return send(res, 200, { next: publicTrack(moved), queue: target.queue.map(publicTrack) })
          }

          return fail(res, 400, 'Send { order: [...] }, { from, to } or { next }')
        }

        if (method === 'DELETE') {
          if (param == null) {
            target.clearQueue()
            return send(res, 200, { cleared: true })
          }
          const removed = target.removeAt(Number(param))
          return removed ? send(res, 200, { removed }) : fail(res, 404, 'No such queue index')
        }
      }

      if (action === 'requests') {
        if (method === 'GET') return send(res, 200, { requests: target.requestList?.() ?? target.requests.map((r) => ({ id: r.id, title: r.track.title, votes: r.votes, by: r.by })) })
        if (method === 'DELETE') {
          if (param == null) {
            const n = target.requests.length
            for (const r of target.requests) store?.markRequest(r.id, 'removed')
            target.requests = []
            target.emit('requests', target.requests)
            return send(res, 200, { cleared: n })
          }
          const index = target.requests.findIndex((r) => r.id === param)
          if (index === -1) return fail(res, 404, 'No such request')
          const [removed] = target.requests.splice(index, 1)
          store?.markRequest(removed.id, 'removed')
          target.emit('requests', target.requests)
          return send(res, 200, { removed: removed.id, title: removed.track.title })
        }
      }

      if (action === 'plays' && method === 'GET') {
        return send(res, 200, { plays: store?.recentPlays(target.id, 50) ?? target.history })
      }

      if (method === 'POST') {
        if (action === 'skip') {
          const skipped = target.nowPlaying()
          target.skip()
          return send(res, 200, { skipped: skipped?.track?.title ?? null })
        }
        if (action === 'start') {
          await target.load()
          await target.start()
          return send(res, 200, target.info())
        }
        if (action === 'stop') {
          target.stop('owner')
          return send(res, 200, target.info())
        }
        if (action === 'shuffle') {
          target.shuffle()
          return send(res, 200, { shuffled: target.queue.length })
        }
        if (action === 'reload') {
          target.clearQueue()
          await target.load(true)
          return send(res, 200, { queueLength: target.queue.length })
        }
      }

      return fail(res, 404, 'Unknown owner station action')
    }

    /* -------------------------------- bans ------------------------------ */

    if (section === 'bans') {
      if (!store) return fail(res, 503, 'Persistence is disabled')
      if (method === 'GET') return send(res, 200, { bans: store.listBans() })
      if (method === 'POST') {
        const { voter, reason = '' } = await readJson(req)
        if (!voter) return fail(res, 400, 'Missing "voter"')
        store.ban(voter, reason)
        return send(res, 201, { banned: voter, reason })
      }
      if (method === 'DELETE') {
        if (!id) return fail(res, 400, 'Missing voter id')
        return send(res, 200, { unbanned: store.unban(decodeURIComponent(id)) })
      }
    }

    /* ------------------------------- plugins ---------------------------- */

    if (section === 'plugins') {
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

    /* ---------------------------- stream errors ------------------------- */

    // What a listener hears when a stream cannot be served. The owner writes
    // the lines; the node speaks them. See server/streamErrors.js.
    if (section === 'stream-errors') {
      if (!streamErrors) return fail(res, 503, 'Spoken errors are not configured')

      if (method === 'GET' && id === 'preview') {
        const reason = url.searchParams.get('reason') ?? 'unknown-station'
        if (!REASON_IDS.includes(reason)) return fail(res, 400, `Unknown reason "${reason}"`)
        const audio = await streamErrors.speak(reason, {
          station: url.searchParams.get('station') ?? 'Example FM',
          node: config.name ?? 'this node',
          language: url.searchParams.get('language') ?? streamErrors.defaultLanguage
        })
        res.writeHead(200, {
          'content-type': 'audio/mpeg',
          'content-length': String(audio.length),
          'cache-control': 'no-store',
          'content-disposition': `inline; filename="${reason}.mp3"`
        })
        return res.end(audio)
      }

      if (method === 'GET') {
        // One language at a time keeps the payload small and the console
        // simple: ?language=vi to edit the Vietnamese lines.
        const language = url.searchParams.get('language')
          ? normaliseLanguage(url.searchParams.get('language'))
          : streamErrors.defaultLanguage
        const shipped = LINES[language] ?? LINES[language.split('-')[0]] ?? LINES.en

        return send(res, 200, {
          ...streamErrors.current,
          editing: language,
          // The templates this language uses right now — `{station}` and
          // `{node}` left in, because this is what an editor edits…
          lines: Object.fromEntries(
            REASON_IDS.map((reason) => [reason, streamErrors.line(reason, { language, station: '{station}', node: '{node}' })])
          ),
          // …and one rendered example, so a console can show a preview.
          example: streamErrors.line('unknown-station', { language, station: 'Example FM', node: config.name ?? 'this node' }),
          // …the text it is based on, so a console can offer "reset"…
          defaults: Object.fromEntries(REASON_IDS.map((reason) => [reason, shipped[reason] ?? LINES.en[reason]])),
          // …and what the owner has overridden, per language.
          overrides: streamErrors.settings.messages,
          shipped: SHIPPED_LANGUAGES,
          status: Object.fromEntries(REASON_IDS.map((reason) => [reason, REASONS[reason].status]))
        })
      }

      if (method === 'PATCH') {
        const body = await readJson(req)
        // `{ language: 'vi', messages: { 'off-air': '…' } }` is the shape a
        // console form produces; fold it into the per-language map.
        if (body.messages && Object.keys(body.messages).some((key) => REASON_IDS.includes(key))) {
          const language = normaliseLanguage(body.language ?? streamErrors.defaultLanguage)
          body.messages = { [language]: body.messages }
          delete body.language
        }
        const updated = streamErrors.update(body)
        log.info(`spoken stream errors updated (${updated.enabled ? 'on' : 'off'}, ${updated.languages.length} languages)`)
        return send(res, 200, updated)
      }

      // Re-record: drop the cached audio so the next listener hears the
      // current voice and the current words.
      if (method === 'POST' && id === 'reload') {
        streamErrors.clear()
        return send(res, 200, { recorded: false, cleared: true })
      }

      return fail(res, 405, 'Method not allowed')
    }

    /* -------------------------------- automix --------------------------- */

    // Hear a transition before putting it on air. The node renders the seam
    // between two demo tracks with the effect and blend length asked for and
    // answers with the MP3 — which is the only honest way to choose between
    // ten transitions.
    if (section === 'automix') {
      if (method === 'GET') {
        return send(res, 200, {
          effects: [AUTO_EFFECT, ...EFFECTS],
          traits: EFFECT_TRAITS,
          defaults: {
            crossfadeMs: config.stationDefaults?.automix?.crossfadeMs ?? DEFAULT_AUTOMIX.crossfadeMs,
            minCrossfadeMs: DEFAULT_AUTOMIX.minCrossfadeMs,
            maxCrossfadeMs: DEFAULT_AUTOMIX.maxCrossfadeMs,
            smart: DEFAULT_AUTOMIX.smart
          },
          engine: engineInfo().dsp,
          // What each station is set to, so a console can show them together.
          stations: manager.list().map((station) => ({
            id: station.id,
            name: station.name,
            automix: manager.get(station.id)?.automix?.info?.() ?? null
          }))
        })
      }

      if (method === 'POST' && id === 'preview') {
        const body = await readJson(req)
        try {
          const audio = await previewTransition({
            effect: body.effect ?? AUTO_EFFECT,
            crossfadeMs: Number(body.crossfadeMs) || undefined,
            smart: body.smart,
            beatmatch: body.beatmatch,
            station: body.station ? manager.find(body.station) : null,
            sources
          })
          res.writeHead(200, {
            'content-type': 'audio/mpeg',
            'content-length': String(audio.mp3.length),
            'cache-control': 'no-store',
            'x-nodecast-effect': audio.report.effect,
            'x-nodecast-blend-ms': String(audio.report.blendMs)
          })
          return res.end(audio.mp3)
        } catch (error) {
          return fail(res, 400, `Could not render a preview: ${error.message}`)
        }
      }

      return fail(res, 405, 'Method not allowed')
    }

    /* ---------------------------------- tts ----------------------------- */

    // The node's voice: which service is speaking, in what language, at what
    // pace — and, for the service that has thousands of voices, which one.
    //
    // Language and pace are *shared*: switching service must not change how
    // a station sounds. Everything else is per service.
    if (section === 'tts') {
      if (method === 'GET') {
        const language = url.searchParams.get('language') ?? tts?.language ?? config.tts?.language ?? 'en'
        const wanted = url.searchParams.get('provider') ?? tts?.provider

        return send(res, 200, {
          enabled: Boolean(tts),
          provider: tts?.provider ?? 'off',
          // Shared by every service.
          shared: tts?.shared ?? { language, speed: config.tts?.speed ?? 1, fallback: true },
          // One entry per service, with its own settings and what it can do.
          providers: tts?.catalogue ?? [],
          languages: tts?.languages ?? LANGUAGES,
          // Voices for the service being looked at, in this language.
          voices: tts ? await tts.voicesFor(language, { provider: wanted }) : [],
          stations: manager.list().map((station) => ({ id: station.id, language: station.language ?? null }))
        })
      }

      if (method === 'PATCH') {
        if (!tts) return fail(res, 503, 'TTS is disabled')
        const body = await readJson(req)

        try {
          if (body.provider) {
            tts.setProvider(body.provider)
            store?.set?.('tts.provider', tts.provider)
          }

          // Shared settings.
          if (body.language) {
            tts.setLanguage(body.language)
            store?.set?.('tts.language', tts.language)
          }
          if (body.speed != null) {
            tts.speed = Math.max(0.1, Math.min(4, Number(body.speed) || 1))
            store?.set?.('tts.speed', tts.speed)
          }
          if (body.fallback != null) {
            tts.fallback = body.fallback !== false
            store?.set?.('tts.fallback', tts.fallback)
          }

          // Per-service settings: `{ providers: { flowery: { voice: '…' } } }`
          for (const [id, patch] of Object.entries(body.providers ?? {})) {
            tts.setProviderSettings(id, patch)
          }
          if (body.voice && tts.provider !== 'off') tts.setProviderSettings(tts.provider, { voice: body.voice })
          if (body.providers || body.voice) store?.set?.('tts.providers', tts.providers)
        } catch (error) {
          return fail(res, 400, error.message)
        }

        log.info(`voice: ${tts.provider} · ${tts.language} · ×${tts.speed}`)
        return send(res, 200, { provider: tts.provider, shared: tts.shared, providers: tts.catalogue })
      }

      // Hear a service before committing to it.
      if (method === 'POST' && id === 'preview') {
        if (!tts) return fail(res, 503, 'TTS is disabled')
        const body = await readJson(req)
        const language = normaliseLanguage(body.language ?? tts.language)
        const text = String(body.text ?? '').trim() || `This is ${config.name ?? 'Nodecast'}, testing the ${language} voice.`

        try {
          const { file, provider, fellBack } = await tts.speak(text, {
            language,
            provider: body.provider ?? undefined,
            voice: body.voice ?? undefined,
            speed: body.speed ?? undefined
          })
          const audio = await import('node:fs/promises').then((fs) => fs.readFile(file))
          res.writeHead(200, {
            'content-type': 'audio/mpeg',
            'content-length': String(audio.length),
            'content-language': language,
            'x-nodecast-tts': provider,
            'x-nodecast-fallback': String(Boolean(fellBack)),
            'cache-control': 'no-store'
          })
          return res.end(audio)
        } catch (error) {
          return fail(res, 502, `Could not render: ${error.message}`)
        }
      }

      return fail(res, 405, 'Method not allowed')
    }

    /* --------------------------------- logs ----------------------------- */

    if (section === 'logs' && method === 'GET') {
      const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 120) || 120)
      return send(res, 200, {
        logging: loggingState(),
        lines: tail(limit, { level: url.searchParams.get('level') ?? undefined, scope: url.searchParams.get('scope') ?? undefined })
      })
    }

    /* -------------------------------- store ----------------------------- */

    if (section === 'store') {
      if (!store) return fail(res, 503, 'Persistence is disabled')

      if (method === 'GET') {
        const info = store.info()
        // The absolute path is a server internal: report the file name only.
        return send(res, 200, { ...info, file: info.file.split('/').pop() })
      }

      // Maintenance the owner can run without a shell.
      if (method === 'POST' && ['vacuum', 'checkpoint', 'backup'].includes(id)) {
        if (id === 'vacuum') return send(res, 200, { vacuumed: true, ...store.vacuum() })
        if (id === 'checkpoint') {
          store.db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
          return send(res, 200, { checkpointed: true })
        }
        const target = `${store.file}.backup-${new Date().toISOString().slice(0, 10)}`
        store.backup(target)
        log.info('database backed up', { file: target.split('/').pop() })
        return send(res, 200, { backup: target.split('/').pop() })
      }
    }

    return fail(res, 404, 'Unknown owner route')
  }
}

export default createOwnerRouter
