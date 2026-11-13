/**
 * Runtime settings for the model subsystem.
 *
 * The server calls `configureModels({ config, store })` once at boot, after
 * which every part of training and storage reads the same object. The store is
 * optional so the trainer still works in a test or a one-off script.
 */
import { paths } from '../../config.js'

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

let state = structuredClone(DEFAULT_MODEL_SETTINGS)
let storeRef = null

const merge = (base, patch) => {
  if (!patch || typeof patch !== 'object') return base
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(base?.[key] ?? {}, value) : value
  }
  return out
}

export function configureModels({ config = {}, store = null } = {}) {
  storeRef = store
  const saved = store?.get?.('models.settings') ?? null
  state = merge(merge(DEFAULT_MODEL_SETTINGS, config.models ?? config), saved ?? {})
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
export function updateModelSettings(patch = {}) {
  const clean = { ...patch }
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
