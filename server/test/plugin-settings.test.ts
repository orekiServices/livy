/**
 * Plugin settings that describe themselves.
 *
 * Two things are being protected here. The first is the owner: a settings
 * form should be impossible to get wrong, and when it is wrong the node
 * should say which field and why. The second is the plugin: it declared what
 * it can accept, so it should never be handed `"thirty"` where it asked for
 * a number — not from an API call, not from a console, and not from a
 * database row written by an older version of itself.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { normaliseSchema, defaultsOf, validate, describe as describeSchema, FIELD_TYPES } from '../src/core/pluginSchema.ts'
import { quietLogs, tmpdir, makeMedia, boot, api } from './helpers.ts'

quietLogs()

const KEY = 'schema-key'

const SCHEMA = [
  { key: 'everyMinutes', type: 'integer', default: 30, min: 5, max: 240, label: 'A bulletin every', unit: 'min' },
  { key: 'start', type: 'time', default: '17:00' },
  { key: 'timezone', type: 'timezone', default: 'Asia/Ho_Chi_Minh' },
  { key: 'language', type: 'language', default: 'vi' },
  { key: 'feeds', type: 'list', of: 'url', default: [], max: 3 },
  { key: 'summaries', type: 'boolean', default: true },
  { key: 'mode', type: 'select', default: 'full', options: ['full', 'headlines'] },
  { key: 'token', type: 'string', default: '', secret: true },
  { key: 'file', type: 'string', default: 'data/x.json', perStation: false },
  { key: 'speed', type: 'number', default: 1, min: 0.5, max: 1, step: 0.05, advanced: true }
]

/* ------------------------------ the schema ---------------------------- */

test('a schema can be written as a list or a map, and is filled in either way', () => {
  const fromList = normaliseSchema([{ key: 'a', type: 'integer' }])
  const fromMap = normaliseSchema({ a: { type: 'integer' } })
  assert.deepEqual(fromList, fromMap)

  const [field] = fromList
  assert.equal(field.key, 'a')
  assert.equal(field.label, 'A', 'a label is derived when none is given')
  assert.equal(field.perStation, true, 'settings are per station unless said otherwise')
  assert.equal(field.advanced, false)

  // Labels come from the key when the author did not write one.
  assert.equal(normaliseSchema([{ key: 'everyMinutes' }])[0].label, 'Every Minutes')
  // An unknown type degrades to text rather than exploding.
  assert.equal(normaliseSchema([{ key: 'x', type: 'quaternion' }])[0].type, 'string')
  assert.equal(normaliseSchema(null).length, 0)
  assert.ok(FIELD_TYPES.includes('timezone'))
})

test('defaults come from the schema, so a plugin never repeats them', () => {
  const defaults = defaultsOf(normaliseSchema(SCHEMA))
  assert.equal(defaults.everyMinutes, 30)
  assert.equal(defaults.start, '17:00')
  assert.deepEqual(defaults.feeds, [])
  assert.equal(defaults.summaries, true)

  // A list default is a copy, not the schema's own array.
  defaults.feeds.push('https://x.example/rss')
  assert.deepEqual(defaultsOf(normaliseSchema(SCHEMA)).feeds, [])
})

test('every field type is checked, coerced, and explains itself when wrong', () => {
  const fields = normaliseSchema(SCHEMA)
  const ok = (patch) => validate(fields, patch).value
  const why = (patch) => validate(fields, patch).errors.map((error) => error.message).join('')

  // Numbers: coerced from strings, rounded, and bounded.
  assert.equal(ok({ everyMinutes: '45' }).everyMinutes, 45)
  assert.equal(ok({ everyMinutes: 45.6 }).everyMinutes, 46)
  assert.match(why({ everyMinutes: 'thirty' }), /A bulletin every: must be a number/)
  assert.match(why({ everyMinutes: 1 }), /at least 5/)
  assert.match(why({ everyMinutes: 999 }), /at most 240/)

  // Times are normalised so 9:05 and 09:05 are the same setting.
  assert.equal(ok({ start: '9:05' }).start, '09:05')
  assert.match(why({ start: '25:00' }), /must be a time/)
  assert.match(why({ start: 'evening' }), /must be a time/)

  // Zones are checked against the runtime's own database.
  assert.equal(ok({ timezone: 'Europe/London' }).timezone, 'Europe/London')
  assert.match(why({ timezone: 'Mars/Olympus' }), /IANA time zone/)

  assert.equal(ok({ language: 'pt-BR' }).language, 'pt-BR')
  assert.match(why({ language: 'Vietnamese' }), /language tag/)

  // Lists take an array or one-per-line text, and every entry is checked.
  assert.deepEqual(ok({ feeds: ['https://a.example/r'] }).feeds, ['https://a.example/r'])
  assert.deepEqual(ok({ feeds: 'https://a.example/r\n\nhttps://b.example/r' }).feeds, ['https://a.example/r', 'https://b.example/r'])
  assert.match(why({ feeds: ['not a url'] }), /must be a valid URL/)
  assert.match(why({ feeds: ['ftp://a.example/r'] }), /http\(s\)/)
  assert.match(why({ feeds: ['https://a/1', 'https://a/2', 'https://a/3', 'https://a/4'] }), /no more than 3/)

  assert.equal(ok({ summaries: 'false' }).summaries, false)
  assert.equal(ok({ summaries: 1 }).summaries, true)
  assert.match(why({ summaries: 'maybe' }), /true or false/)

  assert.equal(ok({ mode: 'headlines' }).mode, 'headlines')
  assert.match(why({ mode: 'sports' }), /one of: full, headlines/)

  // Good fields still apply when another one is wrong: fixing a form should
  // not mean retyping it.
  const mixed = validate(fields, { everyMinutes: 60, mode: 'sports' })
  assert.equal(mixed.value.everyMinutes, 60)
  assert.equal(mixed.errors.length, 1)

  // null means "back to the default", which is how a form clears a box.
  assert.equal(validate(fields, { everyMinutes: null }).value.everyMinutes, 30)

  // A key the schema does not know is kept, and reported.
  const extra = validate(fields, { experimental: true })
  assert.equal(extra.value.experimental, true)
  assert.deepEqual(extra.unknown, ['experimental'])
})

test('the description a console renders never contains a secret', () => {
  const fields = normaliseSchema(SCHEMA)
  const form = describeSchema(fields, { everyMinutes: 45, token: 'hunter2', feeds: ['https://a.example/r'] })

  const byKey = Object.fromEntries(form.map((field) => [field.key, field]))
  assert.equal(byKey.everyMinutes.value, 45)
  assert.equal(byKey.everyMinutes.unit, 'min')
  assert.equal(byKey.start.value, '17:00', 'unset fields show their default')
  assert.deepEqual(byKey.feeds.value, ['https://a.example/r'])
  assert.equal(byKey.token.value, '••••••', 'a secret is never sent back')
  assert.equal(byKey.speed.advanced, true)
  assert.equal(byKey.file.perStation, false)

  // Order is the author's order: it is the form's order.
  assert.equal(form[0].key, 'everyMinutes')
})

/* ------------------------- through a real node ------------------------ */

async function node(t) {
  const dir = tmpdir('schema-')
  const mediaDir = path.join(dir, 'media')
  makeMedia(mediaDir, { count: 1, ms: 800 })

  const server = await boot({
    _dir: dir,
    owner: { key: KEY, name: 'tester' },
    sources: { mediaDir },
    stations: [{ id: 'fm', name: 'Schema FM', playlists: [`local:${mediaDir}`], autoStart: false }],
    plugins: { enabled: true, dir: path.resolve('plugins'), disabled: ['console', 'hourly-ident', 'live-relay', 'vnnews'] }
  })
  t.await = null
  t.after(() => server.close())
  return { ...server, base: `http://127.0.0.1:${server.port}` }
}

test('the shipped plugins describe their settings', async (t) => {
  const { base } = await node(t)
  const { plugins } = await api(base, '/api/v1/owner/plugins', { key: KEY })

  for (const plugin of plugins) {
    assert.ok(Array.isArray(plugin.schema), `${plugin.id} reports a schema array`)
    for (const field of plugin.schema) {
      assert.ok(field.key, `${plugin.id}: every field has a key`)
      assert.ok(FIELD_TYPES.includes(field.type), `${plugin.id}.${field.key}: ${field.type} is a real type`)
      assert.ok(field.label, `${plugin.id}.${field.key}: has a label a person can read`)
    }
  }

  // The news plugin is the fullest example, so check it in detail.
  const news = plugins.find((plugin) => plugin.id === 'vnnews')
  assert.ok(news.schema.length >= 10, 'vnnews describes all of its settings')
  const byKey = Object.fromEntries(news.schema.map((field) => [field.key, field]))
  assert.equal(byKey.start.type, 'time')
  assert.equal(byKey.timezone.type, 'timezone')
  assert.equal(byKey.feeds.type, 'list')
  assert.equal(byKey.feeds.of, 'url')
  assert.equal(byKey.worker.perStation, false, 'the worker switch is node-wide')
  assert.ok(byKey.everyMinutes.help, 'and the fields explain themselves')
})

test('the owner gets a form for one plugin, and is told exactly what is wrong', async (t) => {
  const { base } = await node(t)

  const form = await api(base, '/api/v1/owner/plugins/now-playing/schema', { key: KEY })
  assert.equal(form.plugin, 'now-playing')
  assert.ok(form.fields.length >= 3)
  assert.ok(form.settings.file, 'with the values that apply')

  // A bad value is refused with the field's label, and nothing is saved.
  const before = (await api(base, '/api/v1/owner/plugins/now-playing', { key: KEY })).settings
  const rejected = await api(base, '/api/v1/owner/plugins/now-playing', {
    method: 'PATCH',
    key: KEY,
    body: { settings: { webhook: 'not-a-url' } }
  })
  assert.equal(rejected._status, 400)
  assert.match(rejected.message, /Webhook/)
  const after = (await api(base, '/api/v1/owner/plugins/now-playing', { key: KEY })).settings
  assert.deepEqual(after, before, 'a rejected patch changes nothing')

  // A good one is applied and persisted.
  const saved = await api(base, '/api/v1/owner/plugins/now-playing', {
    method: 'PATCH',
    key: KEY,
    body: { settings: { webhook: 'https://example.com/hook' } }
  })
  assert.equal(saved._status, 200)
  assert.equal((await api(base, '/api/v1/owner/plugins/now-playing', { key: KEY })).settings.webhook, 'https://example.com/hook')

  assert.equal((await api(base, '/api/v1/owner/plugins/now-playing/schema'))._status, 401, 'owner only')
  assert.equal((await api(base, '/api/v1/owner/plugins/nope/schema', { key: KEY }))._status, 404)
})

test('per-station settings are checked too, and node-wide fields stay node-wide', async (t) => {
  const { base } = await node(t)

  // One station, its own webhook.
  const ok = await api(base, '/api/v1/owner/stations/fm/plugins/now-playing', {
    method: 'PATCH',
    key: KEY,
    body: { settings: { webhook: 'https://station.example/hook' } }
  })
  assert.equal(ok._status, 200)

  const form = await api(base, '/api/v1/owner/plugins/now-playing/schema?station=fm', { key: KEY })
  assert.equal(form.station, 'fm')
  assert.equal(form.settings.webhook, 'https://station.example/hook')

  // The same bad value is refused here as well.
  const bad = await api(base, '/api/v1/owner/stations/fm/plugins/now-playing', {
    method: 'PATCH',
    key: KEY,
    body: { settings: { webhook: 'nope' } }
  })
  assert.equal(bad._status, 400)

  // And a field the plugin declared node-wide cannot be set for one station.
  const fixed = await api(base, '/api/v1/owner/stations/fm/plugins/now-playing', {
    method: 'PATCH',
    key: KEY,
    body: { settings: { file: 'data/only-here.json' } }
  })
  assert.equal(fixed._status, 400)
  assert.match(fixed.message, /cannot be set per station/)
})
