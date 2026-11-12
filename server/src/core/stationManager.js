/**
 * Station registry + shared event bus. One process, many stations.
 */
import { EventEmitter } from 'node:events'
import Station from './station.js'
import createLogger from '../util/logger.js'

const log = createLogger('stations')

export class StationManager extends EventEmitter {
  constructor({ defaults = {}, sources, store = null, tts = null, memory = null, smartQueue = null }) {
    super()
    this.setMaxListeners(0)
    this.defaults = defaults
    this.sources = sources
    this.store = store
    this.tts = tts
    // Handed to every station: what it remembers across a restart, and
    // where it finds the next track when nobody queued one.
    this.memory = memory
    this.smartQueue = smartQueue
    this.stations = new Map()
  }

  add(config) {
    const id = String(config.id ?? config.name ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
    if (!id) throw new Error('Station needs an id or name')
    if (this.stations.has(id)) throw new Error(`Station "${id}" already exists`)

    const station = new Station({ ...this.defaults, ...config, id }, this.sources, {
      store: this.store,
      tts: this.tts,
      memory: this.memory,
      smartQueue: this.smartQueue
    })
    this.stations.set(id, station)

    for (const event of ['state', 'track', 'progress', 'queue', 'listeners', 'empty', 'requests', 'voteskip', 'announcement', 'call']) {
      station.on(event, (...args) => this.emit(event, station, ...args))
    }
    station.on('error', (error) => this.emit('stationError', station, error))

    if (config.persist !== false && config._owned) {
      try {
        this.store?.saveStation({ ...config, id })
      } catch (error) {
        log.warn(`could not persist station "${id}": ${error.message}`)
      }
    }

    this.emit('added', station)
    log.info(`registered "${id}" (${station.playlists.length} playlist source(s))`)
    return station
  }

  get(id) {
    return this.stations.get(String(id ?? '').toLowerCase())
  }

  find(query) {
    if (!query) return undefined
    const q = String(query).trim().toLowerCase()
    return (
      this.get(q) ??
      [...this.stations.values()].find((s) => s.name.toLowerCase() === q) ??
      [...this.stations.values()].find((s) => s.name.toLowerCase().includes(q) || s.id.includes(q))
    )
  }

  remove(id) {
    const station = this.get(id)
    if (!station) return false
    this.store?.deleteStation(station.id)
    station.destroy()
    this.stations.delete(station.id)
    this.emit('removed', station)
    return true
  }

  update(id, patch) {
    const station = this.get(id)
    if (!station) return undefined
    station.name = patch.name ?? station.name
    station.genre = patch.genre ?? station.genre
    station.description = patch.description ?? station.description
    station.artwork = patch.artwork ?? station.artwork
    if (patch.playlists) station.playlists = patch.playlists
    station.options = { ...station.options, ...patch }
    this.emit('updated', station)
    return station
  }

  list(options) {
    return [...this.stations.values()].map((s) => s.info(options))
  }

  get size() {
    return this.stations.size
  }

  stats() {
    const stations = [...this.stations.values()]
    return {
      stations: stations.length,
      playing: stations.filter((s) => s.state === 'playing').length,
      listeners: stations.reduce((n, s) => n + s.listeners, 0),
      tracksPlayed: stations.reduce((n, s) => n + s.stats.tracksPlayed, 0),
      bytesOut: stations.reduce((n, s) => n + s.stats.bytesOut, 0),
      queued: stations.reduce((n, s) => n + s.queue.length, 0),
      requests: stations.reduce((n, s) => n + s.requests.length, 0),
      requestsPlayed: stations.reduce((n, s) => n + s.stats.requestsPlayed, 0),
      upgrades: stations.reduce((n, s) => n + s.stats.upgrades, 0),
      fallbacks: stations.reduce((n, s) => n + s.stats.fallbacks, 0)
    }
  }

  stopAll() {
    for (const station of this.stations.values()) station.destroy()
    this.stations.clear()
  }
}

export default StationManager
