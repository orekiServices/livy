/**
 * Livy configuration: defaults → config.json → environment.
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

/**
 * Are we running inside a Vercel Function?
 *
 * Vercel sets `VERCEL=1` for every deployment. The important consequence is
 * not the platform, it is the filesystem: the deployment bundle is read-only
 * and `/tmp` is the only writable directory, and even `/tmp` is not shared
 * between invocations. Anything that wants to survive a request has to be a
 * KV/blob/database, so everything that writes here is either redirected to
 * `/tmp` (and accepted as lost) or kept in the request itself.
 *
 * Exported because the serverless entry point, the store and the TTS cache
 * all need to make the same decision from the same answer.
 */
export function isServerless(env = process.env) {
  return Boolean(env.VERCEL) || env.LIVY_SERVERLESS === '1'
}

/**
 * The same answer, captured at load.
 *
 * Kept for the places that only need to name the platform in a log line. The
 * decisions that matter — where to write, whether to boot a socket — call
 * `isServerless()` when they make them, because under Bun a variable assigned
 * to `process.env` *after* start-up can be invisible to the whole process, and
 * a test (or a deployment wrapper) that sets `VERCEL` late must still be seen.
 */
export const serverless = isServerless()

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
    file: { enabled: false, path: path.join(root, 'data', 'livy.log'), maxMb: 8, keep: 3 }
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
    // How a source identifies itself upstream. Distinct nodes can be told
    // apart in provider dashboards instead of all claiming to be one app.
    audiusAppName: 'livy',
    // Optional: Odesli rate-limits anonymous callers rather than refusing
    // them, so a key is a convenience, not a requirement.
    songlinkKey: '',
    mediaDir: path.join(root, 'media'),
    // …plus the hi-res and fallback policy keys documented in
    // config.example.json (hiRes, hiResMinKbps, hiResMinScore,
    // fallbackOrder, liveFallback, noSearch, searchWeights).
  },
  relay: { metaint: 16_000 },
  // Owner role: one key unlocks everything (station CRUD, automix, bans…).
  // Left empty, Livy generates one on first boot and prints it once.
  owner: {
    key: '',
    name: 'owner',
    autoKey: true,
    // Hashed at boot; prefer OWNER_PASSWORD over putting a secret in config.
    password: '',
    // Set by ensureOwnerKey(): 'explicit', 'legacy', 'generated' or ''.
    keySource: ''
  },
  // SQLite: stations, requests, one-vote-per-listener, plays, bans, plugins.
  // Upgrades are migrations against this one file (see src/store/migrations.js).
  store: {
    enabled: true,
    file: path.join(root, 'data', 'livy.db'),
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
  // Two-tier cache: in-memory resolve/search/trackUrl LRU + atomic disk MP3 cache.
  cache: {
    enabled: true,
    memory: {
      resolveTtlMs: 10 * 60_000,
      resolveMaxEntries: 500,
      searchTtlMs: 3 * 60_000,
      searchMaxEntries: 300,
      trackUrlTtlMs: 4 * 60_000,
      trackUrlMaxEntries: 500
    },
    audio: {
      enabled: true,
      dir: '',
      maxBytes: 512 * 1024 * 1024,
      maxEntries: 250,
      maxEntryBytes: 32 * 1024 * 1024,
      ttlMs: 7 * 24 * 60 * 60_000
    }
  },
  // The learned automix policy. On by default, trained while stations play:
  // a fast small multi-train every `everySeams` new seams, best candidate
  // activated only if it beats the incumbent on a held-out split.
  // Model and training defaults live in `core/models/settings.js`: a Termux
  // node lowers them before a config file is applied. Keep `hf` here so the
  // environment overrides below have a container even when config.json is
  // silent.
  models: {
    hf: {}
  },
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
      // Joint tempo analysis, after automix-engine's select_tempo_pair: the
      // pair is scored, not each song separately, which is what stops the
      // half-time octave error that leaves two 128 BPM records unmixed.
      analysePair: true,
      // Release the matched tempo back to the incoming song's own tempo over
      // this window, instead of leaving it stretched for the rest of the track.
      tempoReleaseMs: 4000,
      // Do not fade a vocal line mid-phrase, and duck the bed when two voices
      // would overlap. Needs no stems: it uses a band-energy gate.
      vocalAware: true,
      // Snap blends to whole four-beat phrases rather than milliseconds.
      phraseBlend: true,
      trimSilence: true, // cue past silence at the head/tail of a file
      targetLufs: -16, // BS.1770 seam loudness match
      maxGainDb: 6,
      ceilingDb: -1, // peak ceiling for the rendered seam
      crossoverHz: 200, // bass-swap crossover
      dj: { enabled: true, name: 'Ava', every: 3, duckDb: -9, leadInMs: 700, tailMs: 900, bedHighpassHz: 180 }
    },
    // Station filters — the NodeLink-shaped chain (see core/filters.js).
    // Empty by default: an unfiltered station decodes and encodes nothing it
    // did not already, so this feature costs exactly zero until it is used.
    //
    //   "filters": { "equalizer": { "bands": [{ "band": 2, "gain": 1.4 }] },
    //                "reverb": { "mix": 0.18 } }
    filters: {}
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
  if (env.AUDIUS_APP_NAME) out.sources.audiusAppName = env.AUDIUS_APP_NAME
  if (env.SONGLINK_API_KEY) out.sources.songlinkKey = env.SONGLINK_API_KEY
  if (env.OWNER_KEY) out.owner.key = env.OWNER_KEY
  if (env.OWNER_PASSWORD) out.owner.password = env.OWNER_PASSWORD
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
  if (env.AUTOMIX_TEMPO_RELEASE_MS) out.stationDefaults.automix.tempoReleaseMs = Number(env.AUTOMIX_TEMPO_RELEASE_MS)
  if (env.AUTOMIX_PAIR === '0' || env.AUTOMIX_PAIR === 'off') out.stationDefaults.automix.analysePair = false
  if (env.AUTOMIX_VOCAL === '0' || env.AUTOMIX_VOCAL === 'off') out.stationDefaults.automix.vocalAware = false
  // A filter chain as JSON, so a container can ship a station's sound in its
  // environment without writing config.json.
  if (env.FILTERS) {
    try {
      out.stationDefaults.filters = JSON.parse(env.FILTERS)
    } catch {
      // A malformed FILTERS must not stop the node from booting.
    }
  }
  if (env.LIVY_DATA_DIR) out.store = { ...(out.store ?? {}), file: `${env.LIVY_DATA_DIR}/data/livy.db` }
  if (env.DJ === '0' || env.DJ === 'off') out.stationDefaults.automix.dj.enabled = false
  if (env.DJ_NAME) out.stationDefaults.automix.dj.name = env.DJ_NAME
  if (env.DJ_EVERY) out.stationDefaults.automix.dj.every = Number(env.DJ_EVERY)
  // Models: on unless switched off; HF storage when a repo is configured.
  if (env.LIVY_MODELS === '0' || env.LIVY_MODELS === 'off') out.models.enabled = false
  if (env.LIVY_AUTO_TRAIN === '0' || env.LIVY_AUTO_TRAIN === 'off') out.models.autoTrain = false
  if (env.LIVY_FAST_TRAIN === '0' || env.LIVY_FAST_TRAIN === 'off') out.models.fast = false
  if (env.LIVY_TRAIN_CANDIDATES) out.models.candidates = Math.max(1, Math.min(8, Number(env.LIVY_TRAIN_CANDIDATES) || 2))
  if (env.LIVY_AUTO_TRAIN_EVERY) out.models.everySeams = Math.max(10, Number(env.LIVY_AUTO_TRAIN_EVERY) || 60)
  if (env.LIVY_HF_MODELS === '1') out.models.hf.enabled = true
  if (env.LIVY_HF_REPO) {
    out.models.hf.repo = env.LIVY_HF_REPO
    out.models.hf.enabled = env.LIVY_HF_MODELS === '0' ? false : true
  }
  if (env.HF_TOKEN) out.models.hf.token = env.HF_TOKEN
  // Cache overrides: disable globally, disable disk audio cache, or set budgets.
  if (env.LIVY_CACHE === '0' || env.LIVY_CACHE === 'off') out.cache.enabled = false
  if (env.LIVY_AUDIO_CACHE === '0' || env.LIVY_AUDIO_CACHE === 'off') out.cache.audio.enabled = false
  if (env.LIVY_CACHE_DIR) out.cache.audio.dir = env.LIVY_CACHE_DIR
  if (env.LIVY_CACHE_MAX_MB) out.cache.audio.maxBytes = Math.max(1, Number(env.LIVY_CACHE_MAX_MB) || 512) * 1024 * 1024
  if (env.LIVY_CACHE_MAX_ENTRIES) out.cache.audio.maxEntries = Math.max(1, Number(env.LIVY_CACHE_MAX_ENTRIES) || 250)
  if (env.LIVY_CACHE_TTL_MS) out.cache.audio.ttlMs = Math.max(60_000, Number(env.LIVY_CACHE_TTL_MS) || 7 * 24 * 60 * 60_000)
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
 *
 * A password (from the environment or a previous first-run setup) is a
 * complete credential: in that case no key is minted, so the log cannot offer
 * a second way in. An explicit `owner.key`/`OWNER_KEY` still wins and remains
 * valid alongside a password.
 *
 * @returns {{key: string, created: boolean}}
 */
export function ensureOwnerKey(config) {
  config.owner ??= {}
  if (config.owner.key) {
    config.owner.keySource = 'explicit'
    return { key: config.owner.key, created: false }
  }
  if (config.server?.password) {
    config.owner.keySource = 'legacy'
    return { key: config.server.password, created: false }
  }
  // A password is a complete credential on its own. Do not mint a key beside
  // it: a generated key is ignored while a password exists, and printing one
  // would only invite someone to try a credential that no longer works.
  if (config.owner.passwordHash) {
    config.owner.keySource = ''
    return { key: '', created: false }
  }
  if (config.owner.autoKey === false) {
    config.owner.keySource = ''
    return { key: '', created: false }
  }

  const file = path.join(path.dirname(config.store?.file ?? path.join(root, 'data', 'radio.db')), 'owner.key')
  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, 'utf8').trim()
      if (existing) {
        config.owner.key = existing
        config.owner.keySource = 'generated'
        return { key: existing, created: false }
      }
    }
    const key = crypto.randomBytes(16).toString('base64url')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${key}\n`, { mode: 0o600 })
    config.owner.key = key
    config.owner.keySource = 'generated'
    return { key, created: true }
  } catch {
    // Read-only install: run open, the operator can set OWNER_KEY themselves.
    config.owner.keySource = ''
    return { key: '', created: false }
  }
}

/**
 * Where this process may write.
 *
 * On a normal node that is `server/`. In a Vercel Function `server/` is part of
 * a read-only bundle, so every writable path moves to `/tmp` — and the owner
 * has to know that `/tmp` does not outlive the instance, which is what
 * `writable: 'ephemeral'` says. `LIVY_DATA_DIR` overrides both, for a
 * container with a mounted volume.
 */
function writableRoot() {
  return process.env.LIVY_DATA_DIR || (isServerless() ? path.join('/tmp', 'livy') : root)
}

export const paths = {
  root,
  public: path.join(root, 'public'),
  plugins: path.join(root, 'plugins'),
  media: path.join(root, 'media'),
  get tts() {
    return path.join(writableRoot(), 'media', 'tts')
  },
  get data() {
    return path.join(writableRoot(), 'data')
  },
  get cache() {
    return path.join(writableRoot(), 'cache')
  },
  // 'disk' survives a restart, 'ephemeral' does not, 'memory' is not written.
  get writable() {
    return process.env.LIVY_DATA_DIR ? 'disk' : isServerless() ? 'ephemeral' : 'disk'
  }
}
export default loadConfig
