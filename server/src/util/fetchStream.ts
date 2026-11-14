/**
 * Connect-timeout-only HTTP audio stream fetcher.
 *
 * `AbortSignal.timeout(ms)` passed directly to `fetch()` remains active for the
 * entire lifetime of `res.body`. Because Livy paces upstream reads at 1x real
 * time via backpressure (`bufferAheadMs`), any track longer than the timeout
 * would abort mid-song with `TimeoutError`.
 *
 * This helper applies `connectTimeoutMs` *only* while waiting for response
 * headers, clears the timer immediately once headers arrive, and keeps the
 * caller's `signal` wired so `station.skip()` / `station.stop()` still cancel
 * both the handshake and the active body stream cleanly.
 */
import { Readable } from 'node:stream'

const DETACH_SIGNAL = Symbol('livy.detachSignal')

export interface FetchStreamOptions {
  headers?: Record<string, string>
  redirect?: RequestRedirect
  connectTimeoutMs?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

/**
 * Perform `fetch()` with a connect-only timeout while preserving external
 * abort cancellation across the response body lifetime.
 */
export async function fetchWithConnectTimeout(
  url: string | URL,
  {
    headers,
    redirect = 'follow',
    connectTimeoutMs = 20_000,
    signal,
    fetchImpl = fetch
  }: FetchStreamOptions = {}
): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false

  const onExternalAbort = () => {
    controller.abort(signal?.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' }))
  }

  if (signal) {
    if (signal.aborted) {
      onExternalAbort()
      throw controller.signal.reason
    }
    signal.addEventListener('abort', onExternalAbort, { once: true })
  }

  const detach = () => {
    if (signal) signal.removeEventListener('abort', onExternalAbort)
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  if (connectTimeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort(Object.assign(new Error(`Stream timed out after ${connectTimeoutMs}ms waiting for headers`), { name: 'TimeoutError' }))
    }, connectTimeoutMs)
    timer.unref?.()
  }

  try {
    const res = await fetchImpl(url, { headers, redirect, signal: controller.signal })
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    // Keep external signal wired until the consumer finishes or closes the body.
    ;(res as any)[DETACH_SIGNAL] = detach
    return res
  } catch (error) {
    if (timer) clearTimeout(timer)
    detach()
    if (timedOut) {
      throw Object.assign(new Error(`Stream timed out after ${connectTimeoutMs}ms waiting for headers`), { name: 'TimeoutError' })
    }
    throw error
  }
}

/**
 * Wrap a Fetch `Response.body` into a Node `Readable` stream, detaching any
 * external abort listener when the stream finishes or closes.
 */
export function responseToNodeStream(res: Response, { signal }: { signal?: AbortSignal } = {}): Readable {
  const detach: (() => void) | undefined = (res as any)[DETACH_SIGNAL]
  const body = res.body as any
  if (!body) {
    detach?.()
    throw new Error('Upstream response had an empty body')
  }

  const stream: Readable = typeof body.getReader === 'function' ? Readable.fromWeb(body) : body

  const cleanup = () => {
    detach?.()
    if (signal) signal.removeEventListener('abort', onAbort)
  }

  const onAbort = () => {
    if (!stream.destroyed) stream.destroy(signal?.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' }))
  }

  if (signal && !detach) {
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  stream.once('close', cleanup)
  stream.once('end', cleanup)
  stream.once('error', cleanup)

  return stream
}

export default { fetchWithConnectTimeout, responseToNodeStream }
