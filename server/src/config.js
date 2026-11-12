/**
 * Nodecast configuration: defaults → config.json → environment.
 *
 * A fresh install ships with **no stations**. The node comes up empty, prints
 * a one-time owner key, and the web console walks you through creating the
 * first station.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const DEFAULT_CONFIG = {
  server: {
    host: '0.0.0.0',
    port: 2333,
    password: '', // empty = open API (put it behind the Next.js proxy instead)
    cors: '*'
  },
  // Logging: one level for everything, plus per-category debug switches you
  // can flip without restarting into a wall of noise.
  logging: {
    level: 'info', // trace | debug | info | warn | error | fatal | silent
    color: true,
    timestamps: true,
    buffer: 400, // lines kept in memory for the owner console
    debug: {
      // http: true, sources: true, automix: true, station: true,
      // store: true, plugins: true, gateway: true, tts: true
    },
    file: { enabled: false, path: path.join(root, 'data', 'nodecast.log'), maxMb: 8, keep: 3 }
  },
  // Anything in plugins/ extends the node: sources, transitions, endpoints.
  plugins: {
    enabled: true,
    dir: path.join(root, 'plugins')
  },
  // The web console is built to web/out and served from this same port, so
  // there is only ever one origin, one port and no cross-origin configuration.
  web: {
    enabled: true,
    dir: path.resolve(root, '..', 'web', 'out')
  },
  sources: {
    defaultSearch: 'soundcloud',
    soundcloudClientId: '', // auto-scraped when empty
    mediaDir: path.join(root, 'media')
  },
  relay: { metaint: 16_000 },
  // Owner role: one key unlocks everything (station CRUD, automix, bans…).
  // Left empty, Nodecast generates one on first boot and prints it once.
  owner: {
    key: '',
    name: 'owner',
    autoKey: true
  },
  // SQLite: stations, requests, one-vote-per-listener, plays, bans, plugins.
  // Upgrades are migrations against this one file (see src/store/migrations.js).
  store: {
    enabled: true,
    file: path.join(root, 'data', 'nodecast.db'),
    migrate: true
  },
  tts: {
    enabled: true,
    // 'google' (no key, one voice per language) or 'flowery' (2,000 voices,
    // also no key, non-commercial). See src/tts/providers.js.
    provider: 'google',
    // Shared by both services: a station should sound like itself whichever
    // one is answering.
    language: 'en',
    speed: 1,
    fallback: true,
    // Per service, for the settings only it understands.
    providers: { google: {}, flowery: { voice: null } },
    cacheDir: path.join(root, 'media', 'tts')
  },
  // What a station remembers across a restart (core/memory.js).
  memory: { enabled: true, saveEveryMs: 5000 },
  // What plays when the rotation runs dry (core/smartQueue.js).
  smartQueue: { enabled: true, minQueue: 3, batch: 5, lookback: 60, perArtist: 1 },
  stationDefaults: {
    bufferAheadMs: 15_000,
    burstMs: 4000,
    shuffle: true,
    loop: true,
    maxListeners: 500,
    trackLimit: 40,
    // Automix: crossfades, transition effects and the voice-tracking DJ.
    automix: {
      enabled: true,
      crossfadeMs: 6000,
      // 'auto' lets the measured correlation of the two songs pick the fade
      // law (equal-gain … equal-power); pin it if you disagree.
      curve: 'auto', // 'auto' | 'equal-power' | 'equal-gain'
      // 'crossfade' | 'bass-swap' | 'filter' | 'echo' | 'sweep' | 'spindown' | 'slam'
      effect: 'crossfade',
      minTrackMs: 20_000,
      beatAlign: true, // land the incoming song on a beat of the outgoing one
      beatmatch: true, // time-stretch the seam so the two tempos actually match
      maxStretchPercent: 12, // refuse to beatmatch further apart than this
      trimSilence: true, // cue past silence at the head/tail of a file
      targetLufs: -16, // BS.1770 seam loudness match
      maxGainDb: 6,
      ceilingDb: -1, // peak ceiling for the rendered seam
      crossoverHz: 200, // bass-swap crossover
      dj: { enabled: true, name: 'Ava', every: 3, duckDb: -9, leadInMs: 700, tailMs: 900, bedHighpassHz: 180 }
    }
  },
  stations: []
}

export function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch
  if (patch === null || typeof patch !== 'object') return patch ?? base
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in base && typeof base[key] === 'object' && base[key] !== null && !Array.isArray(base[key]) ? deepMerge(base[key], value) : value
  }
  return out
}

function fromEnv(config) {
  const env = process.env
  const out = structuredClone(config)
  if (env.PORT) out.server.port = Number(env.PORT)
  if (env.HOST) out.server.host = env.HOST
  if (env.SERVER_PASSWORD) out.server.password = env.SERVER_PASSWORD
  if (env.LOG_LEVEL) out.logging.level = env.LOG_LEVEL
  if (env.SOUNDCLOUD_CLIENT_ID) out.sources.soundcloudClientId = env.SOUNDCLOUD_CLIENT_ID
  if (env.OWNER_KEY) out.owner.key = env.OWNER_KEY
  if (env.STORE_FILE) out.store.file = env.STORE_FILE
  if (env.LOG_FILE) out.logging.file = { ...out.logging.file, enabled: true, path: env.LOG_FILE }
  // DEBUG=sources,automix — turn on just those categories
  if (env.DEBUG) {
    for (const name of env.DEBUG.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (name === '*' || name === 'all') out.logging.level = 'debug'
      else out.logging.debug[name] = true
    }
  }
  if (env.PLUGINS === '0' || env.PLUGINS === 'off') out.plugins.enabled = false
  if (env.PLUGINS_DIR) out.plugins.dir = env.PLUGINS_DIR
  if (env.TTS_PROVIDER) out.tts.provider = env.TTS_PROVIDER
  if (env.WEB === '0' || env.WEB === 'off') out.web.enabled = false
  if (env.WEB_DIR) out.web.dir = env.WEB_DIR
  if (env.BEATMATCH === '0' || env.BEATMATCH === 'off') out.stationDefaults.automix.beatmatch = false
  if (env.AUTOMIX === '0' || env.AUTOMIX === 'off') out.stationDefaults.automix.enabled = false
  if (env.AUTOMIX_CROSSFADE_MS) out.stationDefaults.automix.crossfadeMs = Number(env.AUTOMIX_CROSSFADE_MS)
  if (env.AUTOMIX_EFFECT) out.stationDefaults.automix.effect = env.AUTOMIX_EFFECT
  if (env.DJ === '0' || env.DJ === 'off') out.stationDefaults.automix.dj.enabled = false
  if (env.DJ_NAME) out.stationDefaults.automix.dj.name = env.DJ_NAME
  if (env.DJ_EVERY) out.stationDefaults.automix.dj.every = Number(env.DJ_EVERY)
  return out
}

export function loadConfig(file = process.env.RADIO_CONFIG ?? path.join(root, 'config.json')) {
  let userConfig = {}
  if (fs.existsSync(file)) {
    try {
      userConfig = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      throw new Error(`Failed to parse ${file}: ${error.message}`)
    }
  }
  return fromEnv(deepMerge(DEFAULT_CONFIG, userConfig))
}

/**
 * First run: mint an owner key, save it next to the database and hand it back
 * so it can be printed once. Never logged again afterwards.
 * @returns {{key: string, created: boolean}}
 */
export function ensureOwnerKey(config) {
  if (config.owner?.key) return { key: config.owner.key, created: false }
  if (config.server?.password) return { key: config.server.password, created: false }
  if (config.owner?.autoKey === false) return { key: '', created: false }

  const file = path.join(path.dirname(config.store?.file ?? path.join(root, 'data', 'radio.db')), 'owner.key')
  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, 'utf8').trim()
      if (existing) {
        config.owner.key = existing
        return { key: existing, created: false }
      }
    }
    const key = crypto.randomBytes(16).toString('base64url')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${key}\n`, { mode: 0o600 })
    config.owner.key = key
    return { key, created: true }
  } catch {
    // Read-only install: run open, the operator can set OWNER_KEY themselves.
    return { key: '', created: false }
  }
}

export const paths = {
  root,
  public: path.join(root, 'public'),
  plugins: path.join(root, 'plugins'),
  media: path.join(root, 'media'),
  tts: path.join(root, 'media', 'tts'),
  data: path.join(root, 'data')
}
export default loadConfig
