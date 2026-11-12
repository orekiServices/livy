/**
 * The only file in the web app that knows the node exists.
 *
 * Everything is same-origin in production — the console is served by the
 * radio node itself — so there is no base URL to configure, nothing to leak
 * and no CORS. In development (`npm run dev` on :3000) it probes the usual
 * ports once, or takes `?node=http://host:2333`.
 */
const REMEMBERED = 'nodecast-node'
const DEV_PORTS = [2333, 8000, 8080, 3001, 4000]

let base = null
let probing = null

const withTimeout = (ms) => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return controller.signal
}

async function isNode(origin) {
  try {
    const res = await fetch(`${origin}/api/v1/info`, { signal: withTimeout(1500), cache: 'no-store' })
    if (!res.ok) return false
    return (await res.json())?.name === 'nodecast'
  } catch {
    return false
  }
}

/** Where the node is. '' means "here", which is the production answer. */
export async function nodeBase() {
  if (base !== null) return base
  if (probing) return probing

  probing = (async () => {
    const asked = new URLSearchParams(window.location.search).get('node')
    const saved = window.localStorage.getItem(REMEMBERED)
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
        else window.localStorage.removeItem(REMEMBERED)
        return candidate
      }
    }
    base = ''
    return ''
  })()

  return probing
}

export function forgetNode() {
  base = null
  probing = null
  window.localStorage.removeItem(REMEMBERED)
}

/** Every request in the app goes through here. */
export async function api(path, { method = 'GET', body, key, signal } = {}) {
  const origin = await nodeBase()
  const res = await fetch(`${origin}${path}`, {
    method,
    signal,
    cache: 'no-store',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'x-owner-key': key } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })

  const payload = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw Object.assign(new Error(payload.message ?? `HTTP ${res.status}`), { status: res.status, payload })
  }
  return payload
}

/** The one canonical listen URL. */
export async function streamUrl(stationId) {
  const origin = await nodeBase()
  return `${origin}/stream/${encodeURIComponent(stationId)}.mp3`
}

export async function socketUrl() {
  const origin = (await nodeBase()) || window.location.origin
  return `${origin.replace(/^http/, 'ws')}/ws`
}

/** Owner-key helpers — the key lives in this tab only, never in a URL. */
const KEY_STORE = 'nodecast-owner-key'
export const ownerKey = () => (typeof window === 'undefined' ? null : window.sessionStorage.getItem(KEY_STORE))
export const setOwnerKey = (key) => window.sessionStorage.setItem(KEY_STORE, key)
export const clearOwnerKey = () => window.sessionStorage.removeItem(KEY_STORE)

export const owner = (path, options = {}) => api(`/api/v1/owner${path}`, { ...options, key: options.key ?? ownerKey() })
