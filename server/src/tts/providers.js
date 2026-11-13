/**
 * Where the voices come from.
 *
 * Livy speaks through one of two services, and the interesting design
 * question is what they share. A station's *language* and *pace* are
 * properties of the station — they should not change because the owner
 * switched provider. A *voice id* is the opposite: it means nothing outside
 * the service that issued it.
 *
 * So settings are split in two:
 *
 *   shared     language · speed · cache · fallback     — one copy, both use it
 *   providers  google: {}                              — whatever only it needs
 *              flowery: { voice, format, quality }
 *
 * Switching provider therefore keeps the station sounding like itself, and
 * each service keeps its own knobs. Both implement the same tiny contract:
 * `speak({ text, language, speed, settings })` → an MP3 Buffer.
 */
const UA = 'Livy/3 (radio node; +https://github.com/livy)'
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** Split a phrase into pieces a provider will accept, on sentences first. */
export function chunkText(text, limit) {
  const chunks = []
  for (const sentence of String(text).match(/[^.!?。！？]+[.!?。！？]?/g) ?? [text]) {
    let current = sentence.trim()
    while (current.length > 0) {
      chunks.push(current.slice(0, limit))
      current = current.slice(limit)
    }
  }
  return chunks
}

/** Fetch with a deadline, because a hung voice is worse than a silent one. */
async function fetchWithTimeout(url, options = {}, timeoutMs = 12_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------- google ------------------------------- */

/**
 * Google translate's speech endpoint: no key, no account, a voice per
 * language and nothing else to choose. It is the default because it always
 * works and costs nothing to set up.
 */
export const google = {
  id: 'google',
  name: 'Google Translate',
  /** 190 characters per request, so long text is stitched from pieces. */
  chunkLimit: 190,
  concurrency: 4,
  /** It has one voice per language; there is nothing to pick. */
  voices: false,
  /** `ttsspeed` is a multiplier of its own pace, and only slower than 1. */
  speedRange: [0.1, 1],

  async speak({ text, language = 'en', speed = 1, settings = {}, timeoutMs = 8000 }) {
    // Tests point this at a local server; nothing else sets it.
    const base = settings.endpoint ?? 'https://translate.google.com/translate_tts'
    const pieces = chunkText(text, google.chunkLimit)
    const parts = new Array(pieces.length)
    let next = 0

    const worker = async () => {
      for (;;) {
        const index = next
        next += 1
        if (index >= pieces.length) return
        const url =
          `${base}?ie=UTF-8&client=tw-ob` +
          `&tl=${encodeURIComponent(language)}` +
          (speed && speed !== 1 ? `&ttsspeed=${Math.max(0.1, Math.min(1, speed)).toFixed(2)}` : '') +
          `&q=${encodeURIComponent(pieces[index])}`

        const res = await fetchWithTimeout(
          url,
          { headers: { 'user-agent': BROWSER_UA, referer: 'https://translate.google.com/' } },
          timeoutMs
        )
        if (!res.ok) throw new Error(`translate_tts ${res.status}`)
        parts[index] = Buffer.from(await res.arrayBuffer())
      }
    }

    await Promise.all(Array.from({ length: Math.min(google.concurrency, pieces.length) }, worker))
    return Buffer.concat(parts)
  }
}

/* ------------------------------- flowery ------------------------------ */

const FLOWERY = 'https://api.flowery.pw'

/**
 * [Flowery](https://flowery.pw/docs) — one API in front of fourteen speech
 * engines: Azure, Polly, Speechify, Cartesia, eSpeak and friends. Two
 * thousand voices, 254 languages, no key.
 *
 * Livy talks to its OpenAI-compatible endpoint, which takes plain text,
 * a voice id and a speed, and answers with an MP3 — no SSML to build and
 * nothing to escape.
 *
 * Two things the service asks of us, which this honours:
 *   • a real User-Agent (it rejects requests without one);
 *   • its rate limits — 3/s, 50/min, 500/h — so requests are serialised with
 *     a small gap rather than fired four at a time like Google's.
 *
 * It is free and **non-commercial**: a station that sells advertising should
 * use a different voice.
 */
export const flowery = {
  id: 'flowery',
  name: 'Flowery',
  /**
   * The endpoint accepts 4096 characters, but these are real neural voices:
   * a 600-character request takes about eight seconds, and one 4,000
   * character request would take a minute with nothing to show until the
   * end. Shorter pieces, a few in flight, finish sooner and fail smaller.
   */
  chunkLimit: 600,
  concurrency: 2,
  voices: true,
  speedRange: [0.25, 4],
  /** 3 requests/second; leave room for everything else on the node. */
  minGapMs: 400,
  nonCommercial: true,

  async speak({ text, language = 'en', speed = 1, settings = {}, timeoutMs = 20_000 }) {
    const voice = settings.voice || (await flowery.defaultVoice(language))
    if (!voice) throw new Error(`flowery has no voice for ${language}`)

    const pieces = chunkText(text, flowery.chunkLimit)
    const parts = new Array(pieces.length)
    let next = 0

    const worker = async () => {
      for (;;) {
        const index = next
        next += 1
        if (index >= pieces.length) return

        // The service publishes its limits (3/s) and being a good guest is
        // cheaper than being rate-limited mid-bulletin, so every request —
        // whichever worker makes it — waits its turn.
        const wait = flowery.minGapMs - (Date.now() - flowery.lastCallAt)
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
        flowery.lastCallAt = Date.now()

        const res = await fetchWithTimeout(
          `${FLOWERY}/openai/v1/audio/speech`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'user-agent': UA, accept: 'audio/mpeg' },
            body: JSON.stringify({
              input: pieces[index],
              voice,
              response_format: 'mp3',
              speed: Math.max(0.25, Math.min(4, Number(speed) || 1))
            })
          },
          timeoutMs
        )

        if (res.status === 429) throw new Error('flowery rate limit reached')
        if (!res.ok) throw new Error(`flowery ${res.status}`)
        parts[index] = Buffer.from(await res.arrayBuffer())
      }
    }

    await Promise.all(Array.from({ length: Math.min(flowery.concurrency, pieces.length) }, worker))
    return Buffer.concat(parts)
  },

  /** Last request, for the rate-limit gap (a field, so it is shared). */
  lastCallAt: 0,

  /** The whole catalogue, fetched once an hour. */
  async catalogue({ force = false } = {}) {
    const fresh = Date.now() - (flowery.cache?.at ?? 0) < 3600_000
    if (!force && fresh && flowery.cache?.voices?.length) return flowery.cache

    const res = await fetchWithTimeout(`${FLOWERY}/v2/voices`, { headers: { 'user-agent': UA, accept: 'application/json' } }, 12_000)
    if (!res.ok) throw new Error(`flowery voices ${res.status}`)
    const payload = await res.json()

    flowery.cache = {
      at: Date.now(),
      default: payload.default ?? null,
      voices: (payload.voices ?? []).map((voice) => ({
        id: voice.id,
        name: voice.name,
        gender: voice.gender ?? null,
        engine: voice.source ?? null,
        language: voice.language?.code ?? null,
        languageName: voice.language?.name ?? null
      }))
    }
    return flowery.cache
  },

  /** Voices for one language, best engines first. */
  async voicesFor(language, { limit = 50 } = {}) {
    const { voices } = await flowery.catalogue()
    const tag = String(language ?? '').toLowerCase()
    const base = tag.split('-')[0]

    // Prefer the neural engines: eSpeak is a robot, Azure is a person.
    const rank = { 'Microsoft Azure': 0, 'Amazon Polly': 1, Speechify: 2, Cartesia: 3, Naver: 4, 'Google Translate': 5 }
    return voices
      .filter((voice) => {
        const code = String(voice.language ?? '').toLowerCase()
        return code === tag || code.split('-')[0] === base
      })
      .sort((a, b) => (rank[a.engine] ?? 9) - (rank[b.engine] ?? 9) || a.name.localeCompare(b.name))
      .slice(0, limit)
  },

  /** A sensible voice when the owner has not chosen one. */
  async defaultVoice(language) {
    const matches = await flowery.voicesFor(language, { limit: 1 })
    if (matches.length) return matches[0].id
    const { default: fallback } = await flowery.catalogue()
    return fallback?.id ?? null
  },

  cache: null
}

export const PROVIDERS = { google, flowery }

/** What a console needs to draw the provider picker. */
export function providerInfo() {
  return Object.values(PROVIDERS).map((provider) => ({
    id: provider.id,
    name: provider.name,
    voices: Boolean(provider.voices),
    speedRange: provider.speedRange,
    nonCommercial: Boolean(provider.nonCommercial)
  }))
}

export default PROVIDERS
