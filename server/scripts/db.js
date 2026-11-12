#!/usr/bin/env node
/**
 * Database control — the SQLite file every Nodecast node keeps its state in.
 *
 *   node scripts/db.js info                 schema version, tables, row counts
 *   node scripts/db.js migrate              apply pending migrations (safe to repeat)
 *   node scripts/db.js vacuum               reclaim space
 *   node scripts/db.js backup [file]        consistent copy (WAL checkpointed)
 *   node scripts/db.js export [file.json]   portable dump of every table
 *   node scripts/db.js plugins              plugin enable/disable state
 *   node scripts/db.js stations             stations created through the console
 *
 * Add `--file <path>` (or set STORE_FILE) to work on another database.
 */
import fs from 'node:fs'
import Store from '../src/store/index.js'
import { loadConfig } from '../src/config.js'
import { configureLogging } from '../src/util/logger.js'

const argv = process.argv.slice(2)
const command = argv.find((a) => !a.startsWith('--')) ?? 'info'
const fileFlag = argv.indexOf('--file')
const config = loadConfig()
const file = fileFlag !== -1 ? argv[fileFlag + 1] : config.store.file

configureLogging({ ...config.logging, level: argv.includes('--verbose') ? 'debug' : 'warn' })

const bold = (text) => (process.stdout.isTTY ? `\x1b[1m${text}\x1b[0m` : text)
const dim = (text) => (process.stdout.isTTY ? `\x1b[2m${text}\x1b[0m` : text)

if (!fs.existsSync(file) && command !== 'migrate' && command !== 'info') {
  console.error(`No database at ${file} — start the node once, or run: node scripts/db.js migrate`)
  process.exit(1)
}

const store = await Store.open(file, { migrate: command === 'migrate' || command === 'info' })

const table = (rows) => {
  if (rows.length === 0) return console.log(dim('  (none)'))
  const keys = Object.keys(rows[0])
  const width = Object.fromEntries(keys.map((k) => [k, Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length))]))
  console.log(dim(`  ${keys.map((k) => k.padEnd(width[k])).join('  ')}`))
  for (const row of rows) console.log(`  ${keys.map((k) => String(row[k] ?? '').padEnd(width[k])).join('  ')}`)
}

switch (command) {
  case 'info': {
    const info = store.info()
    console.log(bold(`\n  ${info.file}`))
    console.log(`  ${info.driver} · schema v${info.schema} · ${info.sizeKb} KB\n`)
    console.log(bold('  rows'))
    table([
      {
        stations: info.stations,
        requests: info.requests,
        votes: info.votes,
        skip_votes: info.skipVotes,
        plays: info.plays,
        bans: info.bans,
        plugins: info.plugins
      }
    ])
    console.log(`\n  ${bold('migrations')}`)
    table(info.migrations.map((m) => ({ id: m.id, name: m.name, applied: new Date(m.applied_at).toISOString().slice(0, 19).replace('T', ' ') })))
    console.log(`\n  ${bold('tables')}  ${info.tables.join(', ')}\n`)
    break
  }

  case 'migrate': {
    const { from, to, applied } = store.migration
    if (applied.length === 0) console.log(`  already at schema v${to} — nothing to do`)
    else {
      console.log(`  upgraded v${from} → v${to}`)
      table(applied)
    }
    break
  }

  case 'vacuum': {
    const result = store.vacuum()
    console.log(`  vacuumed: ${Math.round(result.before / 1024)} KB → ${Math.round(result.after / 1024)} KB (saved ${result.savedKb} KB)`)
    break
  }

  case 'backup': {
    const target = argv.find((a, i) => i > argv.indexOf('backup') && !a.startsWith('--')) ?? `${file}.backup-${Date.now()}`
    store.backup(target)
    console.log(`  backup written: ${target}`)
    break
  }

  case 'export': {
    const target = argv.find((a, i) => i > argv.indexOf('export') && !a.startsWith('--')) ?? `${file}.json`
    fs.writeFileSync(target, `${JSON.stringify(store.export(), null, 2)}\n`)
    console.log(`  exported: ${target}`)
    break
  }

  case 'plugins': {
    table(store.listPlugins().map((p) => ({ id: p.id, enabled: p.enabled, version: p.version ?? '—', settings: JSON.stringify(p.settings) })))
    break
  }

  case 'stations': {
    table(
      store.listStations().map((s) => ({
        id: s.id,
        name: s.name,
        genre: s.genre ?? '—',
        playlists: (s.playlists ?? []).length,
        automix: s.automix?.effect ?? 'default'
      }))
    )
    break
  }

  default:
    console.error(`Unknown command "${command}". Try: info | migrate | vacuum | backup | export | plugins | stations`)
    process.exitCode = 1
}

store.close()
