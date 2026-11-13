/**
 * The training budget for this host.
 *
 * The same policy can be trained on a server in 50 ms, but a phone is not a
 * small server: it has fewer cores, less RAM, a battery, and a thermal limit.
 * The mobile profile keeps training *on* — one tiny candidate, a handful of
 * epochs, a bounded dataset — so auto-train still learns on a Termux node
 * without heating the phone or fighting the audio thread.
 */
import { hostInfo } from '../../util/platform.js'
import { MODEL_PRESETS, isModelPreset } from './presets.js'

export const SERVER_PROFILE = {
  id: 'server',
  preset: 'auto',
  host: 'server',
  shapes: [[24, 16], [32, 20], [24, 24, 12], [40, 24, 16]],
  fastShapes: [[16, 12], [20, 14], [24, 12], [16, 16]],
  epochs: 120,
  fastEpochs: 40,
  batchMax: 16,
  maxPairs: 20_000,
  gpu: true,
  yieldEvery: 8
}

export const ANDROID_PROFILE = {
  id: 'android',
  preset: 'auto',
  host: 'android',
  // One hidden layer: ~300 parameters, one matrix multiply per inference.
  shapes: [[12], [14]],
  fastShapes: [[12], [14]],
  epochs: 30,
  fastEpochs: 26,
  batchMax: 8,
  // 1,200 seams is months of radio for one station; more only costs battery.
  maxPairs: 1200,
  gpu: false,
  yieldEvery: 4
}

/**
 * Resolve a preset against a host.
 *
 * `auto` is the device profile. A named preset contributes the architecture
 * and the epoch/data budget; the *host* still owns the things a phone must
 * keep small (`batchMax`, `yieldEvery`) and whether a GPU is reachable. A
 * preset therefore never makes a phone pretend to be a server, and it cannot
 * ask a phone for WebGPU.
 */
export function trainingProfile({ env = process.env, host = null, preset = 'auto' } = {}) {
  const info = host ?? hostInfo(env)
  const base = info.mobile ? ANDROID_PROFILE : SERVER_PROFILE
  const id = isModelPreset(preset) ? preset : 'auto'
  if (id === 'auto') return { ...base, preset: 'auto', host: base.id }

  const chosen = MODEL_PRESETS[id]
  return {
    ...base,
    id,
    preset: id,
    host: base.id,
    label: chosen.label,
    shapes: chosen.shapes,
    // Fast mode changes the number of epochs, not the architecture: choosing
    // `wide` should still train a wide net.
    fastShapes: chosen.shapes,
    epochs: chosen.epochs,
    fastEpochs: chosen.fastEpochs,
    candidates: chosen.candidates,
    maxPairs: Math.min(base.maxPairs, chosen.maxPairs ?? base.maxPairs)
  }
}
