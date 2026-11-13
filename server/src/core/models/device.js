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

export const SERVER_PROFILE = {
  id: 'server',
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

export function trainingProfile({ env = process.env, host = null } = {}) {
  const info = host ?? hostInfo(env)
  return info.mobile ? ANDROID_PROFILE : SERVER_PROFILE
}
