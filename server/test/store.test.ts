/**
 * SQLite store: migrations, upgrades from older nodes, and the guarantees the
 * radio depends on — one vote per listener, requests that survive a restart,
 * plugin state that outlives a reload.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import Store from '../src/store/index.ts'
import { MIGRATIONS, LATEST_VERSION } from '../src/store/migrations.ts'
import { tmpdir, quietLogs } from './helpers.ts'

quietLogs()

const dbFile = (name = 'livy.db') => path.join(tmpdir('livy-store-'), name)

test('a fresh database is migrated to the current schema', async () => {
  const file = dbFile()
  const store = await Store.open(file)

  assert.equal(store.schemaVersion, LATEST_VERSION)
  assert.equal(store.migration.applied.length, MIGRATIONS.length, 'every migration ran once')

  const info = store.info()
  for (const table of ['stations', 'requests', 'votes', 'skip_votes', 'plays', 'bans', 'settings', 'plugins', 'schema_migrations']) {
    assert.ok(info.tables.includes(table), `missing table ${table}`)
  }
  assert.match(info.driver, /metrodb|bun:sqlite|node:sqlite/)
  store.close()

  // Re-opening applies nothing and keeps the version.
  const again = await Store.open(file)
  assert.equal(again.migration.applied.length, 0, 'migrations are not re-applied')
  assert.equal(again.schemaVersion, LATEST_VERSION)
  again.close()
})

/**
 * A raw SQLite handle, for building a *pre-migration* database from scratch.
 *
 * MetroDB is the default driver and `bun:sqlite` the fallback, so the test asks whichever driver
 * the store itself would pick rather than assuming one. `? 1 : 1` is SQLite
 * for "true"; the store's driver wrappers all understand it.
 */
async function rawDatabase(file) {
  if (process.env.LIVY_DISABLE_METRODB !== '1') {
    try {
      const { createRequire } = await import('node:module')
      const require = createRequire(import.meta.url)
      let MetroDb
      try {
        MetroDb = require('../../native/metrodb/index.js')
      } catch {
        MetroDb = require('metrodb')
      }
      if (MetroDb?.available) {
        const Constructor = typeof MetroDb === 'function' ? MetroDb : MetroDb.Database
        return new Constructor(file)
      }
    } catch {
      /* fall through */
    }
  }
  try {
    const { Database } = await import('bun:sqlite')
    return new Database(file)
  } catch {
    /* fall through */
  }
  try {
    const { DatabaseSync } = await import('node:sqlite')
    return new DatabaseSync(file)
  } catch {
    return null
  }
}

test('an older node is upgraded in place: dialer tables go, new columns arrive', async (t) => {
  const file = dbFile('legacy.db')
  // Recreate what a v2 node left behind: core tables, no schema_migrations,
  // and the switchboard tables Livy no longer has.
  const raw = await rawDatabase(file)
  if (!raw) {
    if (typeof Bun === 'undefined') t.skip('no usable SQLite driver on this host')
    return
  }
  raw.exec(`
    CREATE TABLE stations (id TEXT PRIMARY KEY, config TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE requests (id TEXT PRIMARY KEY, station_id TEXT NOT NULL, track TEXT NOT NULL, title TEXT, by TEXT, requester_id TEXT, votes INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, played_at INTEGER);
    CREATE TABLE votes (id INTEGER PRIMARY KEY AUTOINCREMENT, station_id TEXT, request_id TEXT NOT NULL, voter TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (request_id, voter));
    CREATE TABLE skip_votes (id INTEGER PRIMARY KEY AUTOINCREMENT, station_id TEXT, track_id TEXT, voter TEXT, created_at INTEGER, UNIQUE (station_id, track_id, voter));
    CREATE TABLE plays (id INTEGER PRIMARY KEY AUTOINCREMENT, station_id TEXT NOT NULL, track_id TEXT, title TEXT, artist TEXT, source TEXT, bitrate INTEGER, requested_by TEXT, started_at INTEGER NOT NULL);
    CREATE TABLE bans (voter TEXT PRIMARY KEY, reason TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE calls (id TEXT PRIMARY KEY, station TEXT, number TEXT);
    CREATE TABLE numbers (number TEXT PRIMARY KEY, station TEXT);
  `)
  raw.prepare('INSERT INTO stations (id, config, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    'imusic1',
    JSON.stringify({ id: 'imusic1', name: 'iMusic 1', playlists: ['scsearch:lofi'] }),
    'owner',
    1700000000000,
    1700000000000
  )
  raw.prepare('INSERT INTO calls (id, station, number) VALUES (?, ?, ?)').run('c1', 'imusic1', '#1')
  raw.close()

  const store = await Store.open(file)

  assert.equal(store.schemaVersion, LATEST_VERSION)
  const tables = store.info().tables
  assert.ok(!tables.includes('calls'), 'dialer tables are dropped')
  assert.ok(!tables.includes('numbers'))
  assert.ok(tables.includes('plugins'), 'new tables are created')

  // Existing data survives the upgrade …
  const stations = store.listStations()
  assert.equal(stations.length, 1)
  assert.equal(stations[0].id, 'imusic1')

  // … and the new columns exist with sane defaults.
  store.savePlay({ stationId: 'imusic1', track: { id: 't1', title: 'A', artist: 'B', source: 'local' }, durationMs: 1000, mixed: true })
  const [play] = store.recentPlays('imusic1')
  assert.equal(play.duration_ms, 1000)
  assert.equal(play.mixed, 1)
  store.close()
})

test('a radio.db from an older install is adopted under the new name', async () => {
  const dir = tmpdir('livy-adopt-')
  const legacy = path.join(dir, 'radio.db')
  const target = path.join(dir, 'livy.db')

  const first = await Store.open(legacy)
  first.saveStation({ id: 'keepme', name: 'Keep Me' })
  first.close()

  const store = await Store.open(target)
  assert.ok(!fs.existsSync(legacy), 'the old file is moved, not copied')
  assert.equal(store.listStations()[0].id, 'keepme')
  store.close()
})

test('a JSON store from a node without SQLite is imported once', async () => {
  const dir = tmpdir('livy-json-')
  const file = path.join(dir, 'livy.db')
  fs.writeFileSync(
    path.join(dir, 'livy.json'),
    JSON.stringify({
      stations: [{ id: 'old', config: JSON.stringify({ id: 'old', name: 'Old FM' }), created_at: 1, updated_at: 1 }],
      requests: [{ id: 'r1', station_id: 'old', track: JSON.stringify({ id: 't', title: 'T' }), by: 'mai', votes: 2, status: 'pending', created_at: 1 }],
      votes: [{ station_id: 'old', request_id: 'r1', voter: 'v1', created_at: 1 }],
      bans: [{ voter: 'spammer', reason: 'flood', created_at: 1 }],
      settings: []
    })
  )

  const store = await Store.open(file)
  assert.equal(store.listStations()[0].name, 'Old FM')
  assert.equal(store.pendingRequests('old').length, 1)
  assert.equal(store.isBanned('spammer'), true)
  assert.ok(fs.existsSync(path.join(dir, 'livy.json.imported')), 'the JSON file is retired')
  store.close()

  const reopened = await Store.open(file)
  assert.equal(reopened.stats().stations, 1, 'import does not run twice')
  reopened.close()
})

test('one vote per listener is enforced by the database, not by memory', async () => {
  const store = await Store.open(dbFile())

  store.saveRequest({ id: 'r1', stationId: 's1', track: { id: 't1', title: 'Song', artist: 'A' }, by: 'mai', requesterId: 'v1' })
  assert.equal(store.addVote({ stationId: 's1', requestId: 'r1', voter: 'v1' }), true)
  assert.equal(store.addVote({ stationId: 's1', requestId: 'r1', voter: 'v1' }), false, 'the same listener cannot vote twice')
  assert.equal(store.addVote({ stationId: 's1', requestId: 'r1', voter: 'v2' }), true)
  assert.equal(store.voteCount('r1'), 2)

  assert.equal(store.addSkipVote({ stationId: 's1', trackId: 't1', voter: 'v1' }), true)
  assert.equal(store.addSkipVote({ stationId: 's1', trackId: 't1', voter: 'v1' }), false)
  assert.equal(store.skipVoteCount('s1', 't1'), 1)
  store.clearSkipVotes('s1', 't1')
  assert.equal(store.skipVoteCount('s1', 't1'), 0)

  const pending = store.pendingRequests('s1')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].votes, 2)
  assert.deepEqual([...pending[0].voters].sort(), ['v1', 'v2'])

  store.markRequest('r1', 'played')
  assert.equal(store.pendingRequests('s1').length, 0)
  store.close()
})

test('plugin state and settings survive a restart', async () => {
  const file = dbFile()
  const store = await Store.open(file)

  store.registerPlugin('now-playing', '1.1.0')
  store.registerPlugin('hourly-ident', '1.0.0', { defaultEnabled: false })
  assert.equal(store.pluginState('now-playing').enabled, true)
  assert.equal(store.pluginState('hourly-ident').enabled, false, 'a plugin may ship switched off')

  store.setPluginEnabled('hourly-ident', true)
  store.setPluginSettings('now-playing', { webhook: 'https://example.com/hook' })
  store.close()

  const reopened = await Store.open(file)
  // Re-registering on boot must not undo the owner's choices.
  reopened.registerPlugin('hourly-ident', '1.0.1', { defaultEnabled: false })
  assert.equal(reopened.pluginState('hourly-ident').enabled, true)
  assert.equal(reopened.pluginState('hourly-ident').version, '1.0.1', 'version is refreshed')
  assert.equal(reopened.pluginState('now-playing').settings.webhook, 'https://example.com/hook')
  assert.equal(reopened.listPlugins().length, 2)
  reopened.close()
})

test('plays, settings, bans and maintenance commands behave', async () => {
  const file = dbFile()
  const store = await Store.open(file)

  for (let i = 0; i < 5; i += 1) {
    store.savePlay({ stationId: 's1', track: { id: 't1', title: 'Repeat', artist: 'A', source: 'local' } })
  }
  store.savePlay({ stationId: 's1', track: { id: 't2', title: 'Once', artist: 'B', source: 'local' } })

  assert.equal(store.recentPlays('s1').length, 6)
  const top = store.topPlays('s1')
  assert.equal(top[0].track_id, 't1')
  assert.equal(top[0].plays, 5)

  store.set('ui.theme', { dark: true })
  assert.deepEqual(store.get('ui.theme'), { dark: true })
  assert.equal(store.get('missing', 'fallback'), 'fallback')

  store.ban('v9', 'flooding')
  assert.equal(store.isBanned('v9'), true)
  assert.equal(store.listBans()[0].reason, 'flooding')
  store.unban('v9')
  assert.equal(store.isBanned('v9'), false)

  const dump = store.export()
  assert.equal(dump.plays.length, 6)

  const backup = `${file}.bak`
  store.backup(backup)
  assert.ok(fs.statSync(backup).size > 0)

  const vacuumed = store.vacuum()
  assert.ok(vacuumed.after > 0)

  const stats = store.stats()
  assert.equal(stats.plays, 6)
  assert.equal(stats.schema, LATEST_VERSION)
  store.close()
})
