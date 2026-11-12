/**
 * Spoken errors — what a listener hears when a stream cannot be served.
 *
 * A media player is not a browser. Point VLC at a station that does not
 * exist and it shows nothing useful; the listener just hears silence and
 * assumes the node is broken. Radio has always solved this the same way — an
 * intercept recording that *tells you* what went wrong — so Nodecast does
 * too: `/stream/<id>.mp3` answers with a short spoken MP3 explaining itself.
 *
 * The status code stays honest (404, 403, 503). The body is audio, the
 * headers say what happened (`x-nodecast-error`), and a caller that asks for
 * JSON still gets JSON.
 *
 * **It answers in the listener's language.** Every line ships translated,
 * the player's `Accept-Language` picks one, and the owner can rewrite any
 * line in any language, add a language the node does not ship, switch the
 * voice, or turn the whole thing off:
 *
 *     GET   /api/v1/owner/stream-errors
 *     PATCH /api/v1/owner/stream-errors  { enabled, messages: { … } }
 *     GET   /api/v1/owner/stream-errors/preview?reason=unknown-station
 *
 * Rendered clips are cached on disk by the TTS engine and in memory here, so
 * a scanner hammering /stream/nope.mp3 costs one render, ever.
 */
import { buildSilence } from '../util/mp3.js'
import { normaliseLanguage, pickLanguage } from '../tts/index.js'
import createLogger from '../util/logger.js'

const log = createLogger('stream')

/**
 * Every way a stream request can fail, with what to say and what to answer.
 *
 * `{station}` and `{node}` are substituted at speaking time. Keep the lines
 * short: a listener who has just been told the station is missing will not
 * wait through a paragraph.
 */
export const REASONS = {
  'unknown-station': { status: 404, code: 'unknown_station', http: 'Unknown station' },
  'not-a-stream': { status: 404, code: 'not_a_stream', http: 'Streams are served as .mp3 only' },
  'off-air': { status: 503, code: 'off_air', http: 'Station is off the air' },
  banned: { status: 403, code: 'banned', http: 'You are banned from this node' },
  full: { status: 503, code: 'at_capacity', http: 'The node is at capacity' },
  unavailable: { status: 503, code: 'unavailable', http: 'The stream could not be started' }
}

/**
 * The lines themselves, per language.
 *
 * Short on purpose: a listener who has just been told the station is missing
 * will not wait through a paragraph. `{station}` and `{node}` are filled in
 * when the line is spoken.
 *
 * English is the fallback for any language that is not here; the owner can
 * add more through the API without touching this file.
 */
export const LINES = {
  en: {
    'unknown-station': 'Sorry, there is no station called {station} on this node. Check the station list and try again.',
    'not-a-stream': 'This is not a stream address. Stations are served as slash stream, station name, dot M P 3.',
    'off-air': '{station} is off the air right now. Please try again in a few minutes.',
    banned: 'This station is not available to you. If you think that is a mistake, contact the station owner.',
    full: '{station} has as many listeners as it can carry. Please try again shortly.',
    unavailable: 'Something went wrong starting that stream. The station operator has been told.'
  },
  vi: {
    'unknown-station': 'Xin lỗi, không có kênh nào tên {station} trên máy chủ này. Vui lòng kiểm tra lại danh sách kênh.',
    'not-a-stream': 'Đây không phải địa chỉ phát sóng. Các kênh được phát tại gạch chéo stream, tên kênh, chấm M P 3.',
    'off-air': 'Kênh {station} hiện không phát sóng. Vui lòng thử lại sau vài phút.',
    banned: 'Bạn không thể nghe kênh này. Nếu bạn cho rằng đây là nhầm lẫn, hãy liên hệ chủ kênh.',
    full: 'Kênh {station} đã đủ số người nghe tối đa. Vui lòng thử lại sau ít phút.',
    unavailable: 'Đã xảy ra lỗi khi bắt đầu phát sóng. Quản trị viên đã được thông báo.'
  },
  es: {
    'unknown-station': 'Lo sentimos, no existe ninguna emisora llamada {station} en este servidor. Consulta la lista de emisoras.',
    'not-a-stream': 'Esta no es una dirección de emisión. Las emisoras se sirven en barra stream, nombre, punto M P 3.',
    'off-air': '{station} no está emitiendo en este momento. Vuelve a intentarlo en unos minutos.',
    banned: 'Esta emisora no está disponible para ti. Si crees que es un error, contacta con el propietario.',
    full: '{station} ya tiene todos los oyentes que puede atender. Inténtalo de nuevo en breve.',
    unavailable: 'Algo salió mal al iniciar la emisión. El operador ya ha sido avisado.'
  },
  pt: {
    'unknown-station': 'Desculpe, não existe nenhuma estação chamada {station} neste servidor. Veja a lista de estações.',
    'not-a-stream': 'Este não é um endereço de transmissão. As estações são servidas em barra stream, nome, ponto M P 3.',
    'off-air': '{station} está fora do ar neste momento. Tente novamente daqui a alguns minutos.',
    banned: 'Esta estação não está disponível para você. Se acha que é um engano, fale com o responsável.',
    full: '{station} já tem todos os ouvintes que consegue atender. Tente novamente em breve.',
    unavailable: 'Algo deu errado ao iniciar a transmissão. O operador já foi avisado.'
  },
  fr: {
    'unknown-station': "Désolé, il n'y a pas de station nommée {station} sur ce serveur. Consultez la liste des stations.",
    'not-a-stream': "Ceci n'est pas une adresse de flux. Les stations sont diffusées sur slash stream, nom, point M P 3.",
    'off-air': "{station} n'émet pas pour le moment. Réessayez dans quelques minutes.",
    banned: "Cette station ne vous est pas accessible. Si c'est une erreur, contactez le responsable.",
    full: '{station} a déjà autant d’auditeurs qu’elle peut en porter. Réessayez bientôt.',
    unavailable: "Le démarrage du flux a échoué. L'exploitant de la station a été prévenu."
  },
  de: {
    'unknown-station': 'Es gibt auf diesem Server keinen Sender namens {station}. Bitte prüfen Sie die Senderliste.',
    'not-a-stream': 'Das ist keine Stream-Adresse. Sender laufen unter Schrägstrich stream, Name, Punkt M P 3.',
    'off-air': '{station} sendet gerade nicht. Bitte versuchen Sie es in ein paar Minuten noch einmal.',
    banned: 'Dieser Sender steht Ihnen nicht zur Verfügung. Bei Fragen wenden Sie sich an den Betreiber.',
    full: '{station} hat bereits so viele Hörer, wie sie tragen kann. Bitte versuchen Sie es gleich noch einmal.',
    unavailable: 'Beim Starten des Streams ist etwas schiefgegangen. Der Betreiber wurde informiert.'
  },
  id: {
    'unknown-station': 'Maaf, tidak ada stasiun bernama {station} di server ini. Silakan periksa daftar stasiun.',
    'not-a-stream': 'Ini bukan alamat siaran. Stasiun disiarkan di garis miring stream, nama, titik M P 3.',
    'off-air': '{station} sedang tidak mengudara. Silakan coba lagi beberapa menit lagi.',
    banned: 'Stasiun ini tidak tersedia untuk Anda. Jika ini keliru, hubungi pemilik stasiun.',
    full: '{station} sudah menampung pendengar sebanyak mungkin. Silakan coba lagi sebentar lagi.',
    unavailable: 'Terjadi kesalahan saat memulai siaran. Operator sudah diberi tahu.'
  },
  ja: {
    'unknown-station': 'このサーバーに {station} という放送局はありません。放送局の一覧をご確認ください。',
    'not-a-stream': 'これは配信アドレスではありません。放送は、スラッシュ ストリーム、局名、ドット エムピースリー で配信しています。',
    'off-air': '{station} は現在放送していません。数分後にもう一度お試しください。',
    banned: 'この放送局はご利用いただけません。お心当たりがない場合は運営者にご連絡ください。',
    full: '{station} は現在、受け入れられる最大の人数に達しています。しばらくしてからお試しください。',
    unavailable: '配信の開始に失敗しました。運営者に通知済みです。'
  },
  'zh-CN': {
    'unknown-station': '抱歉，本服务器上没有名为 {station} 的电台。请查看电台列表后重试。',
    'not-a-stream': '这不是收听地址。电台的地址是斜杠 stream，电台名称，点 M P 3。',
    'off-air': '{station} 当前未在播出，请过几分钟再试。',
    banned: '您无法收听该电台。如有疑问，请联系电台管理员。',
    full: '{station} 的在线人数已满，请稍后再试。',
    unavailable: '启动播放时出错，管理员已收到通知。'
  }
}

export const SHIPPED_LANGUAGES = Object.keys(LINES)

export const REASON_IDS = Object.keys(REASONS)


/** Owner-facing defaults. */
export function defaultSettings() {
  return {
    // Speak errors at all? Off → plain JSON, as any other API error.
    enabled: true,
    // Keep the honest status code (404/403/503). Some players refuse to play
    // the body of an error response; set this false and they hear it as 200.
    strictStatus: true,
    // Repeat the line, radio-style, so a listener who tuned in late catches it.
    repeat: 1,
    // Answer in the language the player asked for, when we have it.
    followListener: true,
    // Used when the listener asks for nothing, or for a language we do not
    // have. `null` means "the node's TTS language".
    language: null,
    // { en: { 'off-air': '…' }, vi: { … } } — merged over the shipped lines.
    messages: {}
  }
}

const MAX_LINE = 400

/** Merge owner settings over the defaults, dropping anything unknown. */
export function normalise(settings = {}) {
  const base = defaultSettings()
  const messages = {}

  for (const [tag, lines] of Object.entries(settings.messages ?? {})) {
    const language = normaliseLanguage(tag, '')
    if (!language || typeof lines !== 'object' || !lines) continue
    for (const [reason, text] of Object.entries(lines)) {
      if (!REASON_IDS.includes(reason) || typeof text !== 'string' || !text.trim()) continue
      messages[language] ??= {}
      messages[language][reason] = text.trim().slice(0, MAX_LINE)
    }
  }

  return {
    enabled: settings.enabled !== false,
    strictStatus: settings.strictStatus !== false,
    followListener: settings.followListener !== false,
    repeat: Math.min(3, Math.max(1, Number(settings.repeat) || base.repeat)),
    language: settings.language ? normaliseLanguage(settings.language) : null,
    messages
  }
}

/**
 * Renders and caches the spoken lines, in whatever language was asked for.
 *
 * Deliberately tolerant: no TTS engine, no network, a provider that is down —
 * the listener still gets a valid MP3 (a short silence) and the headers
 * still say what happened. An error path that can itself fail loudly is not
 * much of an error path.
 */
export class StreamErrorVoice {
  #cache = new Map() // `${language}|${text}` → Buffer
  #inflight = new Map()

  constructor({ tts = null, store = null, settings = {} } = {}) {
    this.tts = tts
    this.store = store
    this.settings = normalise({ ...(store?.get?.('streamErrors') ?? {}), ...settings })
  }

  /** The language used when the listener does not ask for one. */
  get defaultLanguage() {
    return this.settings.language ?? normaliseLanguage(this.tts?.language ?? 'en')
  }

  /** Every language this node can answer in: shipped, plus the owner's own. */
  get languages() {
    return [...new Set([...SHIPPED_LANGUAGES, ...Object.keys(this.settings.messages), this.defaultLanguage])].sort()
  }

  /** Current settings, as the owner API reports them. */
  get current() {
    return {
      ...this.settings,
      language: this.defaultLanguage,
      languages: this.languages,
      voice: this.tts ? this.tts.provider : 'off',
      reasons: REASON_IDS
    }
  }

  /** Owner edit: merge (per language), persist, and drop what changed. */
  update(patch = {}) {
    const merged = { ...this.settings, ...patch, messages: { ...this.settings.messages } }
    for (const [tag, lines] of Object.entries(patch.messages ?? {})) {
      const language = normaliseLanguage(tag, '')
      if (!language) continue
      merged.messages[language] = { ...(merged.messages[language] ?? {}), ...lines }
    }

    const next = normalise(merged)
    this.#cache.clear() // cheaper than working out which clips moved
    this.settings = next
    try {
      this.store?.set?.('streamErrors', next)
    } catch (error) {
      log.debug(`could not persist stream errors: ${error.message}`)
    }
    return this.current
  }

  /**
   * Which language to answer a given request in.
   *
   * The listener's `Accept-Language` wins when the node has something close
   * to it; otherwise the owner's default. A player that sends nothing (many
   * do) gets the default, which is the point of having one.
   */
  languageFor(acceptLanguage) {
    if (!this.settings.followListener || !acceptLanguage) return this.defaultLanguage
    return pickLanguage(acceptLanguage, this.languages, this.defaultLanguage)
  }

  /**
   * The line for a reason, in a language, with `{station}` and `{node}`
   * filled in. Falls back: owner's line → shipped line → English.
   */
  line(reason, { station = 'that station', node = 'this node', language = null } = {}) {
    const tag = normaliseLanguage(language ?? this.defaultLanguage)
    const base = tag.split('-')[0]
    const template =
      this.settings.messages[tag]?.[reason] ??
      this.settings.messages[base]?.[reason] ??
      LINES[tag]?.[reason] ??
      LINES[base]?.[reason] ??
      LINES.en[reason] ??
      LINES.en.unavailable
    return template.replaceAll('{station}', station).replaceAll('{node}', node)
  }

  /**
   * MP3 for a reason. Never rejects: on any failure it answers with a short
   * silence so the player gets well-formed audio either way.
   */
  async speak(reason, context = {}) {
    const language = normaliseLanguage(context.language ?? this.defaultLanguage)
    const text = this.line(reason, { ...context, language })
    const key = `${language}|${text}`
    if (this.#cache.has(key)) return this.#cache.get(key)
    if (this.#inflight.has(key)) return this.#inflight.get(key)

    const work = (async () => {
      let audio = null
      try {
        if (this.tts) {
          const { file } = await this.tts.speak(text, { language })
          const { readFile } = await import('node:fs/promises')
          const spoken = await readFile(file)
          const gap = Buffer.concat(buildSilence(400).frames)
          const parts = []
          for (let i = 0; i < this.settings.repeat; i += 1) parts.push(spoken, gap)
          audio = Buffer.concat([gap, ...parts])
        }
      } catch (error) {
        log.debug(`could not speak "${reason}" in ${language}: ${error.message}`)
      }
      // Half a second of valid MP3 beats a truncated response.
      if (!audio || audio.length === 0) audio = Buffer.concat(buildSilence(500).frames)
      this.#cache.set(key, audio)
      this.#inflight.delete(key)
      return audio
    })()

    this.#inflight.set(key, work)
    return work
  }

  /** Forget every rendered clip (owner "re-record" button). */
  clear() {
    this.#cache.clear()
  }
}

/**
 * Answer a failed stream request.
 *
 * JSON for anything that asked for JSON (the console, a script, `?format=json`),
 * spoken MP3 for everything else — which in practice means media players —
 * in the language the player asked for.
 */
export async function failStream(req, res, { voice, reason, station = null, stationId = null, node = 'this node', cors = '*' }) {
  const spec = REASONS[reason] ?? REASONS.unavailable
  const wantsJson =
    /application\/json/i.test(req.headers.accept ?? '') ||
    /[?&]format=json/i.test(req.url ?? '') ||
    !voice?.settings.enabled

  const headers = {
    'access-control-allow-origin': cors,
    'cache-control': 'no-store',
    // Machine-readable, whatever the body turns out to be.
    'x-nodecast-error': spec.code,
    'x-nodecast-reason': reason
  }

  if (wantsJson) {
    res.writeHead(spec.status, { ...headers, 'content-type': 'application/json; charset=utf-8' })
    return res.end(
      JSON.stringify({ error: true, status: spec.status, code: spec.code, message: spec.http, station: stationId ?? undefined })
    )
  }

  const language = voice.languageFor(req.headers['accept-language'])
  const audio = await voice.speak(reason, { station: station ?? stationId ?? 'that station', node, language })
  const status = voice.settings.strictStatus ? spec.status : 200

  res.writeHead(status, {
    ...headers,
    'content-type': 'audio/mpeg',
    'content-length': String(audio.length),
    'content-language': language,
    'icy-name': 'Nodecast',
    'icy-description': spec.http,
    'accept-ranges': 'none'
  })
  if (req.method === 'HEAD') return res.end()
  return res.end(audio)
}

export default StreamErrorVoice
