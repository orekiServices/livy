/**
 * Local source: an audio library under ./media (or `local:` / absolute paths).
 * Jingles, station IDs, offline fallback content — and whole music folders.
 *
 * MP3 is aired byte for byte. Anything else MetroS can decode (FLAC, M4A,
 * Ogg, WAV, Opus-in-Matroska…) is transcoded on the way out, so a library
 * does not have to be converted before it can be broadcast.
 */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import { paths } from '../config.js'
import { engineInfo } from '../util/metro.js'

/** Always playable. */
const NATIVE = /\.mp3$/i
/** Playable when libmetro is present — decoded and re-encoded on the fly. */
const DECODABLE = /\.(flac|m4a|mp4|aac|ogg|oga|opus|wav|aiff?|alac|wma|mkv|webm|caf)$/i

export class LocalSource {
  name = 'local'
  prefixes = ['local:', 'file:']

  constructor({ dir } = {}) {
    this.dir = dir ?? path.join(paths.root, 'media')
  }

  /** Which extensions this node can actually play right now. */
  get playable() {
    return engineInfo().native ? [NATIVE, DECODABLE] : [NATIVE]
  }

  #plays(name) {
    return this.playable.some((pattern) => pattern.test(name))
  }

  canResolve(query) {
    const q = String(query).trim()
    if (this.prefixes.some((p) => q.toLowerCase().startsWith(p))) return true
    return this.#plays(q) && !/^https?:/i.test(q)
  }

  #list(dir) {
    const out = []
    if (!fs.existsSync(dir)) return out
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...this.#list(full))
      else if (this.#plays(entry.name)) out.push(full)
    }
    return out
  }

  #track(file) {
    const base = path.basename(file, path.extname(file))
    // "Artist - Title" is the convention; "01 Artist - Title" and
    // "01. Artist - Title" are what rips actually look like.
    const stripped = base.replace(/^\d{1,3}[\.\-_ ]\s*/, '')
    const [artist, title] = stripped.includes(' - ') ? stripped.split(/\s+-\s+/) : [null, stripped]
    const stat = fs.statSync(file)
    const format = path.extname(file).slice(1).toLowerCase()
    return {
      source: 'local',
      format,
      // Anything that is not MP3 goes through MetroS on the way out.
      transcode: !NATIVE.test(file),
      id: `local:${createHash('sha1').update(file).digest('hex').slice(0, 16)}`,
      title: title ?? stripped,
      artist: artist ?? 'Local library',
      duration: 0, // measured while streaming
      artwork: null,
      url: file,
      size: stat.size,
      streamable: true
    }
  }

  async resolve(query) {
    let target = String(query).trim()
    for (const p of this.prefixes) if (target.toLowerCase().startsWith(p)) target = target.slice(p.length)
    const full = path.isAbsolute(target) ? target : path.join(this.dir, target)

    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      return { type: 'playlist', name: path.basename(full), tracks: this.#list(full).map((f) => this.#track(f)) }
    }
    if (!fs.existsSync(full)) throw new Error(`Local file not found: ${target}`)
    return { type: 'track', name: path.basename(full), tracks: [this.#track(full)] }
  }

  async stream(track) {
    if (!fs.existsSync(track.url)) throw new Error(`Local file vanished: ${path.basename(track.url)}`)
    return {
      stream: createReadStream(track.url),
      contentType: track.transcode ? `audio/${track.format ?? 'octet-stream'}` : 'audio/mpeg',
      transcode: Boolean(track.transcode),
      mode: 'local'
    }
  }

  /** Only files this copy of the node can actually serve. */
  getTrackUrl(track) {
    return fs.existsSync(track.url) ? track.url : null
  }
}

export default LocalSource
