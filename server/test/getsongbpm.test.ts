import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clearGetSongBpmCache,
  getSongBpmStatus,
  getSongBpmTempo
} from '../src/core/automix/getsongbpm.ts'

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' }
})

test('GetSongBPM status reports whether a server-side API key is configured', () => {
  assert.equal(getSongBpmStatus({}).configured, false)
  assert.equal(getSongBpmStatus({ LIVY_GETSONGBPM_API_KEY: ' alias ' }).configured, true)
  assert.equal(getSongBpmStatus({ GETSONGBPM_API_KEY: ' primary ' }).configured, true)
  assert.equal(getSongBpmStatus({ GETSONGBPM_API_KEY: ' primary ', LIVY_GETSONGBPM_API_KEY: 'alias' }).credential, 'GETSONGBPM_API_KEY')
})

test('missing GetSongBPM credentials are a typed service error and do not make a request', async () => {
  let requests = 0
  await assert.rejects(
    getSongBpmTempo({ title: 'No Key Track', artist: 'Example' }, {
      apiKey: '',
      fetchImpl: async () => { requests += 1; return jsonResponse([]) }
    }),
    (error: any) => error.service === 'GetSongBPM' && error.code === 'missing_api_key' && /GETSONGBPM_API_KEY/.test(error.message)
  )
  assert.equal(requests, 0)
})

test('search matches title and artist, sends the API key, and coalesces/caches lookups', async () => {
  clearGetSongBpmCache()
  const track = { title: 'Blue Monday (Remastered 2024)', artist: 'New Order' }
  const payload = {
    search: [
      { id: 'wrong-artist', title: 'Blue Monday', tempo: '99', artist: [{ name: 'Orchestral Manoeuvres in the Dark' }] },
      { id: 'right-track', title: 'Blue Monday', tempo: '130', uri: 'https://getsongbpm.com/song/blue-monday/right-track', artist: [{ name: 'New Order' }] }
    ]
  }
  let requests = 0
  const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit) => {
    requests += 1
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://api.getsong.co')
    assert.equal(url.pathname, '/search/')
    assert.equal(url.searchParams.get('type'), 'both')
    assert.equal(url.searchParams.get('lookup'), 'song:Blue Monday (Remastered 2024) artist:New Order')
    assert.equal(url.searchParams.get('limit'), '10')
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'test-key')
    return jsonResponse(payload)
  }

  try {
    const [first, simultaneous] = await Promise.all([
      getSongBpmTempo(track, { apiKey: 'test-key', fetchImpl }),
      getSongBpmTempo(track, { apiKey: 'test-key', fetchImpl })
    ])
    assert.equal(requests, 1, 'concurrent misses share the same request')
    assert.equal(first.id, 'right-track', 'artist match beats a same-title wrong artist')
    assert.equal(first.tempo, 130)
    assert.equal(first.confidence, 1)
    assert.equal(first.uri, 'https://getsongbpm.com/song/blue-monday/right-track')
    assert.deepEqual(simultaneous, first)

    const cached = await getSongBpmTempo(track, { apiKey: 'test-key', fetchImpl })
    assert.deepEqual(cached, first)
    assert.equal(requests, 1, 'the successful tempo is cached')
  } finally {
    clearGetSongBpmCache()
  }
})

test('GetSongBPM rejects API errors and ambiguous or out-of-range search results', async () => {
  const track = { title: 'Rare Test Recording', artist: 'Example Artist' }
  await assert.rejects(
    getSongBpmTempo(track, { apiKey: 'bad-key', fetchImpl: async () => jsonResponse({ error: 'unauthorized' }, 401) }),
    (error: any) => error.service === 'GetSongBPM' && error.code === 'invalid_api_key' && error.status === 401
  )

  await assert.rejects(
    getSongBpmTempo(track, {
      apiKey: 'test-key',
      fetchImpl: async () => jsonResponse({ search: [
        { id: 'bad-tempo', title: 'Rare Test Recording', tempo: '221', artist: [{ name: 'Example Artist' }] },
        { id: 'wrong-artist', title: 'Rare Test Recording', tempo: '120', artist: [{ name: 'Someone Else' }] }
      ] })
    }),
    (error: any) => error.service === 'GetSongBPM' && error.code === 'track_not_found'
  )
})
