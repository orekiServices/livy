/**
 * Live relay — the reference for `ctx.relay()`.
 *
 * Point a station at any live feed — a sister station, a guest DJ's encoder,
 * an HLS playlist, a file on disk — and it goes on air as it arrives.
 *
 * MetroS decides what happens to the bytes: an MP3 feed is forwarded
 * untouched, and AAC, HLS/MPEG-TS, Ogg, FLAC or MP4 are decoded and
 * re-encoded on the way past (which needs the native libmetro engine). The
 * rotation waits while the relay runs and resumes the moment it ends.
 *
 * Ships **disabled**, because a plugin that grabs the transmitter should be
 * something you switch on deliberately.
 *
 *   PATCH /api/v1/owner/plugins/live-relay  { "settings": { "url": "https://…" } }
 *   POST  /api/v1/x/live-relay/start/:station
 *   POST  /api/v1/x/live-relay/stop/:station
 *   GET   /api/v1/x/live-relay/
 */
import fs from 'node:fs'

export const manifest = {
  name: 'Live relay',
  version: '1.0.0',
  description: 'relay a live MP3 feed onto a station through MetroS',
  scope: 'stations'
}

/**
 * Open a feed. A URL is handed to the station as-is — it knows how to
 * follow an HLS playlist and how to open a socket — and anything else is
 * read from disk.
 */
function open(source) {
  if (/^https?:\/\//i.test(source)) return source
  if (!fs.existsSync(source)) throw new Error(`no such file: ${source}`)
  return fs.createReadStream(source)
}

export default function setup(ctx) {
  /** station id → relay handle */
  const live = new Map()

  const settingsFor = (stationId) => ctx.stations.settings(stationId)

  async function start(stationId) {
    const settings = settingsFor(stationId)
    const url = settings.url
    if (!url) throw new Error('no url configured for this station')

    stop(stationId, 'restarting')

    const feed = open(url)
    const handle = ctx.relay(stationId, feed, {
      title: settings.title ?? 'Live relay',
      artist: settings.artist ?? undefined,
      bitrate: settings.bitrate ?? 128
    })
    live.set(stationId, { handle, url })

    handle.done.then((stats) => {
      live.delete(stationId)
      ctx.log.info(
        `${stationId}: relay ended after ${Math.round(stats.durationMs / 1000)}s (${stats.frames} frames, ${stats.codec ?? 'mp3'}, ${stats.engine})`
      )
      // A dropped feed is normal on the internet; come back unless the owner
      // asked it to stop.
      if (settings.reconnect !== false && stats.reason === 'stream ended') {
        setTimeout(() => start(stationId).catch((error) => ctx.log.warn(`${stationId}: reconnect failed: ${error.message}`)), 5000)
      }
    })

    ctx.log.info(`${stationId}: relaying ${url}`)
    return handle
  }

  function stop(stationId, reason = 'stopped by owner') {
    const current = live.get(stationId)
    if (!current) return false
    current.handle.stop(reason)
    live.delete(stationId)
    return true
  }

  const status = () => ({
    engine: ctx.config.engine ?? undefined,
    relaying: [...live.entries()].map(([station, { handle, url }]) => ({ station, url, ...handle.stats() })),
    stations: ctx.stations.list().map((s) => ({ id: s.id, url: settingsFor(s.id).url || null }))
  })

  ctx.registerRoute('GET', '/', ({ res, send }) => send(res, 200, status()))

  ctx.registerRoute('POST', '/start/:station', async ({ res, send, fail, params, owner }) => {
    if (!owner) return fail(res, 403, 'The owner key is required')
    try {
      const handle = await start(params.station)
      return send(res, 200, { started: params.station, stats: handle.stats() })
    } catch (error) {
      return fail(res, 400, error.message)
    }
  })

  ctx.registerRoute('POST', '/stop/:station', ({ res, send, fail, owner, params }) => {
    if (!owner) return fail(res, 403, 'The owner key is required')
    return send(res, 200, { stopped: stop(params.station) })
  })

  // A station that is switched off mid-relay hands the transmitter back.
  ctx.stations.onScopeChange(({ station, enabled }) => {
    if (!enabled) stop(station, 'plugin switched off for this station')
  })

  // Autostart anything already configured with `"autostart": true`.
  for (const station of ctx.stations.list()) {
    if (settingsFor(station.id).autostart) {
      start(station.id).catch((error) => ctx.log.warn(`${station.id}: ${error.message}`))
    }
  }

  return () => {
    for (const stationId of [...live.keys()]) stop(stationId, 'plugin unloaded')
  }
}
