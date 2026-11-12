/**
 * Static file plumbing, shared by the core HTTP layer and the plugin host.
 *
 * One implementation means one set of rules about what may leave the disk:
 * the resolved path must stay inside the root it was resolved against, and a
 * response never advertises a type it did not check.
 */
import fs from 'node:fs'
import path from 'node:path'

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.webmanifest': 'application/manifest+json'
}

export const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'

/**
 * Turn a URL path into a file inside `root`, or null.
 *
 * Handles the three shapes a static site needs: the file itself, `dir/index.html`
 * and `page.html` — never anything above the root, whatever the URL contains.
 *
 * @returns {string|null}
 */
export function resolveStaticFile(root, urlPath, { index = 'index.html' } = {}) {
  if (!root) return null
  let clean
  try {
    clean = decodeURIComponent(String(urlPath).split('?')[0])
  } catch {
    return null // malformed percent-encoding
  }
  if (clean.includes('\0')) return null

  const rel = path.normalize(clean).replace(/^([/\\]|\.\.[/\\])+/, '')
  const base = path.resolve(root)
  const candidates = [path.join(base, rel)]
  if (!path.extname(rel)) {
    candidates.push(path.join(base, rel, index), path.join(base, `${rel.replace(/[/\\]$/, '')}.html`))
  }
  if (rel === '' || rel === '.') candidates.push(path.join(base, index))

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate)
    if (resolved !== base && !resolved.startsWith(base + path.sep)) continue
    try {
      if (fs.statSync(resolved).isFile()) return resolved
    } catch {
      /* next candidate */
    }
  }
  return null
}

/** Stream a file out with the right type and cache policy. */
export function sendFile(res, file, { status = 200, headers = {}, immutable = null, download = null } = {}) {
  const stat = fs.statSync(file)
  const forever = immutable ?? file.includes(`${path.sep}_next${path.sep}static${path.sep}`)
  res.writeHead(status, {
    'content-type': mimeOf(file),
    'content-length': stat.size,
    'cache-control': forever ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
    ...(download ? { 'content-disposition': `attachment; filename="${path.basename(file)}"` } : {}),
    ...headers
  })
  fs.createReadStream(file).pipe(res)
  return true
}

/** Files under `dir`, recursively, as paths relative to it. */
export function listFiles(dir, { filter = () => true, base = dir } = {}) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, { filter, base }))
    else if (filter(full)) out.push(path.relative(base, full))
  }
  return out
}

export default { MIME, mimeOf, resolveStaticFile, sendFile, listFiles }
