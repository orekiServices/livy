/**
 * TTS source — turns spoken text into a playable radio track, in any of the
 * languages the node speaks.
 *
 *   tts:Good evening, you are listening to iMusic Pro
 *   say:Next up, a listener request from Mai
 *   tts:vi:Chào buổi tối, bạn đang nghe iMusic Pro
 *   say:ja:次は、リスナーからのリクエストです
 *
 * The language can be named in the text (`tts:<lang>:…`), passed by the
 * caller (a station's `language`, a plugin's option) or left to the node
 * default. Used by station intros, owner live announcements and the automix
 * DJ. Audio is rendered once and cached *per language*, so replaying an
 * announcement costs a file read.
 */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { probeMp3 } from '../util/metro.ts'
import { splitLanguage, normaliseLanguage } from '../tts/index.ts'

export class TtsSource {
  declare engine: any

  name = 'tts'
  prefixes = ['tts:', 'say:', 'announce:']

  constructor({ engine }) {
    this.engine = engine
  }

  canResolve(query) {
    const q = String(query).trim().toLowerCase()
    return this.prefixes.some((p) => q.startsWith(p))
  }

  /** Build a track descriptor without rendering audio yet. */
  makeTrack(text, { title = null, bundled = null, file = null, artist = 'Station announcement', language = null }: any = {}) {
    // `vi:xin chào` names its own language; anything else takes the caller's.
    const spoken = splitLanguage(text)
    const tag = normaliseLanguage(language ?? spoken.language ?? this.engine?.language ?? 'en')
    const body = spoken.language ? spoken.text : text

    return {
      source: 'tts',
      id: `tts:${createHash('sha1').update(`${tag}|${body}|${file ?? ''}`).digest('hex').slice(0, 14)}`,
      title: title ?? (body.length > 60 ? `${body.slice(0, 57)}…` : body),
      artist,
      duration: 0,
      artwork: null,
      text: body,
      language: tag,
      bundled,
      file,
      announcement: true,
      bitrate: 128,
      streamable: true
    }
  }

  async resolve(query, { language = null }: any = {}) {
    let text = String(query).trim()
    for (const p of this.prefixes) if (text.toLowerCase().startsWith(p)) text = text.slice(p.length).trim()
    if (!text) throw new Error('Nothing to say')
    const track = this.makeTrack(text, { language })
    return { type: 'track', name: track.text, tracks: [track] }
  }

  /** Languages this node can announce in. */
  async search(query, limit = 20) {
    const q = String(query ?? '').toLowerCase()
    return (this.engine?.languages ?? [])
      .filter((entry) => !q || entry.code.toLowerCase().includes(q) || entry.name.toLowerCase().includes(q))
      .slice(0, limit)
      .map((entry) => ({
        source: 'tts',
        id: `tts:lang:${entry.code}`,
        title: `${entry.native} (${entry.code})`,
        artist: 'Text to speech',
        duration: 0,
        query: `tts:${entry.code}:`,
        language: entry.code,
        streamable: false
      }))
  }

  /**
   * An announcement is a finished MP3 on disk; a browser can play it directly
   * once the render exists. Rendering has a side effect (a cache write), so
   * this is opt-in from the console rather than free.
   */
  async getTrackUrl(track) {
    const rendered = await this.engine.speak(track.text, {
      bundled: track.bundled,
      file: track.file,
      language: track.language
    })
    return rendered?.file ?? null
  }

  async stream(track) {
    const rendered = await this.engine.speak(track.text, {
      bundled: track.bundled,
      file: track.file,
      language: track.language
    })
    // Measure once so the UI can show a real duration for announcements.
    if (!track.duration) {
      try {
        track.duration = Math.round(probeMp3(fs.readFileSync(rendered.file)).durationMs)
      } catch {
        /* non-fatal */
      }
    }
    return {
      stream: createReadStream(rendered.file),
      contentType: 'audio/mpeg',
      mode: `tts:${rendered.provider}`,
      language: rendered.language
    }
  }
}

export default TtsSource
