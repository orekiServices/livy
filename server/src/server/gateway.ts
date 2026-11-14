/**
 * WebSocket gateway — one socket, everything the console needs to stay live.
 *
 *   /ws   control plane: now-playing, progress, queue, requests and stats push
 *
 * Ops in:  subscribe {stations}, stations, ping
 * Ops out: ready, track, progress, state, queue, requests, listeners, stats,
 *          announcement, stationAdded/Updated/Removed, pong
 */
import { WebSocketServer } from 'ws'
import createLogger from '../util/logger.ts'

const log = createLogger('gateway')

export class Gateway {
  declare clients: any
  declare config: any
  declare heartbeat: any
  declare manager: any
  declare statsTimer: any
  declare wss: any

  constructor({ server, manager, config }) {
    this.manager = manager
    this.config = config
    this.clients = new Set()
    this.wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname !== '/ws') return socket.destroy()
      this.wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws))
    })

    this.#wire()

    this.heartbeat = setInterval(() => {
      for (const ws of this.clients) {
        if (ws.isAlive === false) {
          ws.terminate()
          continue
        }
        ws.isAlive = false
        ws.ping()
      }
    }, 30_000).unref()

    this.statsTimer = setInterval(() => this.broadcast({ op: 'stats', data: manager.stats() }), 5000).unref()
  }

  #onConnection(ws) {
    ws.isAlive = true
    ws.filters = null
    this.clients.add(ws)
    log.debug(`client connected (${this.clients.size})`)

    ws.on('pong', () => {
      ws.isAlive = true
    })

    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return this.send(ws, { op: 'error', message: 'Invalid JSON' })
      }
      switch (msg.op) {
        case 'subscribe':
          ws.filters = Array.isArray(msg.stations) && msg.stations.length ? new Set(msg.stations) : null
          return this.send(ws, { op: 'subscribed', stations: ws.filters ? [...ws.filters] : 'all' })
        case 'stations':
          return this.send(ws, { op: 'stations', data: this.manager.list() })
        case 'ping':
          return this.send(ws, { op: 'pong', time: Date.now() })
        default:
          return this.send(ws, { op: 'error', message: `Unknown op "${msg.op}"` })
      }
    })

    ws.on('close', () => this.clients.delete(ws))
    ws.on('error', () => this.clients.delete(ws))

    this.send(ws, { op: 'ready', stations: this.manager.list(), stats: this.manager.stats() })
  }

  #wire() {
    const m = this.manager
    m.on('track', (station, nowPlaying) => this.broadcast({ op: 'track', station: station.id, data: nowPlaying }, station.id))
    m.on('progress', (station, progress) =>
      this.broadcast({ op: 'progress', station: station.id, data: { positionMs: progress.positionMs, trackId: progress.track.id } }, station.id)
    )
    m.on('state', (station, state) => this.broadcast({ op: 'state', station: station.id, data: { state, info: station.info() } }, station.id))
    m.on('queue', (station, queue) =>
      this.broadcast({ op: 'queue', station: station.id, data: { length: queue.length, upNext: queue.slice(0, 5) } }, station.id)
    )
    m.on('requests', (station, requests) =>
      this.broadcast(
        { op: 'requests', station: station.id, data: { count: requests.length, requests: station.publicRequests().slice(0, 10) } },
        station.id
      )
    )
    m.on('announcement', (station, track) =>
      this.broadcast({ op: 'announcement', station: station.id, data: { title: track.title, text: track.text ?? null } }, station.id)
    )
    m.on('voteskip', (station, data) => this.broadcast({ op: 'voteskip', station: station.id, data }, station.id))
    m.on('listeners', (station, listeners) => this.broadcast({ op: 'listeners', station: station.id, data: { listeners } }, station.id))
    m.on('added', (station) => this.broadcast({ op: 'stationAdded', station: station.id, data: station.info() }))
    m.on('updated', (station) => this.broadcast({ op: 'stationUpdated', station: station.id, data: station.info() }))
    m.on('removed', (station) => this.broadcast({ op: 'stationRemoved', station: station.id }))
    m.on('stationError', (station, error) => this.broadcast({ op: 'stationError', station: station.id, data: { message: error.message } }))
  }

  send(ws, payload) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload))
  }

  broadcast(payload, stationId: any = null) {
    const data = JSON.stringify(payload)
    for (const ws of this.clients) {
      if (stationId && ws.filters && !ws.filters.has(stationId)) continue
      if (ws.readyState === ws.OPEN) ws.send(data)
    }
  }

  close() {
    clearInterval(this.heartbeat)
    clearInterval(this.statsTimer)
    for (const ws of this.clients) ws.close(1001, 'shutdown')
    this.wss.close()
  }
}

export default Gateway
