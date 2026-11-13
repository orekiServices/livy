/**
 * Owner control plane — everything a station owner can do, behind one key.
 *
 * Auth: `x-owner-key: <secret>`, `Authorization: Bearer <secret>` or
 * `?key=<secret>`. The secret is an owner password (scrypt hash), an explicit
 * OWNER_KEY / server.password, or — until a password exists — the key generated
 * on first boot. If none is set the node is in "open" mode: fine for a laptop,
 * not for the internet. `POST /password` changes the password from the console.
 *
 *   GET    /api/v1/owner                       overview (stations, bans, store…)
 *   GET    /api/v1/owner/password              credential status
 *   POST   /api/v1/owner/password              { password } set/change
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
 *   GET/POST/DELETE /api/v1/owner/stations/:id/dj-model    the learned policy
 *   POST   /api/v1/owner/stations/:id/dj-model/train       train it from history
 */
import crypto from 'node:crypto'

import createLogger, { tail, loggingState } from '../../util/logger.js'
import { engineInfo } from '../../util/metro.js'
import { hostInfo } from '../../util/platform.js'
import { fxInfo } from '../../util/fx.js'
import { REASONS, REASON_IDS, LINES, SHIPPED_LANGUAGES } from '../streamErrors.js'
import { LANGUAGES, normaliseLanguage } from '../../tts/index.js'
import { publicTrack } from '../../core/station.js'
import { EFFECTS, EFFECT_TRAITS, AUTO_EFFECT, DEFAULT_AUTOMIX, outcomeReport } from '../../core/automix.js'
import { describe as describeFilters } from '../../core/filters/index.js'
import { modelRoutes, stationModels, trainForStation } from './models.js'
import { pluginRoutes } from './plugins.js'
import { systemRoutes } from './system.js'
import { previewTransition } from '../../core/preview.js'
import {
  canClaimPassword,
  hasPassword,
  passwordInfo,
  passwordProblem,
  setPassword,
  verifyPassword
} from './password.js'

const log = createLogger('owner')

export function ownerKey(config) {
  return config.owner?.key || config.server?.password || ''
}

/**
 * Is the generated key still a credential?
 *
 * A password supersedes a key the node minted for itself, but not one the
 * operator set on purpose. `OWNER_KEY` and the legacy `server.password` are
 * explicit decisions, and keeping them valid is what makes a forgotten
 * password recoverable without editing a hash file by hand.
 */
export function generatedKeyAllowed(config) {
  if (!hasPassword(config)) return true
  return config.owner?.keySource === 'explicit' || config.owner?.keySource === 'legacy'
}

/** Does this node require a credential at all? */
export function isProtected(config) {
  return Boolean(ownerKey(config) || hasPassword(config))
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a ?? ''))
  const right = Buffer.from(String(b ?? ''))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function presentedSecret(req, url) {
  const header = String(req.headers['x-owner-key'] ?? '')
  const auth = String(req.headers.authorization ?? '')
  const query = String(url?.searchParams?.get('key') ?? '')
  return header || (auth.startsWith('Bearer ') ? auth.slice(7) : auth) || query
}

export function isOwner(req, config, url) {
  const key = ownerKey(config)
  const keyUsable = Boolean(key) && generatedKeyAllowed(config)
  const passwordSet = hasPassword(config)
  const supplied = presentedSecret(req, url)

  // The key first: it is a constant-time string compare, not a scrypt run.
  if (keyUsable && sameSecret(supplied, key)) return true
  if (passwordSet && supplied && verifyPassword(supplied, config.owner.passwordHash)) return true
  if (!keyUsable && !passwordSet) return true // open mode
  return false
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

export function createOwnerRouter({ manager, config, sources, store, tts, plugins = null, streamErrors = null, autoTrainer = null }) {
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
        protected: isProtected(config),
        password: passwordInfo(config),
        stations: manager.list({ owner: true }),
        bans: store?.listBans() ?? [],
        store: store ? { driver: store.driver, ...store.stats() } : null,
        sources: sources.sources.map((s) => s.name),
        // Which relay engine the node is running (native libmetro or the
        // JavaScript fallback) — the owner should not have to read logs.
        engine: engineInfo(),
        device: hostInfo(),
        fx: fxInfo(),
        // What the node remembers, and what it plays when the rotation runs
        // dry. Both are cheap to report and the first thing to check when a
        // station behaves unexpectedly after a restart.
        memory: manager.memory?.stats?.() ?? { enabled: false },
        smartQueue: manager.smartQueue ? { ...manager.smartQueue.options, ...manager.smartQueue.stats } : { enabled: false },
        stats: manager.stats()
      })
    }

    if (section === 'whoami') return send(res, 200, { owner: true, name: config.owner?.name ?? 'owner' })

    /* ----------------------------- credentials -------------------------- */

    if (section === 'password') {
      if (method === 'GET') return send(res, 200, { ...passwordInfo(config), canClaim: canClaimPassword(config) })
      if (method !== 'POST') return fail(res, 405, 'Use GET or POST')

      if (config.owner?.passwordFromEnv) {
        return fail(res, 409, 'Password is set from OWNER_PASSWORD; change the environment and restart')
      }
      const body = await readJson(req)
      const problem = passwordProblem(body?.password)
      if (problem) return fail(res, 400, problem)
      const had = hasPassword(config)
      const result = setPassword(config, body.password)
      if (result.problem) return fail(res, 400, result.problem)
      log.info(`owner credential ${had ? 'updated' : 'set'} (${result.persisted ? 'saved' : 'this process only'})`)
      return send(res, 200, { ...passwordInfo(config), persisted: result.persisted })
    }

    /* ------------------------------- models ----------------------------- */

    if (section === 'models') {
      return modelRoutes({ req, res, url, method, id, action, store, readJson, send, fail, autoTrainer })
    }

    /* ------------------------------- plugins ---------------------------- */

    if (section === 'plugins') {
      return pluginRoutes({ req, res, url, seg, method, send, fail, readJson, plugins, manager, store })
    }

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
          .replace(/\{node\}/g, config.name ?? 'Livy')
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
            'x-livy-tts': provider,
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
        // The scoreboard travels with the settings: an owner choosing a
        // transition style can see what each one has actually done here.
        if (method === 'GET') return send(res, 200, { ...target.automix.info(), outcomes: outcomeReport(target.effectOutcomes?.()) })
        if (method === 'POST' || method === 'PATCH') {
          const body = await readJson(req)
          const patch = {}
          for (const key of ['enabled', 'crossfadeMs', 'curve', 'effect', 'minTrackMs', 'bitrate', 'beatAlign', 'beatmatch', 'maxStretchPercent', 'trimSilence', 'crossoverHz', 'targetLufs', 'ceilingDb', 'maxGainDb', 'model']) {
            if (body[key] !== undefined) patch[key] = ['enabled', 'beatmatch', 'beatAlign', 'model'].includes(key) ? Boolean(body[key]) : body[key]
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

      // Seams: what the scout hears in the song on air, and RL.
      if (action === 'seams') {
        if (method !== 'GET') return fail(res, 405, 'Method not allowed')
        return send(res, 200, target.seamsInfo({ graph: true }))
      }

      // Forever: the song on air loops on itself until something else is due.
      if (action === 'forever') {
        if (method === 'GET') return send(res, 200, target.foreverInfo())
        if (method === 'POST' || method === 'PATCH') {
          const body = await readJson(req)
          const info = target.setForever(body.enabled !== false)
          store?.saveStation({ ...target.options, id: target.id, name: target.name, playlists: target.playlists })
          log.info(`owner set forever on "${target.id}": ${info.enabled}`)
          return send(res, 200, info)
        }
        return fail(res, 405, 'Method not allowed')
      }

      // Filters: the NodeLink surface, per station, live.
      if (action === 'filters') {
        if (method === 'GET') {
          return send(res, 200, {
            active: target.filters?.active ?? [],
            settings: target.options.filters ?? {},
            schema: describeFilters(target.options.filters ?? {})
          })
        }
        if (method === 'POST' || method === 'PATCH') {
          const body = await readJson(req)
          // `{ filters: {...} }`, `{ settings: {...} }` and a bare payload are
          // all accepted: the console sends the first, NodeLink clients the last.
          const payload = body.filters ?? body.settings ?? body
          let info
          try {
            info = target.setFilters(payload)
          } catch (error) {
            return fail(res, 400, error.message)
          }
          store?.saveStation({ ...target.options, id: target.id, name: target.name, playlists: target.playlists })
          log.info(`owner set filters on "${target.id}": ${info.active.join(', ') || 'none'}`)
          return send(res, 200, info)
        }
        if (method === 'DELETE') {
          const info = target.setFilters({})
          store?.saveStation({ ...target.options, id: target.id, name: target.name, playlists: target.playlists })
          return send(res, 200, info)
        }
        return fail(res, 405, 'Method not allowed')
      }

      // The DJ policy: switch, score, explain, and train this station's
      // history. Implementation lives in owner/models.js.
      if (action === 'dj-model') {
        return stationModels({ req, res, method, target, store, readJson, send, fail, autoTrainer })
      }

      if (action === 'dj-model/train') {
        if (method !== 'POST') return fail(res, 405, 'Method not allowed')
        return trainForStation({ req, res, target, store, readJson, send, fail })
      }

      if (action === 'queue') {
        if (method === 'GET') return send(res, 200, { queue: target.queue })
        if (method === 'POST') {
          const body = await readJson(req)
          let tracks = body.track ? [await sources.rehydrate(body.track)] : []
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

    /* --------------------------- node-wide tools ------------------------ */

    if (['stream-errors', 'tts', 'logs', 'store'].includes(section)) {
      return systemRoutes({ req, res, url, seg, method, send, fail, readJson, config, store, tts, streamErrors })
    }

    /* --------------------------- node-wide tools ------------------------ */

    if (['stream-errors', 'tts', 'logs', 'store'].includes(section)) {
      return systemRoutes({ req, res, url, seg, method, send, fail, readJson, config, store, tts, streamErrors })
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
            'x-livy-effect': audio.report.effect,
            'x-livy-blend-ms': String(audio.report.blendMs)
          })
          return res.end(audio.mp3)
        } catch (error) {
          return fail(res, 400, `Could not render a preview: ${error.message}`)
        }
      }

      return fail(res, 405, 'Method not allowed')
    }

    return fail(res, 404, 'Unknown owner route')
  }
}

export default createOwnerRouter
