/**
 * Two-tier cache for Livy:
 *
 *   1. Bounded in-memory LRU + TTL caches (`resolve`, `search`, `trackUrl`)
 *      with in-flight promise coalescing so concurrent callers for the same
 *      query or signed stream URL hit the upstream provider once instead of
 *      creating a thundering herd.
 *
 *   2. Bounded atomic on-disk MP3 audio cache (`AudioDiskCache`) storing
 *      cleanly framed, pre-filter MP3 tracks under `<cacheDir>/audio/`.
 *      Tracks are written to a unique `.tmp` file and atomically renamed only
 *      after natural EOF with > 0 frames, so skipped or errored streams never
 *      leave partial audio on disk.
 *
 * Both tiers degrade gracefully: if the disk directory is read-only or audio
 * caching is disabled (for example on a read-only container), the memory tier
 * stays active and audio caching reports `enabled: false, writable: false`.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import createLogger from '../util/logger.ts'

const log = createLogger('cache')

const MB = 1024 * 1024

export const DEFAULT_CACHE = {
  enabled: true,
  memory: {
    resolveTtlMs: 10 * 60_000,
    resolveMaxEntries: 500,
    searchTtlMs: 3 * 60_000,
    searchMaxEntries: 300,
    trackUrlTtlMs: 4 * 60_000,
    trackUrlMaxEntries: 500
  },
  audio: {
    enabled: true,
    dir: '',
    maxBytes: 512 * MB,
    maxEntries: 250,
    maxEntryBytes: 32 * MB,
    ttlMs: 7 * 24 * 60 * 60_000
  }
}

function safeClone(value) {
  if (value === null || value === undefined || typeof value !== 'object') return value
  try {
    return structuredClone(value)
  } catch {
    if (Array.isArray(value)) return value.map((item) => (item && typeof item === 'object' ? { ...item } : item))
    return { ...value }
  }
}

function hitRate(hits, misses) {
  const total = hits + misses
  return total === 0 ? 0 : Number((hits / total).toFixed(4))
}

/* ----------------------------- memory LRU ----------------------------- */

export class MemoryLruCache {
  declare _inflight: any
  declare _map: any
  declare _stats: any
  declare enabled: any
  declare maxEntries: any
  declare name: any
  declare ttlMs: any

  constructor({ name = 'memory', ttlMs = 5 * 60_000, maxEntries = 300, enabled = true }: any = {}) {
    this.name = name
    this.ttlMs = Math.max(0, Number(ttlMs) || 0)
    this.maxEntries = Math.max(1, Number(maxEntries) || 300)
    this.enabled = enabled !== false && this.ttlMs > 0
    /** @type {Map<string, { value: any, expiresAt: number, createdAt: number }>} */
    this._map = new Map()
    /** @type {Map<string, Promise<any>>} */
    this._inflight = new Map()
    this._stats = { hits: 0, misses: 0, coalesced: 0, sets: 0, evictions: 0, expired: 0 }
  }

  get(key) {
    if (!this.enabled) return undefined
    const k = String(key)
    const entry = this._map.get(k)
    if (!entry) {
      this._stats.misses += 1
      return undefined
    }
    if (Date.now() >= entry.expiresAt) {
      this._map.delete(k)
      this._stats.expired += 1
      this._stats.misses += 1
      return undefined
    }
    // Refresh LRU order: delete + re-insert moves the entry to the tail.
    this._map.delete(k)
    this._map.set(k, entry)
    this._stats.hits += 1
    return safeClone(entry.value)
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (!this.enabled) return
    const ttl = Math.max(0, Number(ttlMs) || 0)
    if (ttl === 0) return
    const k = String(key)
    const now = Date.now()
    if (this._map.has(k)) this._map.delete(k)
    this._map.set(k, { value: safeClone(value), createdAt: now, expiresAt: now + ttl })
    this._stats.sets += 1
    while (this._map.size > this.maxEntries) {
      const oldest = this._map.keys().next().value
      this._map.delete(oldest)
      this._stats.evictions += 1
    }
  }

  delete(key) {
    return this._map.delete(String(key))
  }

  clear() {
    const count = this._map.size
    this._map.clear()
    this._inflight.clear()
    return count
  }

  prune() {
    const now = Date.now()
    let removed = 0
    for (const [key, entry] of this._map) {
      if (now >= entry.expiresAt) {
        this._map.delete(key)
        this._stats.expired += 1
        removed += 1
      }
    }
    return removed
  }

  /**
   * Look up `key`; on miss, run `loader()` once even when multiple callers ask
   * for the same key simultaneously. Failed promises are never cached.
   */
  async getOrLoad(key, loader, { ttlMs = this.ttlMs, shouldCache = (v) => v != null }: any = {}) {
    if (!this.enabled) return loader()
    const k = String(key)
    const hit = this.get(k)
    if (hit !== undefined) return hit

    const pending = this._inflight.get(k)
    if (pending) {
      this._stats.coalesced += 1
      return safeClone(await pending)
    }

    const task = Promise.resolve()
      .then(() => loader())
      .then((value) => {
        if (shouldCache(value)) this.set(k, value, ttlMs)
        return value
      })
      .finally(() => {
        if (this._inflight.get(k) === task) this._inflight.delete(k)
      })

    this._inflight.set(k, task)
    return safeClone(await task)
  }

  stats() {
    return {
      name: this.name,
      enabled: this.enabled,
      entries: this._map.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      inflight: this._inflight.size,
      hits: this._stats.hits,
      misses: this._stats.misses,
      coalesced: this._stats.coalesced,
      sets: this._stats.sets,
      evictions: this._stats.evictions,
      expired: this._stats.expired,
      hitRate: hitRate(this._stats.hits, this._stats.misses)
    }
  }
}

/* -------------------------- disk audio cache -------------------------- */

const SAFE_HASH = /^[a-f0-9]{16,64}$/i

/** Canonical cache identity for a playable, cacheable track. */
export function audioCacheKey(track, bitrate = 128) {
  if (!track || typeof track !== 'object') return null
  if (track.live || track.announcement || track.metadataOnly) return null
  if (track.source === 'tts' || track.source === 'local') return null
  const identity = track.id || (track.source && (track.link || track.url || track.title) ? `${track.source}:${track.link ?? track.url ?? track.title}` : null)
  if (!identity) return null
  const kbps = Math.max(32, Math.round(Number(bitrate) || 128))
  return `mp3:${kbps}:${identity}`
}

export function hashKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 32)
}

export class AudioDiskCache {
  declare _activeWrites: any
  declare _index: any
  declare _stats: any
  declare _totalBytes: any
  declare dir: any
  declare enabled: any
  declare maxBytes: any
  declare maxEntries: any
  declare maxEntryBytes: any
  declare ttlMs: any
  declare writable: any

  constructor(options: any = {}) {
    const cfg = { ...DEFAULT_CACHE.audio, ...options }
    this.dir = cfg.dir ? path.resolve(cfg.dir) : ''
    this.maxBytes = Math.max(MB, Number(cfg.maxBytes) || DEFAULT_CACHE.audio.maxBytes)
    this.maxEntries = Math.max(1, Number(cfg.maxEntries) || DEFAULT_CACHE.audio.maxEntries)
    this.maxEntryBytes = Math.max(64 * 1024, Number(cfg.maxEntryBytes) || DEFAULT_CACHE.audio.maxEntryBytes)
    this.ttlMs = Math.max(60_000, Number(cfg.ttlMs) || DEFAULT_CACHE.audio.ttlMs)
    this.enabled = cfg.enabled !== false && Boolean(this.dir)
    this.writable = false
    /** @type {Map<string, object>} ordered oldest -> newest access */
    this._index = new Map()
    this._totalBytes = 0
    this._activeWrites = new Set()
    this._stats = { hits: 0, misses: 0, writes: 0, evictions: 0, skipped: 0, errors: 0 }

    if (this.enabled) this._init()
  }

  _init() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.accessSync(this.dir, fs.constants.R_OK | fs.constants.W_OK)
      this.writable = true
    } catch (error) {
      this.enabled = false
      this.writable = false
      log.warn(`audio cache disabled (unwritable dir): ${error.message}`)
      return
    }
    this._scan()
  }

  _mp3Path(hash) {
    return path.join(this.dir, `${hash}.mp3`)
  }

  _metaPath(hash) {
    return path.join(this.dir, `${hash}.json`)
  }

  _scan() {
    this._index.clear()
    this._totalBytes = 0
    let files = []
    try {
      files = fs.readdirSync(this.dir)
    } catch {
      return
    }

    const found = []
    const now = Date.now()
    for (const file of files) {
      const full = path.join(this.dir, file)
      if (file.endsWith('.tmp')) {
        try { fs.unlinkSync(full) } catch { /* ignore */ }
        continue
      }
      if (!file.endsWith('.json')) continue
      const hash = file.slice(0, -5)
      if (!SAFE_HASH.test(hash)) continue
      try {
        const mp3 = this._mp3Path(hash)
        const stat = fs.statSync(mp3)
        if (!stat.isFile() || stat.size === 0) {
          this._unlinkPair(hash)
          continue
        }
        const meta = JSON.parse(fs.readFileSync(full, 'utf8'))
        const createdAt = Number(meta.createdAt) || stat.mtimeMs
        const accessedAt = Number(meta.accessedAt) || createdAt
        if (now - createdAt >= this.ttlMs) {
          this._unlinkPair(hash)
          continue
        }
        found.push({
          hash,
          key: String(meta.key ?? ''),
          trackId: String(meta.trackId ?? ''),
          title: String(meta.title ?? ''),
          artist: String(meta.artist ?? ''),
          source: String(meta.source ?? ''),
          bitrate: Number(meta.bitrate) || 128,
          bytes: stat.size,
          createdAt,
          accessedAt,
          hits: Number(meta.hits) || 0
        })
      } catch {
        this._unlinkPair(hash)
      }
    }

    // Oldest accessed first so Map iteration order is LRU -> MRU.
    found.sort((a, b) => a.accessedAt - b.accessedAt)
    for (const entry of found) {
      this._index.set(entry.hash, entry)
      this._totalBytes += entry.bytes
    }

    // Remove orphan .mp3 files without sidecar metadata.
    for (const file of files) {
      if (!file.endsWith('.mp3')) continue
      const hash = file.slice(0, -4)
      if (!this._index.has(hash)) {
        try { fs.unlinkSync(path.join(this.dir, file)) } catch { /* ignore */ }
      }
    }

    this._evict()
  }

  _unlinkPair(hash) {
    try { fs.unlinkSync(this._mp3Path(hash)) } catch { /* ignore */ }
    try { fs.unlinkSync(this._metaPath(hash)) } catch { /* ignore */ }
  }

  _evict() {
    const now = Date.now()
    for (const [hash, entry] of [...this._index.entries()]) {
      if (now - entry.createdAt >= this.ttlMs) {
        this._removeEntry(hash, true)
      }
    }
    while (this._index.size > this.maxEntries || this._totalBytes > this.maxBytes) {
      const oldest = this._index.keys().next().value
      if (!oldest) break
      this._removeEntry(oldest, true)
    }
  }

  _removeEntry(hash, countAsEviction = false) {
    const entry = this._index.get(hash)
    if (!entry) return false
    this._index.delete(hash)
    this._totalBytes = Math.max(0, this._totalBytes - entry.bytes)
    this._unlinkPair(hash)
    if (countAsEviction) this._stats.evictions += 1
    return true
  }

  /** Look up a track in the disk cache without opening a file descriptor. */
  get(track, bitrate = 128) {
    if (!this.enabled) return null
    const rawKey = audioCacheKey(track, bitrate)
    if (!rawKey) return null
    const hash = hashKey(rawKey)
    const entry = this._index.get(hash)
    if (!entry) {
      this._stats.misses += 1
      return null
    }
    const file = this._mp3Path(hash)
    if (Date.now() - entry.createdAt >= this.ttlMs || !fs.existsSync(file)) {
      this._removeEntry(hash, false)
      this._stats.misses += 1
      return null
    }

    entry.accessedAt = Date.now()
    entry.hits += 1
    this._index.delete(hash)
    this._index.set(hash, entry)
    this._stats.hits += 1
    return { file, hash, bytes: entry.bytes, entry: { ...entry } }
  }

  /** Open a readable stream for a cached track, or return null on miss. */
  openReadStream(track, bitrate = 128) {
    const hit = this.get(track, bitrate)
    if (!hit) return null
    try {
      const stream = fs.createReadStream(hit.file)
      return { stream, hash: hit.hash, bytes: hit.bytes, entry: hit.entry }
    } catch (error) {
      this._stats.errors += 1
      this._removeEntry(hit.hash, false)
      log.debug(`audio cache read failed for ${hit.hash}: ${error.message}`)
      return null
    }
  }

  /**
   * Open an atomic writer for a track being streamed live from an upstream
   * source. Call `write(mp3FrameBuffer)` for each framed MP3 chunk, then
   * `commit()` ONLY on clean natural EOF, or `abort()` on skip/error.
   */
  createWriter(track, bitrate = 128) {
    if (!this.enabled || !this.writable) return null
    const rawKey = audioCacheKey(track, bitrate)
    if (!rawKey) return null
    const hash = hashKey(rawKey)
    if (this._activeWrites.has(hash)) return null

    const nonce = crypto.randomBytes(6).toString('hex')
    const tmpPath = path.join(this.dir, `${hash}.${nonce}.tmp`)
    let fd = null
    try {
      fd = fs.openSync(tmpPath, 'w')
    } catch (error) {
      this._stats.errors += 1
      log.debug(`audio cache open tmp failed: ${error.message}`)
      return null
    }

    this._activeWrites.add(hash)
    let bytes = 0
    let closed = false
    let failed = false

    const cleanupTmp = () => {
      if (fd !== null) {
        try { fs.closeSync(fd) } catch { /* ignore */ }
        fd = null
      }
      try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
      this._activeWrites.delete(hash)
    }

    const abort = () => {
      if (closed) return
      closed = true
      failed = true
      cleanupTmp()
    }

    const write = (chunk) => {
      if (closed || failed || !chunk || chunk.length === 0) return false
      if (bytes + chunk.length > this.maxEntryBytes) {
        this._stats.skipped += 1
        abort()
        return false
      }
      try {
        fs.writeSync(fd, chunk)
        bytes += chunk.length
        return true
      } catch (error) {
        this._stats.errors += 1
        log.debug(`audio cache write failed: ${error.message}`)
        abort()
        return false
      }
    }

    const commit = () => {
      if (closed || failed) return null
      closed = true
      if (bytes === 0) {
        cleanupTmp()
        return null
      }
      try {
        fs.closeSync(fd)
        fd = null
        const target = this._mp3Path(hash)
        fs.renameSync(tmpPath, target)
        const now = Date.now()
        const entry = {
          hash,
          key: rawKey,
          trackId: String(track.id ?? ''),
          title: String(track.title ?? '').slice(0, 180),
          artist: String(track.artist ?? '').slice(0, 140),
          source: String(track.source ?? ''),
          bitrate: Math.max(32, Math.round(Number(bitrate) || 128)),
          bytes,
          createdAt: now,
          accessedAt: now,
          hits: 0
        }
        fs.writeFileSync(this._metaPath(hash), JSON.stringify(entry))

        const prev = this._index.get(hash)
        if (prev) this._totalBytes = Math.max(0, this._totalBytes - prev.bytes)
        this._index.delete(hash)
        this._index.set(hash, entry)
        this._totalBytes += bytes
        this._stats.writes += 1
        this._activeWrites.delete(hash)
        this._evict()
        return { ...entry }
      } catch (error) {
        this._stats.errors += 1
        log.debug(`audio cache commit failed: ${error.message}`)
        cleanupTmp()
        return null
      }
    }

    return { hash, write, commit, abort, get bytes() { return bytes } }
  }

  delete(hash) {
    if (!SAFE_HASH.test(String(hash ?? ''))) return false
    return this._removeEntry(String(hash), false)
  }

  clear() {
    const count = this._index.size
    for (const hash of [...this._index.keys()]) {
      this._removeEntry(hash, false)
    }
    this._totalBytes = 0
    return count
  }

  list(limit = 50) {
    const cap = Math.max(1, Math.min(250, Number(limit) || 50))
    return [...this._index.values()]
      .reverse()
      .slice(0, cap)
      .map((entry) => ({
        hash: entry.hash,
        trackId: entry.trackId,
        title: entry.title,
        artist: entry.artist,
        source: entry.source,
        bitrate: entry.bitrate,
        bytes: entry.bytes,
        createdAt: entry.createdAt,
        accessedAt: entry.accessedAt,
        hits: entry.hits
      }))
  }

  stats() {
    return {
      enabled: this.enabled,
      writable: this.writable,
      entries: this._index.size,
      maxEntries: this.maxEntries,
      bytes: this._totalBytes,
      maxBytes: this.maxBytes,
      maxEntryBytes: this.maxEntryBytes,
      ttlMs: this.ttlMs,
      hits: this._stats.hits,
      misses: this._stats.misses,
      writes: this._stats.writes,
      evictions: this._stats.evictions,
      skipped: this._stats.skipped,
      errors: this._stats.errors,
      hitRate: hitRate(this._stats.hits, this._stats.misses)
    }
  }
}

/* ----------------------------- unified facade ----------------------------- */

export class RadioCache {
  declare audio: any
  declare enabled: any
  declare resolve: any
  declare search: any
  declare trackUrl: any

  constructor(config: any = {}, { defaultDir = '' }: any = {}) {
    const enabled = config.enabled !== false
    const mem = { ...DEFAULT_CACHE.memory, ...(config.memory ?? {}) }
    const audioCfg = { ...DEFAULT_CACHE.audio, ...(config.audio ?? {}) }
    const audioDir = audioCfg.dir || (defaultDir ? path.join(defaultDir, 'audio') : '')

    this.enabled = enabled
    this.resolve = new MemoryLruCache({
      name: 'resolve',
      ttlMs: mem.resolveTtlMs,
      maxEntries: mem.resolveMaxEntries,
      enabled
    })
    this.search = new MemoryLruCache({
      name: 'search',
      ttlMs: mem.searchTtlMs,
      maxEntries: mem.searchMaxEntries,
      enabled
    })
    this.trackUrl = new MemoryLruCache({
      name: 'trackUrl',
      ttlMs: mem.trackUrlTtlMs,
      maxEntries: mem.trackUrlMaxEntries,
      enabled
    })
    this.audio = new AudioDiskCache({
      ...audioCfg,
      dir: audioDir,
      enabled: enabled && audioCfg.enabled !== false
    })
  }

  clear(scope = 'all') {
    const s = String(scope || 'all').toLowerCase()
    const cleared: Record<string, any> = {}
    if (s === 'all' || s === 'memory' || s === 'resolve') cleared.resolve = this.resolve.clear()
    if (s === 'all' || s === 'memory' || s === 'search') cleared.search = this.search.clear()
    if (s === 'all' || s === 'memory' || s === 'trackurl' || s === 'track-url') cleared.trackUrl = this.trackUrl.clear()
    if (s === 'all' || s === 'audio') cleared.audio = this.audio.clear()
    return cleared
  }

  evictAudio(hash) {
    return this.audio.delete(hash)
  }

  listAudio(limit = 50) {
    return this.audio.list(limit)
  }

  stats() {
    const resolve = this.resolve.stats()
    const search = this.search.stats()
    const trackUrl = this.trackUrl.stats()
    const audio = this.audio.stats()
    const totalHits = resolve.hits + search.hits + trackUrl.hits + audio.hits
    const totalMisses = resolve.misses + search.misses + trackUrl.misses + audio.misses
    return {
      enabled: this.enabled,
      totalHits,
      totalMisses,
      hitRate: hitRate(totalHits, totalMisses),
      memory: { resolve, search, trackUrl },
      audio
    }
  }
}

export default RadioCache
