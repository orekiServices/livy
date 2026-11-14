/**
 * Persistence — one SQLite file per node.
 *
 * Every Livy node now stores state in **SQLite3**: stations the owner
 * created, the request line, one-vote-per-listener constraints, play history,
 * bans, plugin state and settings. One file you can copy, back up, inspect
 * with `sqlite3` and upgrade in place:
 *
 *   bun scripts/db.js info | migrate | vacuum | backup <file> | export
 *
 * The driver is MetroDB (Rust) when a binary is there, and `bun:sqlite`
 * otherwise — same engine, same file, same SQL. There is no JSON fallback any more: an older
 * node's `radio.db.json` is imported once and retired (see `importJson`), so
 * upgrading is nothing but starting the new version.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import createLogger from '../util/logger.ts'
import { migrate, LATEST_VERSION } from './migrations.ts'
import { adoptLegacyFile, disabled, openDatabase, openMemoryDatabase } from './driver.ts'
import { modelRepo } from './models.ts'

const log = createLogger('store')

/** JSON column → object; a corrupt value is an empty object, never a throw. */
const parseJson = (value, fallback: any = {}) => {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

export interface Store extends Pick<typeof modelRepo, keyof typeof modelRepo> {}

export class Store {
  declare db: any
  declare file: any
  declare migration: any

  /**
   * @param {string} file  path to the SQLite database (created if missing)
   * @param {{ migrate?: boolean }} [options]
   */
  static async open(file, { migrate: runMigrations = true, memory = false }: any = {}) {
    // Memory driver: for a serverless function, where the bundle is read-only
    // and `/tmp` dies with the instance. The schema is created in-memory and
    // the store says `driver: 'memory (...)'`, so `/api/v1/info` can tell the
    // owner the truth instead of pretending to have saved something.
    const db = memory ? await openMemoryDatabase() : await (async () => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      adoptLegacyFile(file)
      return openDatabase(file)
    })()
    const store = new Store(db, memory ? ':memory:' : file)

    if (runMigrations) {
      const result = migrate(db, { log })
      store.migration = result
      if (result.applied.length) log.info(`database upgraded v${result.from} → v${result.to}`, { migrations: result.applied.length })
    }

    const imported = store.importJson()
    log.info(`persistence: ${db.driver} · schema v${store.schemaVersion}`, {
      file,
      ...(imported ? { imported } : {})
    })
    return store
  }

  constructor(db, file) {
    this.db = db
    this.file = file
    this.migration = { from: LATEST_VERSION, to: LATEST_VERSION, applied: [] }
  }

  get driver() {
    return this.db.driver
  }

  get schemaVersion() {
    return this.db.get('PRAGMA user_version')?.user_version ?? 0
  }

  /* --------------------------- legacy import -------------------------- */

  /**
   * Adopt a pre-SQLite node: if a JSON store sits next to the database and we
   * have not imported it before, copy every row in and rename the file to
   * `.imported`. Runs once, silently does nothing afterwards.
   *
   * Both the current name (`livy.json`) and the one older nodes used
   * (`nodecast.json`, `radio.db.json`) are looked for, in that order.
   */
  importJson(jsonFile: any = null) {
    if (!jsonFile) {
      const base = this.file.replace(/\.(db|sqlite3?)$/i, '')
      const dir = path.dirname(this.file)
      const candidates = [`${base}.json`, ...['livy.json', 'nodecast.json', 'radio.db.json'].map((name) => path.join(dir, name))]
      jsonFile = candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
    }
    if (this.file === ':memory:') return null
    if (!fs.existsSync(jsonFile) || this.get('legacy.jsonImported')) return null

    let data
    try {
      data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
    } catch (error) {
      log.warn(`legacy JSON store could not be read: ${error.message}`)
      return null
    }

    const counts = { stations: 0, requests: 0, votes: 0, plays: 0, bans: 0, settings: 0 }
    this.db.transaction(() => {
      for (const row of data.stations ?? []) {
        this.db.run(
          'INSERT OR IGNORE INTO stations (id, config, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          [row.id, row.config, row.created_by ?? 'legacy', row.created_at ?? Date.now(), row.updated_at ?? Date.now()]
        )
        counts.stations += 1
      }
      for (const row of data.requests ?? []) {
        this.db.run(
          `INSERT OR IGNORE INTO requests (id, station_id, track, title, by, requester_id, votes, status, created_at, played_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.id, row.station_id, row.track, row.title, row.by, row.requester_id, row.votes ?? 0, row.status ?? 'pending', row.created_at ?? Date.now(), row.played_at ?? null]
        )
        counts.requests += 1
      }
      for (const row of data.votes ?? []) {
        this.db.run('INSERT OR IGNORE INTO votes (station_id, request_id, voter, created_at) VALUES (?, ?, ?, ?)', [
          row.station_id,
          row.request_id,
          row.voter,
          row.created_at ?? Date.now()
        ])
        counts.votes += 1
      }
      for (const row of data.plays ?? []) {
        this.db.run(
          `INSERT INTO plays (station_id, track_id, title, artist, source, bitrate, requested_by, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.station_id, row.track_id, row.title, row.artist, row.source, row.bitrate ?? null, row.requested_by ?? null, row.started_at ?? Date.now()]
        )
        counts.plays += 1
      }
      for (const row of data.bans ?? []) {
        this.db.run('INSERT OR REPLACE INTO bans (voter, reason, created_at) VALUES (?, ?, ?)', [row.voter, row.reason ?? '', row.created_at ?? Date.now()])
        counts.bans += 1
      }
      for (const row of data.settings ?? []) {
        this.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [row.key, row.value])
        counts.settings += 1
      }
      this.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['legacy.jsonImported', JSON.stringify(Date.now())])
    })

    try {
      fs.renameSync(jsonFile, `${jsonFile}.imported`)
    } catch {
      /* keeping the original is harmless — the settings flag stops a re-import */
    }
    log.info('imported a legacy JSON store into SQLite', counts)
    return counts
  }

  /* ----------------------------- stations ---------------------------- */

  saveStation(config, createdBy = 'owner') {
    const now = Date.now()
    this.db.run(
      `INSERT INTO stations (id, config, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
      [config.id, JSON.stringify(config), createdBy, now, now]
    )
    return config
  }

  listStations() {
    return this.db
      .all('SELECT * FROM stations WHERE enabled = 1 ORDER BY position, created_at')
      .map((row) => ({ ...JSON.parse(row.config), _createdBy: row.created_by, _createdAt: row.created_at }))
  }

  deleteStation(id) {
    // Per-station plugin choices die with the station, or they would silently
    // apply again to a new station that happens to reuse the id.
    this.db.run('DELETE FROM station_plugins WHERE station_id = ?', [id])
    return this.db.run('DELETE FROM stations WHERE id = ?', [id]).changes > 0
  }

  /* ----------------------------- requests ---------------------------- */

  /**
   * Insert a request. `votes` starts at zero on purpose: the requester's own
   * vote is a row in `votes` like everyone else's, so it can never be
   * double-counted.
   */
  saveRequest({ id, stationId, track, by, requesterId, votes = 0 }) {
    const rowId = id ?? randomUUID().slice(0, 8)
    this.db.run(
      `INSERT INTO requests (id, station_id, track, title, by, requester_id, votes, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        rowId,
        stationId,
        JSON.stringify(track),
        `${track.artist ?? ''} - ${track.title ?? ''}`.trim(),
        by,
        requesterId,
        votes,
        Date.now()
      ]
    )
    return rowId
  }

  /** @returns {boolean} false when this voter already voted (UNIQUE constraint) */
  addVote({ stationId, requestId, voter }) {
    try {
      this.db.run('INSERT INTO votes (station_id, request_id, voter, created_at) VALUES (?, ?, ?, ?)', [
        stationId,
        requestId,
        voter,
        Date.now()
      ])
    } catch (error) {
      if (/UNIQUE|constraint/i.test(error.message)) return false
      throw error
    }
    this.db.run('UPDATE requests SET votes = votes + 1 WHERE id = ?', [requestId])
    return true
  }

  voteCount(requestId) {
    return this.db.get('SELECT COUNT(*) AS n FROM votes WHERE request_id = ?', [requestId])?.n ?? 0
  }

  markRequest(id, status) {
    this.db.run('UPDATE requests SET status = ?, played_at = ? WHERE id = ?', [status, Date.now(), id])
  }

  pendingRequests(stationId) {
    return this.db
      .all("SELECT * FROM requests WHERE station_id = ? AND status = 'pending' ORDER BY votes DESC, created_at", [stationId])
      .map((row) => ({
        id: row.id,
        track: JSON.parse(row.track),
        by: row.by,
        requesterId: row.requester_id,
        votes: Math.max(row.votes ?? 0, this.voteCount(row.id), 1),
        requestedAt: row.created_at,
        voters: new Set(this.votersOf(row.id))
      }))
  }

  votersOf(requestId) {
    return this.db.all('SELECT voter FROM votes WHERE request_id = ?', [requestId]).map((r) => r.voter)
  }

  /* ---------------------------- skip votes --------------------------- */

  addSkipVote({ stationId, trackId, voter }) {
    try {
      this.db.run('INSERT INTO skip_votes (station_id, track_id, voter, created_at) VALUES (?, ?, ?, ?)', [
        stationId,
        trackId,
        voter,
        Date.now()
      ])
      return true
    } catch (error) {
      if (/UNIQUE|constraint/i.test(error.message)) return false
      throw error
    }
  }

  skipVoteCount(stationId, trackId) {
    return this.db.get('SELECT COUNT(*) AS n FROM skip_votes WHERE station_id = ? AND track_id = ?', [stationId, trackId])?.n ?? 0
  }

  clearSkipVotes(stationId, trackId) {
    this.db.run('DELETE FROM skip_votes WHERE station_id = ? AND track_id = ?', [stationId, trackId])
  }

  /* ------------------------------ plays ------------------------------ */

  savePlay({ stationId, track, requestedBy, bitrate, durationMs, mixed }: any) {
    this.db.run(
      `INSERT INTO plays (station_id, track_id, title, artist, source, bitrate, requested_by, started_at, duration_ms, mixed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stationId,
        track.id,
        track.title,
        track.artist,
        track.source,
        bitrate ?? track.bitrate ?? null,
        requestedBy ?? null,
        Date.now(),
        durationMs ?? track.duration ?? null,
        mixed ? 1 : 0
      ]
    )
  }

  /* ------------------------------ memory ----------------------------- */

  /**
   * What a station was doing, so it can pick up where it left off.
   * One row per station, rewritten in place — this table never grows.
   */
  rememberStation(stationId, memory: any = {}) {
    this.db.run(
      `INSERT INTO station_memory (station_id, state, track, position_ms, queue, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(station_id) DO UPDATE SET
         state = excluded.state, track = excluded.track, position_ms = excluded.position_ms,
         queue = excluded.queue, updated_at = excluded.updated_at`,
      [
        stationId,
        memory.state ?? null,
        memory.track ? JSON.stringify(memory.track) : null,
        Math.round(memory.positionMs ?? 0),
        JSON.stringify(memory.queue ?? []),
        memory.at ?? Date.now()
      ]
    )
  }

  recallStation(stationId) {
    const row = this.db.get('SELECT * FROM station_memory WHERE station_id = ?', [stationId])
    if (!row) return null
    return {
      state: row.state,
      track: parseJson(row.track, null),
      positionMs: row.position_ms ?? 0,
      queue: parseJson(row.queue, []) ?? [],
      at: row.updated_at
    }
  }

  forgetStation(stationId) {
    this.db.run('DELETE FROM station_memory WHERE station_id = ?', [stationId])
  }

  recentPlays(stationId, limit = 50) {
    return this.db.all('SELECT * FROM plays WHERE station_id = ? ORDER BY started_at DESC LIMIT ?', [stationId, limit])
  }

  /** Most played tracks on a station — handy for a "top of the week" rotation. */
  topPlays(stationId, { limit = 20, sinceMs = 7 * 24 * 3600_000 }: any = {}) {
    return this.db.all(
      `SELECT track_id, title, artist, source, COUNT(*) AS plays
       FROM plays WHERE station_id = ? AND started_at > ?
       GROUP BY track_id ORDER BY plays DESC LIMIT ?`,
      [stationId, Date.now() - sinceMs, limit]
    )
  }

  /* ------------------------------- bans ------------------------------ */

  ban(voter, reason = '') {
    this.db.run('INSERT OR REPLACE INTO bans (voter, reason, created_at) VALUES (?, ?, ?)', [voter, reason, Date.now()])
  }

  unban(voter) {
    this.db.run('DELETE FROM bans WHERE voter = ?', [voter])
  }

  isBanned(voter) {
    return Boolean(this.db.get('SELECT voter FROM bans WHERE voter = ?', [voter]))
  }

  listBans() {
    return this.db.all('SELECT * FROM bans ORDER BY created_at DESC')
  }

  /* ------------------------------ plugins ----------------------------- */

  /**
   * Remember that a plugin exists, without ever changing a choice the owner
   * already made. `defaultEnabled` only applies the first time it is seen, so
   * a plugin can ship switched off and stay switched on once enabled.
   */
  registerPlugin(id, version, { defaultEnabled = true, scope = 'stations' }: any = {}) {
    const now = Date.now()
    this.db.run(
      `INSERT INTO plugins (id, enabled, settings, version, scope, installed_at, updated_at)
       VALUES (?, ?, '{}', ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET version = excluded.version, scope = excluded.scope, updated_at = excluded.updated_at`,
      [id, defaultEnabled ? 1 : 0, version ?? null, scope, now, now]
    )
    return this.pluginState(id)
  }

  pluginState(id) {
    const row = this.db.get('SELECT * FROM plugins WHERE id = ?', [id])
    if (!row) return null
    let settings: Record<string, any> = {}
    try {
      settings = JSON.parse(row.settings)
    } catch {
      /* corrupt settings fall back to defaults */
    }
    return {
      id: row.id,
      enabled: row.enabled === 1,
      version: row.version,
      scope: row.scope ?? 'stations',
      settings,
      installedAt: row.installed_at,
      stations: this.stationPluginsFor(row.id)
    }
  }

  setPluginEnabled(id, enabled) {
    this.db.run('UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?', [enabled ? 1 : 0, Date.now(), id])
    return this.pluginState(id)
  }

  setPluginSettings(id, settings) {
    this.db.run('UPDATE plugins SET settings = ?, updated_at = ? WHERE id = ?', [JSON.stringify(settings ?? {}), Date.now(), id])
    return this.pluginState(id)
  }

  listPlugins() {
    return this.db.all('SELECT id FROM plugins ORDER BY id').map((row) => this.pluginState(row.id))
  }

  /* -------------------------- plugins per station -------------------- */

  /**
   * Per-station overrides for one plugin: `{ lofi: { enabled: false } }`.
   * A station with no row simply follows the plugin's global state, so the
   * table only ever holds deliberate decisions.
   */
  stationPluginsFor(pluginId) {
    const out = {}
    for (const row of this.db.all('SELECT * FROM station_plugins WHERE plugin_id = ?', [pluginId])) {
      out[row.station_id] = { enabled: row.enabled === 1, settings: parseJson(row.settings), updatedAt: row.updated_at }
    }
    return out
  }

  /** The same, the other way round: every override a station carries. */
  pluginsForStation(stationId) {
    const out = {}
    for (const row of this.db.all('SELECT * FROM station_plugins WHERE station_id = ?', [stationId])) {
      out[row.plugin_id] = { enabled: row.enabled === 1, settings: parseJson(row.settings), updatedAt: row.updated_at }
    }
    return out
  }

  /** Switch a plugin on or off for one station (and optionally tune it there). */
  setStationPlugin(stationId, pluginId, { enabled = true, settings }: any = {}) {
    const now = Date.now()
    const current = this.db.get('SELECT settings FROM station_plugins WHERE station_id = ? AND plugin_id = ?', [stationId, pluginId])
    const merged = settings === undefined ? parseJson(current?.settings) : { ...parseJson(current?.settings), ...settings }
    this.db.run(
      `INSERT INTO station_plugins (station_id, plugin_id, enabled, settings, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(station_id, plugin_id) DO UPDATE SET enabled = excluded.enabled, settings = excluded.settings, updated_at = excluded.updated_at`,
      [stationId, pluginId, enabled ? 1 : 0, JSON.stringify(merged), now]
    )
    return { stationId, pluginId, enabled, settings: merged, updatedAt: now }
  }

  /** Forget the override: the station goes back to following the plugin. */
  clearStationPlugin(stationId, pluginId) {
    return this.db.run('DELETE FROM station_plugins WHERE station_id = ? AND plugin_id = ?', [stationId, pluginId]).changes > 0
  }

  /** Housekeeping when a station or a plugin goes away for good. */
  clearStationPlugins({ stationId = null, pluginId = null }: any = {}) {
    if (stationId) return this.db.run('DELETE FROM station_plugins WHERE station_id = ?', [stationId]).changes
    if (pluginId) return this.db.run('DELETE FROM station_plugins WHERE plugin_id = ?', [pluginId]).changes
    return 0
  }

  /* ----------------------------- settings ---------------------------- */

  set(key, value) {
    this.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, JSON.stringify(value)])
  }

  get(key, fallback: any = null) {
    const row = this.db.get('SELECT value FROM settings WHERE key = ?', [key])
    if (!row) return fallback
    try {
      return JSON.parse(row.value)
    } catch {
      return fallback
    }
  }

  /* ---------------------------- maintenance --------------------------- */

  stats() {
    const count = (table) => this.db.get(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0
    return {
      driver: this.driver,
      schema: this.schemaVersion,
      stations: count('stations'),
      requests: count('requests'),
      votes: count('votes'),
      skipVotes: count('skip_votes'),
      plays: count('plays'),
      bans: count('bans'),
      plugins: count('plugins'),
      models: count('dj_models'),
      seams: count('dj_seams'),
      trainingRuns: count('dj_training_runs')
    }
  }

  /** Everything `scripts/db.js info` prints. */
  info() {
    const size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0
    return {
      ...this.stats(),
      file: this.file,
      sizeKb: Math.round(size / 102.4) / 10,
      migrations: this.db.all('SELECT * FROM schema_migrations ORDER BY id'),
      tables: this.db
        .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .map((r) => r.name)
    }
  }

  /** Reclaim space and rewrite the file (safe to run while broadcasting). */
  vacuum() {
    const before = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0
    this.db.exec('VACUUM;')
    const after = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0
    return { before, after, savedKb: Math.round((before - after) / 102.4) / 10 }
  }

  /** Consistent snapshot, WAL included — the supported way to back up. */
  backup(target) {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    fs.copyFileSync(this.file, target)
    return target
  }

  /** Portable JSON dump of every table (for inspection or a migration test). */
  export() {
    const tables = this.db
      .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .map((r) => r.name)
    return Object.fromEntries(tables.map((table) => [table, this.db.all(`SELECT * FROM ${table}`)]))
  }

  close() {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    } catch {
      /* closing anyway */
    }
    this.db.close?.()
  }
}

Object.assign(Store.prototype, modelRepo)

export default Store
