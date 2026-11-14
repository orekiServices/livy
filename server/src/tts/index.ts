/**
 * TTS engine — station idents, owner announcements, the automix DJ and the
 * spoken errors a listener hears when a stream will not play.
 *
 * Where a phrase comes from, in order:
 *   1. `bundled`  a pre-rendered MP3 shipped in media/tts/<id>.mp3
 *   2. `file`     an owner-supplied path or URL (always wins when configured)
 *   3. the chosen speech service — `google` (no key, one voice per language)
 *      or `flowery` (2,000 voices over fourteen engines, also no key)
 *   4. the *other* service, if the first one failed
 *   5. `tone`     a synthesized bed, so the node is never speechless
 *
 * The two services share the settings that belong to the station — language,
 * pace — and keep their own for the rest (Flowery has voices to choose;
 * Google does not). See src/tts/providers.js.
 *
 * **Every phrase carries a language.** A node in Hanoi announcing in English
 * because that is what the default happened to be is a bad radio station, so
 * the language is a first-class argument: per call, per station, per plugin,
 * with the node default behind it. Text can also say it itself —
 * `tts:vi:xin chào` — and a listener's `Accept-Language` can pick one.
 *
 * Everything is rendered to MP3 once and cached on disk *per language*, so a
 * phrase costs nothing after the first use — important because idents are
 * played into live broadcasts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { buildSilence } from '../util/mp3.ts'
import { PROVIDERS, providerInfo, flowery } from './providers.ts'
import createLogger from '../util/logger.ts'

const log = createLogger('tts')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/**
 * Languages the node speaks out of the box: the tag it sends to the
 * provider, the English name, and the name in the language itself (which is
 * what a console should show a listener).
 *
 * The list is not a limit — any BCP-47 tag the provider accepts works — it
 * is what `/api/v1/tts/languages` advertises and what the owner console can
 * offer without guessing.
 */
export const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'en-GB', name: 'English (UK)', native: 'English (UK)' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'pt', name: 'Portuguese', native: 'Português' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)', native: 'Português (Brasil)' },
  { code: 'fr', name: 'French', native: 'Français' },
  { code: 'de', name: 'German', native: 'Deutsch' },
  { code: 'it', name: 'Italian', native: 'Italiano' },
  { code: 'nl', name: 'Dutch', native: 'Nederlands' },
  { code: 'pl', name: 'Polish', native: 'Polski' },
  { code: 'ru', name: 'Russian', native: 'Русский' },
  { code: 'tr', name: 'Turkish', native: 'Türkçe' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'th', name: 'Thai', native: 'ไทย' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'ar', name: 'Arabic', native: 'العربية' },
  { code: 'ja', name: 'Japanese', native: '日本語' },
  { code: 'ko', name: 'Korean', native: '한국어' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', native: '简体中文' },
  { code: 'zh-TW', name: 'Chinese (Traditional)', native: '繁體中文' }
]

const BY_CODE = new Map(LANGUAGES.map((entry) => [entry.code.toLowerCase(), entry]))

/**
 * Tidy a language tag into one the provider will accept.
 *
 * `VI` → `vi`, `pt_br` → `pt-BR`, `en-US,en;q=0.9` → `en`. An unknown but
 * well-formed tag is passed through: the provider knows more languages than
 * this file lists, and refusing them would be rude.
 */
export function normaliseLanguage(tag, fallback = 'en') {
  if (!tag) return fallback
  const first = String(tag).split(',')[0].trim().replace('_', '-')
  if (!first) return fallback
  const [base, region] = first.split('-')
  const lower = base.toLowerCase()
  const candidate = region ? `${lower}-${region.toUpperCase()}` : lower
  if (BY_CODE.has(candidate.toLowerCase())) return BY_CODE.get(candidate.toLowerCase()).code
  if (BY_CODE.has(lower)) return BY_CODE.get(lower).code
  return /^[a-z]{2,3}(-[A-Z]{2})?$/.test(candidate) ? candidate : fallback
}

/** Best match for an `Accept-Language` header, out of the ones on offer. */
export function pickLanguage(header, available: any = [], fallback = 'en') {
  const offered = available.map((code) => normaliseLanguage(code))
  const wanted = String(header ?? '')
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';')
      const q = Number(params.find((p) => p.trim().startsWith('q='))?.split('=')[1] ?? 1)
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 1 }
    })
    .filter((entry) => entry.tag && entry.tag !== '*')
    .sort((a, b) => b.q - a.q)

  for (const { tag } of wanted) {
    const exact = normaliseLanguage(tag)
    if (offered.includes(exact)) return exact
    // `pt-PT` should still find `pt`, and `en` should find `en-GB`.
    const base = exact.split('-')[0]
    const loose = offered.find((code) => code === base || code.split('-')[0] === base)
    if (loose) return loose
  }
  return fallback
}

/**
 * Pull a leading language tag off a phrase: `vi:xin chào` → `['vi', 'xin chào']`.
 * Only tags this node knows are honoured, so a sentence that happens to
 * start with "note:" is left alone.
 */
export function splitLanguage(text) {
  const match = /^([a-zA-Z]{2,3}(?:[-_][a-zA-Z]{2})?)\s*:\s*(.+)$/s.exec(String(text ?? '').trim())
  if (!match) return { language: null, text: String(text ?? '').trim() }
  const code = normaliseLanguage(match[1], '')
  if (!code || !BY_CODE.has(code.toLowerCase())) return { language: null, text: String(text).trim() }
  return { language: code, text: match[2].trim() }
}


export class TtsEngine {
  declare cacheDir: any
  declare fallback: any
  declare language: any
  declare provider: any
  declare providers: any
  declare speed: any
  declare voice: any

  /**
   * @param {object} opts
   * @param {string} opts.cacheDir  where rendered MP3s live (media/tts)
   * @param {string} [opts.provider] 'google' | 'off'
   * @param {string} [opts.language]
   */
  /**
   * @param {object} opts
   * @param {string} opts.cacheDir   where rendered MP3s live (media/tts)
   * @param {string} [opts.provider] 'google' | 'flowery' | 'off'
   * @param {string} [opts.language] shared: the language everything speaks
   * @param {number} [opts.speed]    shared: 1 is the service's normal pace
   * @param {boolean} [opts.fallback] shared: try the other service on failure
   * @param {object} [opts.providers] per-service settings, e.g.
   *                                  `{ flowery: { voice: '…' } }`
   */
  constructor({ cacheDir, provider = 'google', language = 'en', voice = null, speed = 1, fallback = true, providers = {} }: any = {}) {
    this.cacheDir = cacheDir
    this.provider = provider
    // ---- shared: these belong to the station, not to the service --------
    this.language = normaliseLanguage(language)
    this.speed = speed
    this.fallback = fallback !== false
    // ---- per service: only meaningful to the one that owns them ---------
    this.providers = { google: {}, flowery: {}, ...providers }
    // A voice id given at the top level belongs to whichever service is on.
    if (voice && PROVIDERS[provider]?.voices) this.providers[provider] = { voice, ...this.providers[provider] }
    this.voice = voice
    fs.mkdirSync(this.cacheDir, { recursive: true })
  }

  /** Both services, and what each of them can do. */
  get catalogue() {
    return providerInfo().map((entry) => ({ ...entry, active: entry.id === this.provider, settings: this.providers[entry.id] ?? {} }))
  }

  /** Settings shared by every service, as the owner API reports them. */
  get shared() {
    return { language: this.language, speed: this.speed, fallback: this.fallback, cacheDir: this.cacheDir }
  }

  /** Change the service. Shared settings deliberately do not move. */
  setProvider(id) {
    if (id !== 'off' && !PROVIDERS[id]) throw new Error(`unknown speech provider "${id}" (try: ${Object.keys(PROVIDERS).join(', ')}, off)`)
    this.provider = id
    return this.provider
  }

  /** Per-service settings, merged. */
  setProviderSettings(id, patch: any = {}) {
    if (!PROVIDERS[id]) throw new Error(`unknown speech provider "${id}"`)
    this.providers[id] = { ...this.providers[id], ...patch }
    return this.providers[id]
  }

  /** Voices this service offers for a language (Flowery has thousands). */
  async voicesFor(language = this.language, { provider = this.provider }: any = {}) {
    if (provider !== 'flowery') return []
    try {
      return await flowery.voicesFor(normaliseLanguage(language))
    } catch (error) {
      log.debug(`voice list unavailable: ${error.message}`)
      return []
    }
  }

  /** Every language this node advertises, with the default marked. */
  get languages() {
    return LANGUAGES.map((entry) => ({ ...entry, default: entry.code === this.language }))
  }

  /** Change the node's default language (owner setting). */
  setLanguage(language) {
    this.language = normaliseLanguage(language, this.language)
    return this.language
  }

  /** Pre-rendered clip shipped with the node (highest quality, no network). */
  bundledPath(id) {
    const file = path.join(this.cacheDir, `${id}.mp3`)
    return fs.existsSync(file) && fs.statSync(file).size > 1024 ? file : null
  }

  /**
   * Where a phrase *would* be cached.
   *
   * Public because the news plugin renders bulletins in a worker thread and
   * has to write the file this engine will later look for — the two must
   * agree on the name, so only one of them gets to decide it.
   */
  cachePathFor(text, { language = this.language, speed = this.speed, provider = this.provider }: any = {}) {
    const spoken = splitLanguage(text)
    return this.#cachePath(
      spoken.language ? spoken.text : String(text ?? '').trim(),
      normaliseLanguage(language ?? spoken.language ?? this.language, this.language),
      Number(speed) || 1,
      provider
    )
  }

  /** The voice id in use for a service, if it has one. */
  voiceFor(provider = this.provider) {
    return this.providers?.[provider]?.voice ?? null
  }

  #cachePath(text, language = this.language, speed = this.speed, provider = this.provider) {
    // Everything that changes how it *sounds* is part of a clip's identity:
    // the words, the language, the pace, the service and its voice. Two
    // recordings of the same sentence must never share a cache entry.
    const voice = PROVIDERS[provider]?.voices ? (this.providers[provider]?.voice ?? '') : ''
    const hash = createHash('sha1')
      .update(`${provider}|${language}|${voice}|${speed}|${text}`)
      .digest('hex')
      .slice(0, 20)
    return path.join(this.cacheDir, `say-${hash}.mp3`)
  }

  /**
   * Render a phrase to an MP3 file.
   * @returns {Promise<{file: string, provider: string, cached: boolean}>}
   */
  /**
   * Render a phrase to an MP3 file.
   *
   * @param {string} text        what to say — may start with `vi:` etc.
   * @param {object} [opts]
   * @param {string} [opts.language] BCP-47 tag; defaults to the node's
   * @param {string} [opts.bundled]  id of a pre-rendered clip to prefer
   * @param {string} [opts.file]     an owner-supplied file or URL
   * @returns {Promise<{file: string, provider: string, cached: boolean, language: string}>}
   */
  async speak(text, { bundled = null, file: ownerFile = null, language = null, speed = null, provider = null, voice = null }: any = {}) {
    // A phrase may name its own language: `tts:vi:xin chào`.
    const spoken = splitLanguage(text)
    const tag = normaliseLanguage(language ?? spoken.language ?? this.language, this.language)
    const pace = Number(speed ?? this.speed) || 1
    const service = provider ?? this.provider
    text = spoken.language ? spoken.text : String(text ?? '').trim()

    // 1. owner-supplied audio always wins
    if (ownerFile) {
      const resolved = await this.#ensureLocal(ownerFile)
      if (resolved) return { file: resolved, provider: 'file', cached: true, language: tag }
    }

    // 2. bundled pre-render — per language when one exists (`ident.vi.mp3`),
    //    otherwise the plain clip.
    if (bundled) {
      const hit = (tag !== 'en' && this.bundledPath(`${bundled}.${tag}`)) || this.bundledPath(bundled)
      if (hit) return { file: hit, provider: 'bundled', cached: true, language: tag }
    }

    // 3. disk cache
    const cache = this.#cachePath(text, tag, pace, service)
    if (fs.existsSync(cache) && fs.statSync(cache).size > 1024) {
      return { file: cache, provider: 'cache', cached: true, language: tag, voice: service }
    }

    // 4. synthesize — the chosen service, then the other one. A station
    //    should not go quiet because one free API is having an afternoon.
    const order = service === 'off' ? [] : [service, ...(this.fallback ? Object.keys(PROVIDERS).filter((id) => id !== service) : [])]

    for (const id of order) {
      const engine = PROVIDERS[id]
      if (!engine) continue
      const settings = { ...this.providers[id], ...(voice && engine.voices ? { voice } : {}) }
      const [slowest, fastest] = engine.speedRange ?? [0.25, 4]
      const paceFor = Math.max(slowest, Math.min(fastest, pace))

      try {
        const started = Date.now()
        // A neural voice needs roughly a second per fifty characters; a flat
        // deadline either kills long bulletins or waits forever on short
        // ones, so it scales with what was asked for.
        const deadline = Math.min(120_000, Math.max(12_000, 8000 + text.length * 30))
        const buffer = await engine.speak({ text, language: tag, speed: paceFor, settings, timeoutMs: deadline })
        if (!buffer || buffer.length < 512) throw new Error('empty response')

        // A clip rendered by the fallback is cached under *its* name, so the
        // next run does not keep retrying the service that was down.
        const file = id === service ? cache : this.#cachePath(text, tag, pace, id)
        fs.writeFileSync(file, buffer)
        log.info(
          `rendered [${id} · ${tag}${pace !== 1 ? ` ×${pace}` : ''}] "${text.slice(0, 36)}…" ` +
            `(${(buffer.length / 1024).toFixed(0)} KB, ${Date.now() - started}ms)`
        )
        return { file, provider: id, cached: false, language: tag, fellBack: id !== service }
      } catch (error) {
        log.warn(`${id} tts failed (${tag}): ${error.message}`)
      }
    }

    // 5. never be speechless: a short tone bed
    const fallback = path.join(this.cacheDir, 'fallback-tone.mp3')
    if (!fs.existsSync(fallback)) fs.writeFileSync(fallback, Buffer.concat(buildSilence(1500).frames))
    return { file: fallback, provider: 'tone', cached: true, language: tag }
  }

  async #ensureLocal(target) {
    if (/^https?:\/\//i.test(target)) {
      const cache = this.#cachePath(target)
      if (fs.existsSync(cache)) return cache
      const res = await fetch(target, { headers: { 'user-agent': UA } })
      if (!res.ok) return null
      fs.writeFileSync(cache, Buffer.from(await res.arrayBuffer()))
      return cache
    }
    return fs.existsSync(target) ? target : null
  }

  /** translate_tts accepts ~200 chars per call; long text is stitched together. */
  async #google(text, language = this.language, speed = this.speed) {
    const chunks = []
    // Languages without spaces between words (Japanese, Thai, Chinese) do not
    // split on sentence punctuation the same way; the length cap still holds.
    for (const sentence of String(text).match(/[^.!?。！？]+[.!?。！？]?/g) ?? [text]) {
      let current = sentence.trim()
      while (current.length > 0) {
        chunks.push(current.slice(0, 190))
        current = current.slice(190)
      }
    }

    // A news bulletin is thirty of these. Rendering them one after another
    // takes as long as reading them, so fetch a few at a time — in order,
    // because the order is the whole point — and stitch the MP3s together.
    const CONCURRENCY = 4
    const parts = new Array(chunks.length)
    let next = 0

    const worker = async () => {
      for (;;) {
        const index = next
        next += 1
        if (index >= chunks.length) return
        const url =
          'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob' +
          `&tl=${encodeURIComponent(language)}` +
          // translate_tts reads `ttsspeed` as a multiplier of its own pace.
          (speed && speed !== 1 ? `&ttsspeed=${Math.max(0.1, Math.min(1, speed)).toFixed(2)}` : '') +
          `&q=${encodeURIComponent(chunks[index])}`
        const res = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://translate.google.com/' } })
        if (!res.ok) throw new Error(`translate_tts ${res.status}`)
        parts[index] = Buffer.from(await res.arrayBuffer())
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker))
    return Buffer.concat(parts)
  }

}

export default TtsEngine
