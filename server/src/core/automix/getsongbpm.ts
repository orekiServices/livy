/** Optional service-backed tempo lookup; Automix calls this only when a key is configured. */
import { MemoryLruCache } from '../cache.ts'

const BASE_URL = 'https://api.getsong.co'
const REQUEST_TIMEOUT_MS = 10_000
const cache = new MemoryLruCache({ name: 'getsongbpm', ttlMs: 6 * 60 * 60_000, maxEntries: 500 })

export class GetSongBpmServiceError extends Error {
  service = 'GetSongBPM'
  code: string
  status: number | null

  constructor(code: string, message: string, status: number | null = null) {
    super(message)
    this.name = 'GetSongBpmServiceError'
    this.code = code
    this.status = status
  }
}

function apiKeyFromEnv(env: Record<string, string | undefined> = process.env) {
  return String(env.GETSONGBPM_API_KEY ?? env.LIVY_GETSONGBPM_API_KEY ?? '').trim()
}

export function getSongBpmStatus(env: Record<string, string | undefined> = process.env) {
  const configured = Boolean(apiKeyFromEnv(env))
  return {
    service: 'GetSongBPM',
    configured,
    state: configured ? 'credential-configured' : 'missing-credential',
    credential: 'GETSONGBPM_API_KEY',
    docs: 'https://getsongbpm.com/api'
  }
}

const normalise = (value: unknown) => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
  .replace(/\b(remaster(ed)?|radio edit|single version|official video|lyrics?)\b/g, ' ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim()

function tokenScore(expected: string, actual: string) {
  if (!expected || !actual) return 0
  if (expected === actual) return 1
  if (expected.includes(actual) || actual.includes(expected)) return 0.82
  const a = new Set(expected.split(' '))
  const b = new Set(actual.split(' '))
  let common = 0
  for (const token of a) if (b.has(token)) common += 1
  return common / Math.max(a.size, b.size)
}

function artistNames(value: any): string[] {
  const artists = Array.isArray(value) ? value : value ? [value] : []
  return artists.map((artist) => typeof artist === 'string' ? artist : artist?.name).filter(Boolean).map(String)
}

function matchTempo(track: any, rows: any[]) {
  const wantedTitle = normalise(track?.title)
  const wantedArtist = normalise(track?.artist)
  if (!wantedTitle) return null

  const matches = rows.map((row) => {
    const titleScore = tokenScore(wantedTitle, normalise(row?.title))
    const names = artistNames(row?.artist).map(normalise)
    const artistScore = wantedArtist
      ? names.length ? Math.max(...names.map((name) => tokenScore(wantedArtist, name))) : 0
      : 0.7
    const tempo = Number(row?.tempo)
    const score = 0.72 * titleScore + 0.28 * artistScore
    return { row, tempo, titleScore, artistScore, score }
  }).filter((candidate) =>
    Number.isFinite(candidate.tempo) && candidate.tempo >= 40 && candidate.tempo <= 220 &&
    candidate.titleScore >= 0.65 && (!wantedArtist || candidate.artistScore >= 0.45)
  ).sort((a, b) => b.score - a.score)

  const best = matches[0]
  if (!best) return null
  const artist = artistNames(best.row.artist)[0] ?? null
  return {
    tempo: best.tempo,
    confidence: Number(Math.min(1, best.score).toFixed(3)),
    id: String(best.row.id ?? ''),
    title: String(best.row.title ?? track.title),
    artist,
    uri: best.row.uri ? String(best.row.uri) : null
  }
}

/**
 * Look up a track's published tempo. Search results are matched on both title
 * and artist; a loose title-only match is rejected rather than beatmatching to
 * the wrong recording.
 */
export async function getSongBpmTempo(track: any, {
  apiKey = apiKeyFromEnv(),
  fetchImpl = globalThis.fetch,
  signal = null
}: any = {}) {
  if (!apiKey) {
    throw new GetSongBpmServiceError(
      'missing_api_key',
      'GetSongBPM service error: API credential is missing; set GETSONGBPM_API_KEY.'
    )
  }
  if (typeof fetchImpl !== 'function') {
    throw new GetSongBpmServiceError('fetch_unavailable', 'GetSongBPM service error: HTTP fetch is unavailable.')
  }

  const title = String(track?.title ?? '').trim()
  const artist = String(track?.artist ?? '').trim()
  if (!title) {
    throw new GetSongBpmServiceError('track_metadata_missing', 'GetSongBPM service error: track title is missing.')
  }
  const query = artist ? `song:${title} artist:${artist}` : `song:${title}`
  const cacheKey = `${normalise(title)}|${normalise(artist)}`

  try {
    return await cache.getOrLoad(cacheKey, async () => {
      const url = new URL('/search/', BASE_URL)
      url.searchParams.set('type', 'both')
      url.searchParams.set('lookup', query)
      url.searchParams.set('limit', '10')

      let response: Response
      try {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'application/json', 'X-API-KEY': apiKey },
          signal: requestSignal
        })
      } catch (error: any) {
        if (error?.name === 'AbortError' && signal?.aborted) throw error
        throw new GetSongBpmServiceError('network_error', `GetSongBPM service error: request failed (${error?.message ?? error}).`)
      }

      let payload: any
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403
          ? 'invalid_api_key'
          : response.status === 429 ? 'rate_limited' : 'http_error'
        const detail = response.status === 401 || response.status === 403
          ? 'credential was rejected'
          : response.status === 429 ? 'request limit reached' : `HTTP ${response.status}`
        throw new GetSongBpmServiceError(code, `GetSongBPM service error: ${detail}.`, response.status)
      }

      const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.search) ? payload.search : []
      const result = matchTempo(track, rows)
      if (!result) {
        throw new GetSongBpmServiceError(
          'track_not_found',
          `GetSongBPM service error: no reliable tempo match for "${title}"${artist ? ` by ${artist}` : ''}.`
        )
      }
      return result
    }, { shouldCache: Boolean })
  } catch (error: any) {
    if (error?.service === 'GetSongBPM') throw error
    if (signal?.aborted) throw error
    throw new GetSongBpmServiceError('request_failed', `GetSongBPM service error: ${error?.message ?? error}.`)
  }
}

/** Test/owner reset hook; never exposes cached API credentials. */
export function clearGetSongBpmCache() {
  return cache.clear()
}
