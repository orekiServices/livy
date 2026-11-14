/**
 * The only file in the console that knows the node exists.
 *
 * Everything is same-origin in production, the console is served by the
 * radio node itself, so there is no base URL to configure, nothing to leak
 * and no CORS. In development (`bun run dev` on :3000) it probes the usual
 * ports once, or takes `?node=http://host:2333`.
 */
import type { ApiError, CacheStats, StationSummary, StreamDiagnosis } from './types'

const REMEMBERED = 'livy-node'
const REMEMBERED_LEGACY = 'nodecast-node'
const DEV_PORTS = [2333, 8000, 8080, 3001, 4000]

let base: string | null = null
let probing: Promise<string> | null = null

const withTimeout = (ms: number): AbortSignal => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return controller.signal
}

async function isNode(origin: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/api/v1/info`, { signal: withTimeout(1500), cache: 'no-store' })
    if (!res.ok) return false
    const info = (await res.json()) as { name?: string; legacyNames?: string[] }
    return info?.name === 'livy' || (Array.isArray(info?.legacyNames) && info.legacyNames.includes('nodecast'))
  } catch {
    return false
  }
}

/** Where the node is. '' means "here", which is the production answer. */
export async function nodeBase(): Promise<string> {
  if (base !== null) return base
  if (probing) return probing

  probing = (async () => {
    const asked = new URLSearchParams(window.location.search).get('node')
    const saved = window.localStorage.getItem(REMEMBERED) ?? window.localStorage.getItem(REMEMBERED_LEGACY)
    const candidates = [
      ...(asked ? [asked.replace(/\/$/, '')] : []),
      '',
      ...(saved ? [saved] : []),
      ...DEV_PORTS.map((port) => `${window.location.protocol}//${window.location.hostname}:${port}`)
    ]

    for (const candidate of candidates) {
      if (await isNode(candidate)) {
        base = candidate
        if (candidate) window.localStorage.setItem(REMEMBERED, candidate)
        else {
          window.localStorage.removeItem(REMEMBERED)
          window.localStorage.removeItem(REMEMBERED_LEGACY)
        }
        return candidate
      }
    }
    base = ''
    return ''
  })()

  return probing
}

export function forgetNode(): void {
  base = null
  probing = null
  window.localStorage.removeItem(REMEMBERED)
  window.localStorage.removeItem(REMEMBERED_LEGACY)
}

export interface ApiOptions {
  method?: string
  body?: unknown
  key?: string | null
  signal?: AbortSignal
}

/** Every request in the app goes through here. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api<T = any>(path: string, { method = 'GET', body, key, signal }: ApiOptions = {}): Promise<T> {
  const origin = await nodeBase()
  const res = await fetch(`${origin}${path}`, {
    method,
    signal,
    cache: 'no-store',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'x-owner-key': key } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })

  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const err = new Error(typeof payload.message === 'string' ? payload.message : `HTTP ${res.status}`) as ApiError
    err.status = res.status
    err.payload = payload
    throw err
  }
  return payload as T
}

/** The one canonical listen URL. */
export async function streamUrl(stationId: string): Promise<string> {
  const origin = await nodeBase()
  return `${origin}/stream/${encodeURIComponent(stationId)}.mp3`
}

/**
 * Probe a stream endpoint with HEAD + Accept: application/json to distinguish
 * permanent stream errors (404, 403, 501, 503 off-air/full) from transient
 * network disconnects.
 */
export async function diagnoseStream(stationId: string): Promise<StreamDiagnosis> {
  const url = await streamUrl(stationId)
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      cache: 'no-store',
      signal: withTimeout(4000),
      headers: { accept: 'application/json' }
    })
    const code = res.headers.get('x-livy-error') ?? null
    const reason = res.headers.get('x-livy-reason') ?? null
    if (res.ok) return { ok: true, status: res.status, code: null, reason: null, message: null, terminal: false }

    let message = `HTTP ${res.status}`
    try {
      const detail = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        signal: withTimeout(4000),
        headers: { accept: 'application/json' }
      })
      const body = (await detail.json().catch(() => null)) as { message?: string } | null
      if (body?.message) message = body.message
    } catch {
      /* fall back to status text */
    }

    const terminal =
      res.status === 404 ||
      res.status === 403 ||
      res.status === 501 ||
      code === 'off_air' ||
      code === 'unknown_station' ||
      code === 'banned' ||
      code === 'stream_unavailable' ||
      code === 'at_capacity'

    return { ok: false, status: res.status, code, reason, message, terminal }
  } catch (error) {
    const err = error as Error | undefined
    return {
      ok: false,
      status: 0,
      code: 'network_error',
      reason: 'network',
      message: err?.name === 'AbortError' ? 'Stream timed out' : 'Cannot reach radio stream',
      terminal: false
    }
  }
}

export async function socketUrl(): Promise<string> {
  const origin = (await nodeBase()) || window.location.origin
  return `${origin.replace(/^http/, 'ws')}/ws`
}

const KEY_STORE = 'livy-owner-key'
const KEY_STORE_LEGACY = 'nodecast-owner-key'

export const ownerKey = (): string | null => {
  if (typeof window === 'undefined') return null
  const key = window.sessionStorage.getItem(KEY_STORE) ?? window.sessionStorage.getItem(KEY_STORE_LEGACY)
  if (key && !window.sessionStorage.getItem(KEY_STORE)) window.sessionStorage.setItem(KEY_STORE, key)
  return key
}

export const setOwnerKey = (key: string): void => {
  window.sessionStorage.setItem(KEY_STORE, key)
  window.sessionStorage.removeItem(KEY_STORE_LEGACY)
}

export const clearOwnerKey = (): void => {
  window.sessionStorage.removeItem(KEY_STORE)
  window.sessionStorage.removeItem(KEY_STORE_LEGACY)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const owner = <T = any>(path: string, options: ApiOptions = {}): Promise<T> =>
  api<T>(`/api/v1/owner${path}`, { ...options, key: options.key ?? ownerKey() })

/** Owner cache endpoints. */
export const ownerCache = (limit = 50): Promise<CacheStats> =>
  owner<CacheStats>(`/cache?limit=${encodeURIComponent(limit)}`)
export const ownerClearCache = (scope: 'all' | 'memory' | 'audio' = 'all'): Promise<CacheStats> =>
  owner<CacheStats>('/cache/clear', { method: 'POST', body: { scope } })
export const ownerEvictCache = (hash: string): Promise<{ ok?: boolean; removed?: boolean }> =>
  owner(`/cache/${encodeURIComponent(hash)}`, { method: 'DELETE' })

export async function stationStream(stationId: string): Promise<string> {
  return streamUrl(stationId)
}

/** A listenable URL straight from a station row, if it has one. */
export const streamOf = (station: Partial<StationSummary> | null | undefined): string =>
  station?.stream ? station.stream : `/stream/${encodeURIComponent(station?.id ?? '')}.mp3`
