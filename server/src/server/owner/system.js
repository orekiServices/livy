/**
 * Node-wide owner tools: spoken stream errors, the voice, logs and database
 * maintenance. Split from the router because none of it touches a station.
 */
import createLogger, { tail, loggingState } from '../../util/logger.js'
import { REASONS, REASON_IDS, LINES, SHIPPED_LANGUAGES } from '../streamErrors.js'
import { normaliseLanguage } from '../../tts/index.js'

const log = createLogger('owner-system')

export async function systemRoutes({ req, res, url, seg, method, send, fail, readJson, config, store, tts, streamErrors }) {
  const [, , , section, id, action, param] = seg

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
    const text = String(body.text ?? '').trim() || `This is ${config.name ?? 'Livy'}, testing the ${language} voice.`

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
        'x-livy-tts': provider,
        'x-livy-fallback': String(Boolean(fellBack)),
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

  return false
}

export default systemRoutes
