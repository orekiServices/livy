/**
 * Isolated, owner-only MP3 editor input handling. Nothing here reads station
 * queues, plays audio, or persists uploaded files in Livy's data directory.
 */
import { lookup } from 'node:dns/promises'
import fs from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { isIP } from 'node:net'
import { renderAutomixMp3 } from './cli.ts'

export const EDITOR_MAX_MP3_BYTES = 12 * 1024 * 1024
export const EDITOR_MAX_JSON_BYTES = 34 * 1024 * 1024
const LINK_TIMEOUT_MS = 25_000
const MAX_REDIRECTS = 4
const ALLOWED_CONTENT_TYPES = new Set(['audio/mpeg', 'audio/mp3', 'audio/x-mpeg', 'application/octet-stream', 'binary/octet-stream'])

function inputError(message: string, status = 400) {
  return Object.assign(new Error(message), { status })
}

function isPublicIpv4(address: string) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b, c, d] = parts
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && c <= 2) return false
  if (a === 192 && b === 88 && c === 99) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (a === 255 && b === 255 && c === 255 && d === 255) return false
  return true
}

function mappedIpv4(address: string) {
  const value = address.toLowerCase().split('%')[0]
  if (!value.startsWith('::ffff:')) return null
  const tail = value.slice('::ffff:'.length)
  if (tail.includes('.')) return tail
  const words = tail.split(':')
  if (words.length !== 2 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null
  const high = Number.parseInt(words[0], 16)
  const low = Number.parseInt(words[1], 16)
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

export function isPublicAddress(address: string) {
  const family = isIP(address)
  if (family === 4) return isPublicIpv4(address)
  if (family !== 6) return false
  const mapped = mappedIpv4(address)
  if (mapped) return isPublicIpv4(mapped)

  const words = address.toLowerCase().split('%')[0].split(':').filter(Boolean)
  const first = Number.parseInt(words[0] || '0', 16)
  const second = Number.parseInt(words[1] || '0', 16)
  // Only global unicast (2000::/3); block special-purpose, documentation,
  // Teredo, 6to4, and documentation-only 3fff::/20 ranges too.
  if (first < 0x2000 || first > 0x3fff || first === 0x2002) return false
  if (first === 0x2001 && second <= 0x01ff) return false
  if (first === 0x2001 && second === 0x0db8) return false
  if (first === 0x3fff && second <= 0x0fff) return false
  return true
}

async function resolvePublicTarget(value: string, base?: URL) {
  let url: URL
  try {
    url = new URL(value, base)
  } catch {
    throw inputError('Enter a valid direct MP3 URL.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw inputError('MP3 links must use public HTTP or HTTPS URLs without credentials.')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!hostname || hostname === 'localhost' || /\.(localhost|local|internal|test|invalid|example)$/.test(hostname)) {
    throw inputError('That MP3 link is not a public internet address.')
  }
  const expectedPort = url.protocol === 'https:' ? '443' : '80'
  if (url.port && url.port !== expectedPort) throw inputError('MP3 links may use only the standard HTTP or HTTPS port.')

  let addresses: Array<{ address: string; family: number }>
  try {
    const literalFamily = isIP(hostname)
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw inputError('Could not resolve that MP3 link.', 400)
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw inputError('That MP3 link must resolve only to public internet addresses.')
  }
  return { url, address: addresses[0] }
}

function requestPinnedMp3(url: URL, address: { address: string; family: number }): Promise<Buffer | { redirect: string }> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http
    const pinnedLookup = (_hostname: string, options: any, callback?: any) => {
      const done = typeof options === 'function' ? options : callback
      if (typeof done !== 'function') return
      if (options && typeof options === 'object' && options.all) {
        done(null, [{ address: address.address, family: address.family }])
      } else {
        done(null, address.address, address.family)
      }
    }
    const request = client.request(url, {
      method: 'GET',
      headers: { accept: 'audio/mpeg, audio/mp3, application/octet-stream' },
      lookup: pinnedLookup
    }, (response) => {
      const status = Number(response.statusCode) || 0
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location
        response.resume()
        if (!location) return reject(inputError('The MP3 link redirected without a destination.'))
        return resolve({ redirect: location })
      }
      if (status !== 200) {
        response.resume()
        return reject(inputError(`The MP3 link returned HTTP ${status}.`))
      }

      const contentType = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (contentType && !ALLOWED_CONTENT_TYPES.has(contentType)) {
        response.destroy()
        return reject(inputError('The link did not return an MP3 file.'))
      }
      const contentLength = Number(response.headers['content-length'])
      if (Number.isFinite(contentLength) && contentLength > EDITOR_MAX_MP3_BYTES) {
        response.destroy()
        return reject(inputError('Each MP3 must be 12 MiB or smaller.', 413))
      }

      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += bytes.length
        if (size > EDITOR_MAX_MP3_BYTES) {
          response.destroy()
          request.destroy()
          reject(inputError('Each MP3 must be 12 MiB or smaller.', 413))
          return
        }
        chunks.push(bytes)
      })
      response.on('end', () => resolve(Buffer.concat(chunks, size)))
      response.on('error', () => reject(inputError('The MP3 link could not be downloaded.')))
    })
    const deadline = setTimeout(() => request.destroy(inputError('The MP3 link timed out.', 408)), LINK_TIMEOUT_MS)
    deadline.unref?.()
    request.on('close', () => clearTimeout(deadline))
    request.on('error', (error: any) => reject(error?.status ? error : inputError('The MP3 link could not be downloaded.')))
    request.end()
  })
}

async function downloadPublicMp3(value: string, redirects = 0): Promise<Buffer> {
  if (redirects > MAX_REDIRECTS) throw inputError('The MP3 link redirected too many times.')
  const target = await resolvePublicTarget(value)
  const response = await requestPinnedMp3(target.url, target.address)
  if (Buffer.isBuffer(response)) {
    if (!response.length) throw inputError('The MP3 link returned an empty file.')
    return response
  }
  const next = new URL(response.redirect, target.url).toString()
  return downloadPublicMp3(next, redirects + 1)
}

async function getInput(input: any, label: string) {
  if (!input || typeof input !== 'object') throw inputError(`Choose an MP3 file or direct MP3 link for ${label}.`)
  const hasFile = typeof input.base64 === 'string' && input.base64.length > 0
  const hasUrl = typeof input.url === 'string' && input.url.trim().length > 0
  if (hasFile === hasUrl) throw inputError(`Choose exactly one MP3 file or link for ${label}.`)

  if (hasFile) {
    if (input.name && !/\.mp3$/i.test(String(input.name))) throw inputError(`${label} must be an .mp3 file.`)
    const encoded = String(input.base64)
    if (encoded.length > Math.ceil(EDITOR_MAX_MP3_BYTES * 4 / 3) + 4) {
      throw inputError('Each MP3 must be 12 MiB or smaller.', 413)
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw inputError(`The ${label} MP3 upload is malformed.`)
    }
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length > EDITOR_MAX_MP3_BYTES) throw inputError('Each MP3 must be 12 MiB or smaller.', 413)
    if (bytes.toString('base64') !== encoded) throw inputError(`The ${label} MP3 upload is malformed.`)
    return bytes
  }

  if (String(input.url).length > 2048) throw inputError('MP3 links must be no longer than 2048 characters.')
  return downloadPublicMp3(String(input.url).trim())
}

function safeRenderError(error: any) {
  const message = String(error?.message ?? '')
  if (/^(Outgoing|Incoming) MP3 is too short/.test(message)) return message
  if (/^Automix could not render/.test(message)) return message
  if (/^--[\w-]+/.test(message)) return message
  if (/No valid MP3 audio frames found/.test(message)) return 'Both inputs must contain valid MP3 audio frames.'
  return 'Could not render that transition. Check the MP3 files and try a shorter crossfade.'
}

/** Resolve two user-supplied MP3 inputs and render into a disposable directory. */
export async function renderEditorTransition(body: any = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'livy-automix-editor-'))
  try {
    const [outgoingBytes, incomingBytes] = await Promise.all([
      getInput(body.outgoing, 'outgoing'),
      getInput(body.incoming, 'incoming')
    ])
    const outgoingFile = path.join(tempDir, 'outgoing.mp3')
    const incomingFile = path.join(tempDir, 'incoming.mp3')
    const outputFile = path.join(tempDir, 'transition.mp3')
    await Promise.all([
      fs.writeFile(outgoingFile, outgoingBytes),
      fs.writeFile(incomingFile, incomingBytes)
    ])
    const result = await renderAutomixMp3({
      outgoing: outgoingFile,
      incoming: incomingFile,
      output: outputFile,
      outgoingTitle: String(body.outgoing?.title ?? '').slice(0, 160) || undefined,
      outgoingArtist: String(body.outgoing?.artist ?? '').slice(0, 160) || undefined,
      incomingTitle: String(body.incoming?.title ?? '').slice(0, 160) || undefined,
      incomingArtist: String(body.incoming?.artist ?? '').slice(0, 160) || undefined,
      crossfadeMs: body.options?.crossfadeMs,
      preRollMs: body.options?.preRollMs,
      bitrate: body.options?.bitrate,
      curve: body.options?.curve,
      smart: body.options?.smart !== false,
      beatmatch: false
    })
    const mp3 = await fs.readFile(outputFile)
    return { mp3, report: result.report, durationMs: result.durationMs, preRollMs: result.preRollMs }
  } catch (error: any) {
    if (error?.status) throw error
    throw inputError(safeRenderError(error), 400)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}
