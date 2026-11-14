/**
 * Schema migrations.
 *
 * Every node — laptop, Pi, container — runs the same SQLite file through the
 * same ordered list. A migration is applied exactly once, inside a
 * transaction, and recorded in `schema_migrations`; `PRAGMA user_version`
 * mirrors the highest applied id so the file is self-describing even without
 * this code.
 *
 * Rules for adding one:
 *   • append, never edit or renumber an applied migration;
 *   • `up(db)` gets `{ run, get, all, exec }` and must be idempotent-safe;
 *   • keep them small — one intent per migration.
 */

/** Columns present on a table, or [] when the table does not exist. */
const columns = (db, table) => db.all(`PRAGMA table_info(${table})`).map((c) => c.name)
const hasTable = (db, table) =>
  Boolean(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]))

export const MIGRATIONS = [
  {
    id: 1,
    name: 'core-schema',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS stations (
          id          TEXT PRIMARY KEY,
          config      TEXT NOT NULL,
          created_by  TEXT,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS requests (
          id            TEXT PRIMARY KEY,
          station_id    TEXT NOT NULL,
          track         TEXT NOT NULL,
          title         TEXT,
          by            TEXT,
          requester_id  TEXT,
          votes         INTEGER NOT NULL DEFAULT 0,
          status        TEXT NOT NULL DEFAULT 'pending',
          created_at    INTEGER NOT NULL,
          played_at     INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_requests_station ON requests(station_id, status);

        CREATE TABLE IF NOT EXISTS votes (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          station_id  TEXT NOT NULL,
          request_id  TEXT NOT NULL,
          voter       TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          UNIQUE (request_id, voter)
        );

        CREATE TABLE IF NOT EXISTS skip_votes (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          station_id  TEXT NOT NULL,
          track_id    TEXT NOT NULL,
          voter       TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          UNIQUE (station_id, track_id, voter)
        );

        CREATE TABLE IF NOT EXISTS plays (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          station_id    TEXT NOT NULL,
          track_id      TEXT,
          title         TEXT,
          artist        TEXT,
          source        TEXT,
          bitrate       INTEGER,
          requested_by  TEXT,
          started_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_plays_station ON plays(station_id, started_at DESC);

        CREATE TABLE IF NOT EXISTS bans (
          voter       TEXT PRIMARY KEY,
          reason      TEXT,
          created_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
          key    TEXT PRIMARY KEY,
          value  TEXT NOT NULL
        );
      `)
    }
  },

  {
    id: 2,
    name: 'retire-dialer',
    up(db) {
      // Livy is pure radio: the switchboard era leaves no tables behind.
      for (const table of ['calls', 'numbers', 'carriers', 'call_log', 'voice_sessions']) {
        if (hasTable(db, table)) db.exec(`DROP TABLE ${table};`)
      }
    }
  },

  {
    id: 3,
    name: 'plugins',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plugins (
          id            TEXT PRIMARY KEY,
          enabled       INTEGER NOT NULL DEFAULT 1,
          settings      TEXT NOT NULL DEFAULT '{}',
          version       TEXT,
          installed_at  INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        );
      `)
    }
  },

  {
    id: 4,
    name: 'play-detail',
    up(db) {
      const have = columns(db, 'plays')
      if (!have.includes('duration_ms')) db.exec('ALTER TABLE plays ADD COLUMN duration_ms INTEGER;')
      if (!have.includes('mixed')) db.exec('ALTER TABLE plays ADD COLUMN mixed INTEGER NOT NULL DEFAULT 0;')
      db.exec('CREATE INDEX IF NOT EXISTS idx_plays_track ON plays(track_id);')
      db.exec('CREATE INDEX IF NOT EXISTS idx_requests_requester ON requests(requester_id, created_at);')
    }
  },

  {
    id: 5,
    name: 'station-order',
    up(db) {
      // Stations keep a stable display order the owner can rearrange, and a
      // soft `enabled` flag so a channel can be parked without deleting it.
      const have = columns(db, 'stations')
      if (!have.includes('position')) db.exec('ALTER TABLE stations ADD COLUMN position INTEGER NOT NULL DEFAULT 0;')
      if (!have.includes('enabled')) db.exec('ALTER TABLE stations ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;')
      db.exec('UPDATE stations SET position = rowid WHERE position = 0;')
    }
  },

  {
    id: 6,
    name: 'station-plugins',
    up(db) {
      // A plugin is loaded once per process, but it does not have to apply to
      // every station: one row here is "plugin X is on/off for station Y",
      // with optional per-station settings layered over the plugin's own.
      // No row means "follow the plugin's global state".
      db.exec(`
        CREATE TABLE IF NOT EXISTS station_plugins (
          station_id  TEXT NOT NULL,
          plugin_id   TEXT NOT NULL,
          enabled     INTEGER NOT NULL DEFAULT 1,
          settings    TEXT NOT NULL DEFAULT '{}',
          updated_at  INTEGER NOT NULL,
          PRIMARY KEY (station_id, plugin_id)
        );
        CREATE INDEX IF NOT EXISTS idx_station_plugins_plugin ON station_plugins(plugin_id);
      `)

      // `scope` records what a plugin says about itself: 'stations' (can be
      // switched per station) or 'global' (the console, for instance).
      const have = columns(db, 'plugins')
      if (!have.includes('scope')) db.exec("ALTER TABLE plugins ADD COLUMN scope TEXT NOT NULL DEFAULT 'stations';")
    }
  },

  {
    id: 7,
    name: 'station-memory',
    up(db) {
      // What each station was doing when the node stopped: the track on air,
      // how far into it, and the queue behind it. One row per station,
      // rewritten in place every few seconds — this table never grows, which
      // is the point: the alternative was holding it all in RAM forever.
      db.exec(`
        CREATE TABLE IF NOT EXISTS station_memory (
          station_id  TEXT PRIMARY KEY,
          state       TEXT,
          track       TEXT,
          position_ms INTEGER NOT NULL DEFAULT 0,
          queue       TEXT NOT NULL DEFAULT '[]',
          updated_at  INTEGER NOT NULL
        );
      `)
    }
  },

  {
    id: 8,
    name: 'dj-models',
    up(db) {
      // Multi-train needs more than a `.bin` on disk: every candidate, the run
      // that produced it, and the seam log it learned from. All of it is in
      // this one SQLite file — no second database server, no Postgres.
      db.exec(`
        CREATE TABLE IF NOT EXISTS dj_seams (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          station_id  TEXT,
          effect      TEXT,
          outcome     TEXT,
          record      TEXT NOT NULL,
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dj_seams_created ON dj_seams(created_at DESC);

        CREATE TABLE IF NOT EXISTS dj_models (
          name        TEXT PRIMARY KEY,
          digest      TEXT,
          file        TEXT,
          shape       TEXT,
          parameters  INTEGER,
          accuracy    REAL,
          loss        REAL,
          backend     TEXT,
          station_id  TEXT,
          active      INTEGER NOT NULL DEFAULT 0,
          remote      TEXT,
          meta        TEXT NOT NULL DEFAULT '{}',
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dj_models_created ON dj_models(created_at DESC);

        CREATE TABLE IF NOT EXISTS dj_training_runs (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          station_id  TEXT,
          mode        TEXT,
          count       INTEGER NOT NULL DEFAULT 0,
          backend     TEXT,
          trained     INTEGER NOT NULL DEFAULT 0,
          accuracy    REAL,
          best        TEXT,
          report      TEXT NOT NULL DEFAULT '{}',
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dj_runs_created ON dj_training_runs(created_at DESC);
      `)
    }
  }
]

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].id

/**
 * Bring a database up to `LATEST_VERSION`.
 * @returns {{ from: number, to: number, applied: Array<{id:number,name:string,ms:number}> }}
 */
export function migrate(db, { log }: any = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  INTEGER NOT NULL
    );
  `)

  const done = new Set<number>(db.all('SELECT id FROM schema_migrations').map((r: any) => Number(r.id)))

  // A pre-migration database (v2 and earlier shipped a bare CREATE TABLE
  // block) already has the core tables: adopt it instead of failing.
  if (done.size === 0 && hasTable(db, 'stations')) {
    db.run('INSERT OR IGNORE INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [1, 'core-schema', Date.now()])
    done.add(1)
    log?.info('adopted an existing database as schema v1')
  }

  const from = Math.max(0, ...[0, ...done])
  const applied = []

  for (const migration of MIGRATIONS) {
    if (done.has(migration.id)) continue
    const started = Date.now()
    db.transaction(() => {
      migration.up(db)
      db.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [migration.id, migration.name, Date.now()])
    })
    const ms = Date.now() - started
    applied.push({ id: migration.id, name: migration.name, ms })
    log?.info(`migration applied: ${String(migration.id).padStart(3, '0')} ${migration.name}`, { ms })
  }

  db.exec(`PRAGMA user_version = ${LATEST_VERSION};`)
  return { from, to: LATEST_VERSION, applied }
}

export default migrate
