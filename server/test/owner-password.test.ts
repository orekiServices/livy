/**
 * Owner passwords: the first-run claim, the env-supplied password, and the
 * change made from the console after unlocking with a key.
 *
 * The generated owner key is deliberately asymmetric: it is a way in on a
 * fresh node, but once a password exists that key stops working. An explicit
 * OWNER_KEY is a recovery credential and survives.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { loadConfig } from '../src/config.ts'
import { quietLogs, tmpdir, boot, api } from './helpers.ts'

quietLogs()

const KEY = 'test-owner-key'
const PASSWORD = 'correct horse battery'

async function node(t, overrides: any = {}) {
  const dir = overrides._dir ?? tmpdir('owner-password-')
  const server = await boot({
    _dir: dir,
    // A disabled store still has a path; credentials live beside it.
    store: { enabled: false, file: path.join(dir, 'livy.db') },
    ...overrides
  })
  t.after(() => server.close())
  return { ...server, base: `http://127.0.0.1:${server.port}`, dir }
}

const authFile = (dir) => path.join(dir, 'owner.auth.json')

test('a fresh node can be claimed with an owner password from the browser', async (t) => {
  const { base, dir, config } = await node(t, { owner: { autoKey: true } })
  const generated = config.owner.key
  assert.ok(generated, 'the node still has a key for the pre-password flow')

  const setup = await api(base, '/api/v1/setup')
  assert.equal(setup.protected, true)
  assert.equal(setup.password.configured, false)
  assert.equal(setup.password.canSet, true, 'an unclaimed node offers the password step')

  const crossSite = await fetch(`${base}/api/v1/setup/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ password: PASSWORD })
  })
  assert.equal(crossSite.status, 403, 'another site cannot claim the node')
  assert.equal((await api(base, '/api/v1/setup')).password.configured, false)
  assert.equal(JSON.stringify(setup).includes(generated), false, 'the public setup payload does not leak the key')

  const created = await api(base, '/api/v1/setup/password', { method: 'POST', body: { password: PASSWORD } })
  assert.equal(created._status, 201)
  assert.equal(created.configured, true)
  assert.equal(created.persisted, true)

  assert.equal((await api(base, '/api/v1/owner/whoami', { key: PASSWORD })).owner, true)
  assert.equal((await api(base, '/api/v1/owner/whoami', { key: generated }))._status, 401, 'the generated key is superseded')

  const after = await api(base, '/api/v1/setup')
  assert.equal(after.password.configured, true)
  assert.equal(after.password.canSet, false)
  assert.equal((await api(base, '/api/v1/setup/password', { method: 'POST', body: { password: 'another-password' } }))._status, 409)

  const stored = fs.readFileSync(authFile(dir), 'utf8')
  assert.ok(!stored.includes(PASSWORD), 'only a hash is written')
  assert.match(stored, /"algorithm":"scrypt"/)
  if (process.platform !== 'win32') assert.equal(fs.statSync(authFile(dir)).mode & 0o777, 0o600)
})

test('the password survives a restart and the generated key stays retired', async (t) => {
  const dir = tmpdir('owner-password-restart-')
  const first = await boot({
    _dir: dir,
    owner: { autoKey: true },
    store: { enabled: false, file: path.join(dir, 'livy.db') }
  })
  const firstBase = `http://127.0.0.1:${first.port}`
  await api(firstBase, '/api/v1/setup/password', { method: 'POST', body: { password: PASSWORD } })
  const retired = first.config.owner.key
  await first.close()

  const second = await boot({
    _dir: dir,
    owner: { autoKey: true },
    store: { enabled: false, file: path.join(dir, 'livy.db') }
  })
  t.after(() => second.close())
  const base = `http://127.0.0.1:${second.port}`

  assert.equal(second.config.owner.key, '', 'no fresh key is minted beside a password')
  assert.equal((await api(base, '/api/v1/owner/whoami', { key: PASSWORD })).owner, true)
  assert.equal((await api(base, '/api/v1/owner/whoami', { key: retired }))._status, 401)
})

test('an explicit owner key is required to add a password, and remains valid afterwards', async (t) => {
  const { base } = await node(t, { owner: { key: KEY, name: 'tester' } })

  const setup = await api(base, '/api/v1/setup')
  assert.equal(setup.password.canSet, false, 'an explicit key is not claimable by a stranger')
  assert.equal((await api(base, '/api/v1/setup/password', { method: 'POST', body: { password: PASSWORD } }))._status, 401)
  assert.equal(
    (await api(base, '/api/v1/setup/password', { method: 'POST', key: KEY, body: { password: PASSWORD } }))._status,
    201
  )

  assert.equal((await api(base, '/api/v1/owner/whoami', { key: PASSWORD })).owner, true)
  assert.equal((await api(base, '/api/v1/owner/whoami', { key: KEY })).owner, true, 'the explicit key is recovery')
  const status = await api(base, '/api/v1/owner/password', { key: KEY })
  assert.equal(status.configured, true)
  assert.equal(status.fromEnv, false)

  const crossSite = await fetch(`${base}/api/v1/owner/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-owner-key': KEY, origin: 'https://evil.example' },
    body: JSON.stringify({ password: 'stolen password' })
  })
  assert.equal(crossSite.status, 403)

  const changed = await api(base, '/api/v1/owner/password', { method: 'POST', key: KEY, body: { password: 'a brand new password' } })
  assert.equal(changed._status, 200)
  assert.equal(changed.configured, true)
  assert.equal((await api(base, '/api/v1/owner/whoami', { key: PASSWORD }))._status, 401, 'the old password is gone')
  assert.equal((await api(base, '/api/v1/owner/whoami', { key: 'a brand new password' })).owner, true)
  assert.equal((await api(base, '/api/v1/owner/whoami', { key: KEY })).owner, true)
})

test('OWNER_PASSWORD seeds the credential and cannot be changed in the browser', async (t) => {
  const { base, dir } = await node(t, { owner: { password: 'environment password' } })

  const setup = await api(base, '/api/v1/setup')
  assert.equal(setup.password.configured, true)
  assert.equal(setup.password.fromEnv, true)
  assert.equal(setup.password.canSet, false)
  assert.equal((await api(base, '/api/v1/owner/whoami', { key: 'environment password' })).owner, true)
  assert.equal((await api(base, '/api/v1/owner/whoami'))._status, 401, 'a password node is not open')

  assert.equal(
    (await api(base, '/api/v1/owner/password', { method: 'POST', key: 'environment password', body: { password: 'new password here' } }))._status,
    409
  )
  assert.ok(!fs.readFileSync(authFile(dir), 'utf8').includes('environment password'), 'the env secret is hashed too')
})

test('open mode can be closed with a password, and short passwords are rejected', async (t) => {
  const { base } = await node(t, { owner: { autoKey: false } })

  const setup = await api(base, '/api/v1/setup')
  assert.equal(setup.protected, false, 'no key, no password: open by design')
  assert.equal(setup.password.canSet, true)
  assert.equal((await api(base, '/api/v1/setup/password', { method: 'POST', body: { password: 'short' } }))._status, 400)

  assert.equal((await api(base, '/api/v1/setup/password', { method: 'POST', body: { password: PASSWORD } }))._status, 201)
  assert.equal((await api(base, '/api/v1/setup')).protected, true)
  assert.equal((await api(base, '/api/v1/owner/whoami'))._status, 401)
  assert.equal((await api(base, '/api/v1/owner/whoami', { key: PASSWORD })).owner, true)
})

test('OWNER_PASSWORD is read from the environment', () => {
  const previous = process.env.OWNER_PASSWORD
  try {
    process.env.OWNER_PASSWORD = 'from the environment'
    const config = loadConfig(path.join(tmpdir('config-'), 'config.json'))
    assert.equal(config.owner.password, 'from the environment')
  } finally {
    if (previous === undefined) delete process.env.OWNER_PASSWORD
    else process.env.OWNER_PASSWORD = previous
  }
})
