/**
 * The logger: levels, per-category debug switches, structured fields, the
 * in-memory ring buffer the owner console reads, secret redaction and file
 * rotation. Nothing here touches stdout formatting by accident — the tests
 * read the buffer, which is the same record the file and console render.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import createLogger, { configureLogging, resetLogging, tail, onLog, loggingState, banner } from '../src/util/logger.js'
import { tmpdir } from './helpers.js'

const lastLine = () => tail(1)[0]

test('levels gate what is recorded', () => {
  resetLogging()
  configureLogging({ level: 'info', color: false, buffer: 50 })
  const log = createLogger('unit')

  log.debug('invisible')
  assert.equal(tail(10).length, 0, 'debug is below info')

  log.info('visible')
  log.warn('careful')
  const lines = tail(10)
  assert.deepEqual(lines.map((l) => l.msg), ['visible', 'careful'])
  assert.equal(lines[0].scope, 'unit')

  // Reconfiguring keeps what is already buffered; nothing new is added.
  const before = tail(50).length
  configureLogging({ level: 'silent', color: false, buffer: 50 })
  log.error('not even this')
  assert.equal(tail(50).length, before, 'silent records nothing further')
  resetLogging()
})

test('debug categories switch on one subsystem at a time', () => {
  resetLogging()
  configureLogging({ level: 'info', color: false, buffer: 50, debug: { sources: true } })

  const sc = createLogger('src:soundcloud') // → category "sources"
  const http = createLogger('http')
  sc.debug('client id refreshed')
  http.debug('GET /api/v1/stations')

  const lines = tail(10)
  assert.equal(lines.length, 1, 'only the enabled category is verbose')
  assert.equal(lines[0].scope, 'src:soundcloud')
  assert.equal(loggingState().categories.sources, 'debug')
  resetLogging()
})

test('fields, child scopes and timers travel with the record', () => {
  resetLogging()
  configureLogging({ level: 'debug', color: false, buffer: 50 })

  const log = createLogger('station').with({ station: 'lofi' })
  log.info('on air', { listeners: 3 })
  assert.deepEqual(lastLine().fields, { station: 'lofi', listeners: 3 })

  const child = createLogger('sources').child('audius')
  child.info('resolved')
  assert.equal(lastLine().scope, 'sources:audius')

  const done = createLogger('automix').timer('render', 'info')
  done({ frames: 12 })
  const timed = lastLine()
  assert.equal(timed.msg, 'render')
  assert.equal(timed.fields.frames, 12)
  assert.equal(typeof timed.fields.ms, 'number')
  resetLogging()
})

test('errors keep their stack and cause chain', () => {
  resetLogging()
  configureLogging({ level: 'info', color: false, buffer: 50 })

  const cause = new Error('socket hang up')
  createLogger('src:soundcloud').error('stream failed', new Error('resolve failed', { cause }), { track: 'sc:1' })

  const line = lastLine()
  assert.equal(line.level, 'error')
  assert.match(line.err, /resolve failed/)
  assert.match(line.err, /caused by: .*socket hang up/)
  assert.equal(line.fields.track, 'sc:1')
  resetLogging()
})

test('secrets are redacted before they reach any sink', () => {
  resetLogging()
  configureLogging({ level: 'info', color: false, buffer: 50 })

  const log = createLogger('http')
  log.info('request with x-owner-key: super-secret-key')
  log.info('upstream', { client_id: 'abc123def', token: 'xyz' })

  const lines = tail(2)
  assert.doesNotMatch(JSON.stringify(lines), /super-secret-key|abc123def|xyz/)
  assert.match(lines[0].msg, /x-owner-key: \*\*\*/)
  assert.equal(lines[1].fields.client_id, '***')
  resetLogging()
})

test('the ring buffer is bounded and filterable', () => {
  resetLogging()
  configureLogging({ level: 'info', color: false, buffer: 10 })

  const a = createLogger('station:one')
  const b = createLogger('http')
  for (let i = 0; i < 20; i += 1) a.info(`line ${i}`)
  b.warn('slow listener evicted')

  assert.equal(tail(100).length, 10, 'buffer is capped')
  assert.equal(tail(100, { level: 'warn' }).length, 1)
  assert.equal(tail(100, { scope: 'station:' }).length, 9)
  resetLogging()
})

test('listeners receive every record', () => {
  resetLogging()
  configureLogging({ level: 'info', color: false, buffer: 10 })

  const seen = []
  const off = onLog((record) => seen.push(record.msg))
  createLogger('unit').info('one')
  off()
  createLogger('unit').info('two')

  assert.deepEqual(seen, ['one'])
  resetLogging()
})

test('the file sink writes JSON lines and rotates', () => {
  resetLogging()
  const dir = tmpdir('nodecast-log-')
  const file = path.join(dir, 'nodecast.log')
  configureLogging({ level: 'info', color: false, buffer: 10, file: { enabled: true, path: file, maxMb: 0.004, keep: 2 } })

  const log = createLogger('unit')
  for (let i = 0; i < 60; i += 1) log.info(`line ${i}`, { i, padding: 'x'.repeat(40) })

  resetLogging() // flushes and closes
  assert.ok(fs.existsSync(file), 'current log exists')
  assert.ok(fs.existsSync(`${file}.1`), 'rotated log exists')

  const record = JSON.parse(fs.readFileSync(`${file}.1`, 'utf8').trim().split('\n')[0])
  assert.equal(record.scope, 'unit')
  assert.equal(record.level, 'info')
  assert.equal(typeof record.t, 'number')
})

test('the boot banner prints the identity of the node', () => {
  const written = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk) => {
    written.push(String(chunk))
    return true
  }
  try {
    banner({ version: '3.1.0', host: '0.0.0.0', port: 2333, stations: 2, store: 'better-sqlite3 · schema v5', plugins: '3/3 active' })
  } finally {
    process.stdout.write = original
  }

  const text = written.join('')
  assert.match(text, /Nodecast/)
  assert.match(text, /nodecast 3\.1\.0/)
  assert.match(text, /http:\/\/0\.0\.0\.0:2333/)
  assert.match(text, /schema v5/)
  assert.match(text, /3\/3 active/)
})
