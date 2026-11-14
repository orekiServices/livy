/**
 * Raw-socket HTTP/ICY client.
 *
 * Node's built-in http client refuses Shoutcast v1 responses because they start
 * with `ICY 200 OK` instead of `HTTP/1.x 200 OK`, so we speak HTTP ourselves on
 * a plain net/tls socket. This also lets us keep the connection fully streaming
 * (no buffering) and read the non-standard `icy-*` headers.
 *
 * Exports:
 *   connectStream(url, opts) -> { statusCode, statusMessage, headers, url, socket, body }
 *   IcyDeinterleaver          -> Transform that strips + emits ICY metadata blocks
 *   parseIcyMetadata(string)  -> { StreamTitle, StreamUrl, ... }
 *   buildIcyMetadataBlock(s)  -> Buffer, padded to 16-byte frames (for serving)
 */
import net from 'node:net'
import tls from 'node:tls'
import { Transform, PassThrough } from 'node:stream'

const CRLF2 = Buffer.from('\r\n\r\n')
// Some Icecast/Shoutcast deployments (SomaFM among them) silently drop
// connections from unfamiliar user agents, so present a conventional one.
const DEFAULT_UA = 'Mozilla/5.0 (compatible; radio-node/1.0; +icy-client)'

/* ------------------------------------------------------------------ *
 * Chunked transfer-encoding decoder (some Icecast proxies use it)
 * ------------------------------------------------------------------ */
class ChunkedDecoder extends Transform {
  declare push: any

  #buffer = Buffer.alloc(0)
  #remaining = 0
  #state = 'size' // size | data | crlf | trailer | done

  _transform(chunk, _enc, cb) {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk

    try {
      for (;;) {
        if (this.#state === 'done') return cb()

        if (this.#state === 'size') {
          const idx = this.#buffer.indexOf('\r\n')
          if (idx === -1) return cb()
          const line = this.#buffer.subarray(0, idx).toString('latin1').split(';')[0].trim()
          const size = Number.parseInt(line, 16)
          if (Number.isNaN(size)) throw new Error(`Invalid chunk size: "${line}"`)
          this.#buffer = this.#buffer.subarray(idx + 2)
          this.#remaining = size
          this.#state = size === 0 ? 'done' : 'data'
          if (size === 0) {
            this.push(null)
            return cb()
          }
          continue
        }

        if (this.#state === 'data') {
          if (this.#buffer.length === 0) return cb()
          const take = Math.min(this.#remaining, this.#buffer.length)
          this.push(this.#buffer.subarray(0, take))
          this.#buffer = this.#buffer.subarray(take)
          this.#remaining -= take
          if (this.#remaining === 0) this.#state = 'crlf'
          continue
        }

        if (this.#state === 'crlf') {
          if (this.#buffer.length < 2) return cb()
          this.#buffer = this.#buffer.subarray(2)
          this.#state = 'size'
        }
      }
    } catch (error) {
      cb(error)
    }
  }
}

/* ------------------------------------------------------------------ *
 * ICY metadata de-interleaver
 * ------------------------------------------------------------------ *
 * Upstream sends: [metaint audio bytes][1 length byte][length*16 meta bytes]...
 * We forward only audio downstream and emit `metadata` events.
 */
export class IcyDeinterleaver extends Transform {
  declare emit: any
  declare push: any

  #metaint
  #counter = 0
  #metaLength = 0
  #metaBuffer = null
  #metaOffset = 0
  #state = 'audio' // audio | length | meta

  constructor(metaint) {
    super()
    if (!Number.isInteger(metaint) || metaint <= 0) throw new TypeError('metaint must be a positive integer')
    this.#metaint = metaint
  }

  _transform(chunk, _enc, cb) {
    let offset = 0

    while (offset < chunk.length) {
      if (this.#state === 'audio') {
        const need = this.#metaint - this.#counter
        const take = Math.min(need, chunk.length - offset)
        this.push(chunk.subarray(offset, offset + take))
        offset += take
        this.#counter += take
        if (this.#counter === this.#metaint) {
          this.#counter = 0
          this.#state = 'length'
        }
        continue
      }

      if (this.#state === 'length') {
        this.#metaLength = chunk[offset++] * 16
        if (this.#metaLength === 0) {
          this.#state = 'audio'
        } else {
          this.#metaBuffer = Buffer.allocUnsafe(this.#metaLength)
          this.#metaOffset = 0
          this.#state = 'meta'
        }
        continue
      }

      // state === 'meta'
      const take = Math.min(this.#metaLength - this.#metaOffset, chunk.length - offset)
      chunk.copy(this.#metaBuffer, this.#metaOffset, offset, offset + take)
      this.#metaOffset += take
      offset += take

      if (this.#metaOffset === this.#metaLength) {
        const raw = this.#metaBuffer.toString('utf8').replace(/\0+$/, '').trim()
        this.#metaBuffer = null
        this.#state = 'audio'
        if (raw.length > 0) this.emit('metadata', raw)
      }
    }

    cb()
  }
}

/* ------------------------------------------------------------------ *
 * Metadata string helpers
 * ------------------------------------------------------------------ */
export function parseIcyMetadata(raw: string | Buffer): Record<string, string> {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
  const out: Record<string, string> = {}
  // StreamTitle='foo';StreamUrl='bar';  (values may contain ' but not ';)
  const re = /([A-Za-z0-9_-]+)=(?:'([^']*)'|"([^"]*)"|([^;]*));?/g
  let match
  while ((match = re.exec(text)) !== null) {
    const key = match[1]
    const value = (match[2] ?? match[3] ?? match[4] ?? '').trim()
    if (key) out[key] = value
  }
  return out
}

export function buildIcyMetadataBlock(title: string, streamUrl?: string) {
  if (!title) return Buffer.from([0])
  const safeTitle = String(title).replace(/'/g, '`').slice(0, 1000)
  let payload = `StreamTitle='${safeTitle}';`
  if (streamUrl) payload += `StreamUrl='${String(streamUrl).replace(/'/g, '')}';`

  const bytes = Buffer.from(payload, 'utf8')
  const blocks = Math.ceil(bytes.length / 16)
  const out = Buffer.alloc(1 + blocks * 16)
  out[0] = blocks
  bytes.copy(out, 1)
  return out
}

/* ------------------------------------------------------------------ *
 * Request
 * ------------------------------------------------------------------ */
function parseStatusLine(line) {
  // "ICY 200 OK" | "HTTP/1.0 200 OK" | "HTTP/1.1 302 Found"
  const parts = line.split(' ')
  const protocol = parts[0] ?? ''
  const statusCode = Number.parseInt(parts[1] ?? '', 10)
  return {
    protocol,
    statusCode: Number.isNaN(statusCode) ? 0 : statusCode,
    statusMessage: parts.slice(2).join(' ')
  }
}

function parseHeaders(block) {
  const lines = block.split('\r\n')
  const status = parseStatusLine(lines.shift() ?? '')
  const headers: Record<string, string> = {}
  for (const line of lines) {
    if (!line) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    headers[key] = key in headers ? `${headers[key]}, ${value}` : value
  }
  return { ...status, headers }
}

/**
 * Open a streaming connection to an HTTP/ICY endpoint.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {boolean} [options.metadata=true]  send `Icy-MetaData: 1`
 * @param {object} [options.headers]
 * @param {number} [options.timeout=15000]   header/idle timeout in ms
 * @param {number} [options.maxRedirects=5]
 * @param {AbortSignal} [options.signal]
 */
export function connectStream(url: string, options: any = {}): Promise<{
  statusCode: number
  statusMessage: string
  protocol: string
  headers: Record<string, string>
  socket: any
  body: PassThrough
  url: string
}> {
  const {
    metadata = true,
    headers: extraHeaders = {},
    timeout = 15_000,
    maxRedirects = 5,
    signal,
    userAgent = DEFAULT_UA,
    _redirects = 0
  } = options

  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch {
      return reject(new Error(`Invalid stream URL: ${url}`))
    }

    // icyx:// / icy:// are common aliases in station directories
    const protocol = target.protocol.replace('icyx:', 'http:').replace('icy:', 'http:')
    const secure = protocol === 'https:'
    if (!secure && protocol !== 'http:') return reject(new Error(`Unsupported protocol: ${target.protocol}`))

    const port = target.port ? Number(target.port) : secure ? 443 : 80
    const path = `${target.pathname || '/'}${target.search || ''}`

    const socket = secure
      ? tls.connect({ host: target.hostname, port, servername: target.hostname, ALPNProtocols: ['http/1.1'] })
      : net.connect({ host: target.hostname, port })

    let settled = false
    let buffer = Buffer.alloc(0)

    const cleanup = () => {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(error)
    }

    const timer = setTimeout(() => fail(new Error(`Timed out after ${timeout}ms waiting for headers from ${url}`)), timeout)
    const onAbort = () => fail(new Error('Aborted'))
    if (signal) {
      if (signal.aborted) return fail(new Error('Aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
    }

    const onError = (error) => fail(error)
    const onClose = () => fail(new Error(`Connection closed before headers were received (${url})`))

    function onData(chunk) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
      const end = buffer.indexOf(CRLF2)
      if (end === -1) {
        if (buffer.length > 64 * 1024) fail(new Error('Header block too large'))
        return
      }

      const head = buffer.subarray(0, end).toString('latin1')
      const rest = buffer.subarray(end + 4)
      const { protocol: proto, statusCode, statusMessage, headers } = parseHeaders(head)

      settled = true
      cleanup()

      // Redirects
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        socket.destroy()
        if (_redirects >= maxRedirects) return reject(new Error(`Too many redirects for ${url}`))
        const next = new URL(headers.location, target).toString()
        return resolve(connectStream(next, { ...options, _redirects: _redirects + 1 }))
      }

      if (statusCode !== 200 && statusCode !== 206) {
        socket.destroy()
        return reject(Object.assign(new Error(`Upstream responded ${statusCode} ${statusMessage} (${url})`), { statusCode, headers }))
      }

      const body = new PassThrough({ highWaterMark: 512 * 1024 })
      const chunked = /chunked/i.test(headers['transfer-encoding'] ?? '')

      if (chunked) {
        const decoder = new ChunkedDecoder()
        decoder.on('error', (error) => body.destroy(error))
        socket.pipe(decoder).pipe(body)
        if (rest.length) decoder.write(rest)
      } else {
        socket.pipe(body)
        if (rest.length) body.write(rest)
      }

      socket.on('error', (error) => body.destroy(error))
      body.on('close', () => socket.destroy())

      resolve({
        url: target.toString(),
        protocol: proto,
        statusCode,
        statusMessage,
        headers,
        socket,
        body
      })
    }

    socket.setNoDelay(true)
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    socket.once(secure ? 'secureConnect' : 'connect', sendRequest)

    function sendRequest() {
      const head = [
        `GET ${path} HTTP/1.1`,
        `Host: ${target.host}`,
        `User-Agent: ${userAgent}`,
        'Accept: */*',
        'Connection: close',
        ...(metadata ? ['Icy-MetaData: 1'] : []),
        ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
        '',
        ''
      ].join('\r\n')
      socket.write(head)
    }
  })
}

export default { connectStream, IcyDeinterleaver, parseIcyMetadata, buildIcyMetadataBlock }
