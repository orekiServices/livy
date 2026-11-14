/**
 * Runtime settings for the model subsystem.
 *
 * The server calls `configureModels({ config, store })` once at boot, after
 * which every part of training and storage reads the same object. The store is
 * optional so the trainer still works in a test or a one-off script.
 */
import { paths } from '../../config.ts'
import { hostInfo } from '../../util/platform.ts'
import { isModelPreset } from './presets.ts'

export const DEFAULT_MODEL_SETTINGS = {
  enabled: true,
  // The learned policy is on by default; so is learning it.
  autoTrain: true,
  // Training while a station is on air is the point, so check often but
  // cheaply: one COUNT against the seam table.
  pollMs: 60_000,
  intervalMs: 30 * 60_000,
  minSeams: 40,
  everySeams: 60,
  // Fast is the default: a few candidates, a small net, a short run, warm
  // start from the incumbent. A "big" run is still available per request.
  fast: true,
  // Which architecture to train. `auto` follows the host: phone-sized on
  // Termux, two-layer server nets elsewhere. See models/presets.js.
  preset: 'auto',
  candidates: 2,
  epochs: 0, // 0 = let the trainer pick per mode
  activate: true,
  // Storage. HF is opt-in because it needs a token; when it is on, the repo
  // is created private and is never allowed to become public by accident.
  storage: 'local',
  // Where trained candidates land. Empty = the writable data directory.
  saveDir: '',
  hf: {
    enabled: false,
    repo: '',
    revision: 'main',
    private: true,
    token: ''
  }
}

let state: Record<string, any> = structuredClone(DEFAULT_MODEL_SETTINGS)
let storeRef = null

const merge = (base, patch) => {
  if (!patch || typeof patch !== 'object') return base
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(base?.[key] ?? {}, value) : value
  }
  return out
}

/** A phone trains less often and with one candidate (see models/device.js). */
export const MOBILE_MODEL_SETTINGS = {
  pollMs: 120_000,
  intervalMs: 60 * 60_000,
  minSeams: 30,
  everySeams: 40,
  candidates: 1
}

export function configureModels({ config = {}, store = null, host = null }: any = {}) {
  storeRef = store
  const saved = store?.get?.('models.settings') ?? null
  const runtime = host ?? hostInfo()
  // Precedence: defaults < device profile < config file < saved user choice.
  // A phone gets the cheap schedule on first boot, but an owner who has
  // pinned `candidates: 2` keeps it.
  const base = runtime.mobile ? merge(DEFAULT_MODEL_SETTINGS, MOBILE_MODEL_SETTINGS) : DEFAULT_MODEL_SETTINGS
  state = merge(merge(base, config.models ?? config), saved ?? {}) as any
  state.device = { profile: runtime.profile, termux: runtime.termux, mobile: runtime.mobile }
  // The token belongs in the environment, not the database. A stored one is
  // dropped on every boot rather than silently trusted.
  state.hf.token = process.env.LIVY_HF_TOKEN ?? process.env.HF_TOKEN ?? ''
  state.hf.enabled = Boolean(state.hf.enabled || process.env.LIVY_HF_MODELS === '1')
  state.hf.repo = process.env.LIVY_HF_REPO ?? state.hf.repo ?? ''
  state.autoTrain = process.env.LIVY_AUTO_TRAIN === '0' ? false : state.autoTrain !== false
  state.fast = process.env.LIVY_MODEL_FAST === '0' ? false : state.fast !== false
  state.saveDir = process.env.LIVY_MODEL_DIR ?? state.saveDir ?? ''
  state.enabled = process.env.LIVY_MODELS === '0' ? false : state.enabled !== false
  return state
}

export function modelSettings() {
  return state
}

/** Persist a patch (never the token) and return the new settings. */
export function updateModelSettings(patch: any = {}) {
  const clean = { ...patch }
  if (clean.preset !== undefined && !isModelPreset(clean.preset)) {
    const error: any = new Error(`Unknown model preset \"${clean.preset}\" (try: auto, fast, balanced, wide, deep)`)
    error.status = 400
    throw error
  }
  if (clean.hf) {
    const { token, ...rest } = clean.hf
    clean.hf = { ...rest, private: true }
  }
  state = merge(state, clean)
  const { token, ...persisted } = state.hf
  storeRef?.set?.('models.settings', { ...state, hf: persisted })
  return state
}

export function modelsDataDir() {
  return paths.data
}
