/**
 * Now Playing — the plugin every broadcaster writes first.
 *
 * • keeps `data/now-playing.json` (all stations) and `data/now-playing.txt`
 *   (the tuned-in favourite, one line) up to date — point OBS, a website or a
 *   scrolling LED sign at them;
 * • POSTs the same payload to `settings.webhook` when one is configured;
 * • serves `GET /api/v1/x/now-playing/` and `/api/v1/x/now-playing/text`.
 *
 * It is also the reference for how a plugin should behave: no globals, all
 * work funnelled through the context, and a teardown that leaves nothing.
 */
import fs from 'node:fs'
import path from 'node:path'

export const manifest = {
  name: 'Now Playing',
  version: '1.2.0',
  description: 'now-playing file, webhook and public endpoint',
  // Per station: a station this is switched off for is left out of the file
  // and the webhook entirely (`ctx.stations` does not even show it).
  scope: 'stations'
}

const line = (track) => (track ? `${track.artist ?? 'Unknown'} — ${track.title ?? 'Unknown'}` : 'off air')

export default function setup(ctx) {
  const root = path.resolve(ctx.dir, '..', '..') // server/
  const jsonFile = path.resolve(root, ctx.settings.file ?? 'data/now-playing.json')
  const textFile = ctx.settings.text ? path.resolve(root, ctx.settings.text) : null
  const webhook = ctx.settings.webhook ?? null

  fs.mkdirSync(path.dirname(jsonFile), { recursive: true })

  /** Current snapshot, kept in memory so the endpoint is free. */
  let snapshot = { updatedAt: Date.now(), stations: [] }

  const collect = () =>
    ctx.stations.all().map((station) => {
      const np = station.nowPlaying()
      return {
        id: station.id,
        name: station.name,
        state: station.state,
        listeners: station.listeners,
        title: np?.track?.title ?? null,
        artist: np?.track?.artist ?? null,
        artwork: np?.track?.artwork ?? null,
        source: np?.track?.source ?? null,
        bitrate: np?.bitrate ?? null,
        startedAt: np?.startedAt ?? null,
        line: line(np?.track)
      }
    })

  let writeTimer = null
  const write = () => {
    // Coalesce bursts (a track change touches several events at once).
    clearTimeout(writeTimer)
    writeTimer = setTimeout(() => {
      snapshot = { updatedAt: Date.now(), stations: collect() }
      try {
        fs.writeFileSync(jsonFile, `${JSON.stringify(snapshot, null, 2)}\n`)
        if (textFile) {
          const first = snapshot.stations.find((s) => s.state === 'playing') ?? snapshot.stations[0]
          fs.writeFileSync(textFile, `${first?.line ?? 'off air'}\n`)
        }
      } catch (error) {
        ctx.log.warn(`could not write the now-playing file: ${error.message}`)
      }
    }, 150)
    writeTimer.unref?.()
  }

  const notify = async (station, track) => {
    if (!webhook) return
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ station: station.id, name: station.name, track: { title: track?.title, artist: track?.artist, artwork: track?.artwork }, at: Date.now() }),
        signal: AbortSignal.timeout(5000)
      })
      ctx.log.debug(`webhook ${res.status}`, { station: station.id })
    } catch (error) {
      ctx.log.warn(`webhook failed: ${error.message}`)
    }
  }

  ctx.on('track', ({ station, data }) => {
    const track = data?.track ?? data
    ctx.log.debug(`${station.id} ▸ ${line(track)}`)
    write()
    notify(station, track)
  })
  ctx.on('state', write)
  ctx.on('listeners', write)
  ctx.on('added', write)
  ctx.on('removed', write)
  ctx.stations.onScopeChange(write) // switched on/off for a station: rewrite now

  // A slow heartbeat keeps the file honest even if an event is missed.
  ctx.every(30_000, write)
  write()

  ctx.registerRoute('GET', '/', ({ res, send }) => {
    send(res, 200, { ...snapshot, stations: collect() })
    return true
  })

  ctx.registerRoute('GET', '/text', ({ res }) => {
    const stations = collect()
    const first = stations.find((s) => s.state === 'playing') ?? stations[0]
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`${first?.line ?? 'off air'}\n`)
    return true
  })

  ctx.log.info(`writing ${path.relative(root, jsonFile)}${webhook ? ' + webhook' : ''}`, {
    stations: `${ctx.stations.all().length}/${ctx.stations.every().length}`
  })

  return () => {
    clearTimeout(writeTimer)
  }
}
