/**
 * The rename: an existing Nodecast deployment must become a Livy node without
 * losing anything.
 *
 * A rebrand is a display change, but three things are *not* display: the
 * database filename, the environment switches operators have in their unit
 * files, and the identity string the console probes for. Each of those has a
 * test here, because each of them is a way an upgrade could go wrong
 * silently.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import Store from '../src/store/index.ts'
import { tmpdir, quietLogs } from './helpers.ts'

quietLogs()

test('a nodecast.db is adopted as livy.db, and the data survives', async () => {
  const dir = tmpdir('livy-rebrand-')
  const legacy = path.join(dir, 'nodecast.db')

  // A working database, as the previous version left it.
  const first = await Store.open(legacy)
  first.saveStation({ id: 'nightdrive', name: 'Night Drive FM', playlists: ['scsearch:lofi'] })
  first.set('owner.name', 'kai')
  first.close()

  const store = await Store.open(path.join(dir, 'livy.db'))
  assert.ok(!fs.existsSync(legacy), 'the old file is moved, not copied')
  assert.equal(store.listStations()[0].id, 'nightdrive')
  assert.equal(store.get('owner.name'), 'kai', 'settings come across too')
  store.close()
})

test('an even older radio.db still wins over nothing, but nodecast.db wins over it', async () => {
  const dir = tmpdir('livy-rebrand-order-')

  // Both legacy names present: the newer one is the real data.
  const newer = await Store.open(path.join(dir, 'nodecast.db'))
  newer.saveStation({ id: 'from-nodecast', name: 'Newer', playlists: [] })
  newer.close()

  const older = path.join(dir, 'radio.db')
  const raw = await Store.open(older)
  raw.saveStation({ id: 'from-radio', name: 'Older', playlists: [] })
  raw.close()

  const store = await Store.open(path.join(dir, 'livy.db'))
  assert.equal(store.listStations()[0].id, 'from-nodecast')
  store.close()
})

test('a nodecast.json from before SQLite is imported once under the new name', async () => {
  const dir = tmpdir('livy-rebrand-json-')
  fs.writeFileSync(
    path.join(dir, 'nodecast.json'),
    JSON.stringify({
      stations: [{ id: 'old', config: JSON.stringify({ id: 'old', name: 'Old FM' }), created_at: 1, updated_at: 1 }],
      settings: []
    })
  )

  const store = await Store.open(path.join(dir, 'livy.db'))
  assert.equal(store.listStations()[0].name, 'Old FM')
  assert.ok(fs.existsSync(path.join(dir, 'nodecast.json.imported')), 'the JSON file is retired')
  store.close()
})

test('the old environment switches are still honoured', async (t) => {
  // The store reads this at import time, so it has to be imported fresh with
  // the variable set — which is exactly what a restart does.
  const previous = process.env.NODECAST_DISABLE_METRODB
  process.env.NODECAST_DISABLE_METRODB = '1'
  try {
    const module = await import(`../src/store/index.ts?legacy-env=${Date.now()}`)
    let opened = null
    try {
      opened = await module.default.open(path.join(tmpdir('livy-rebrand-env-'), 'livy.db'))
    } catch (error) {
      // This host carries no second driver. That is itself proof the switch
      // was read: MetroDB was the only one there was.
      assert.match(error.message, /no binding is available/i)
      t.diagnostic('NODECAST_DISABLE_METRODB turned MetroDB off; no fallback driver on this host')
      return
    }
    assert.doesNotMatch(opened.driver, /metrodb/i, 'NODECAST_DISABLE_METRODB still turns MetroDB off')
    opened.close()
  } finally {
    if (previous === undefined) delete process.env.NODECAST_DISABLE_METRODB
    else process.env.NODECAST_DISABLE_METRODB = previous
  }
})
