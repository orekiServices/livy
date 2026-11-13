/**
 * Training, single and multi.
 *
 * `trainModel` is the one-shot call the API has always had. `trainModels`
 * trains several candidate networks — different widths and seeds — scores them
 * on the same held-out split and activates the best. Both run in the event
 * loop's gaps: a station never waits for a model to finish learning.
 */
import createLogger from '../../../util/logger.js'
import { Network } from '../network.js'
import { ACTIONS, FEATURES } from '../features.js'
import { models } from '../host.js'
import { saveModel } from '../storage/local.js'
import { modelSettings } from '../settings.js'
import { recordModel } from '../registry.js'
import { buildDataset, accuracy, loss, readSeams, split, LOG_FILE } from './dataset.js'
import { gpuAvailable, trainOnGpu } from './gpu.js'
import { trainingProfile } from '../device.js'

export { readSeams, recordSeam, buildDataset, split, accuracy, loss, LOG_FILE, seamCount } from './dataset.js'
export { gpuAvailable, trainOnGpu } from './gpu.js'

const log = createLogger('dj-trainer')

/** Two hidden layers by default: 16 → 24 → 16 → 10 learns this quickly. */
export const DEFAULT_SHAPE = [24, 16]
export const FAST_SHAPE = [16, 12]

/** Different widths give the multi-run something real to choose between. */
function shapesFor({ fast, count, profile = trainingProfile() }) {
  const pool = fast ? profile.fastShapes : profile.shapes
  return pool.slice(0, count)
}

/** Copy an incumbent's weights when the shapes line up (warm start). */
function warmStart(network) {
  const active = models.active
  if (!active?.network) return false
  const same = active.network.shape.length === network.shape.length && active.network.shape.every((width, index) => width === network.shape[index])
  if (!same) return false
  try {
    network.load({ weights: active.network.weights, biases: active.network.biases })
    return true
  } catch {
    return false
  }
}

async function trainCandidate({ train, test, shape, epochs, learningRate, gpu, seed, warm, profile = trainingProfile() }) {
  const started = Date.now()
  const network = new Network([FEATURES.length, ...shape, ACTIONS.length], { seed })
  const warmed = warm ? warmStart(network) : false
  const accuracyBefore = accuracy(network, test)

  let backend = 'cpu'
  const wantsGpu = gpu === true || (gpu === 'auto' && (await gpuAvailable()))
  if (wantsGpu) {
    try {
      const done = await trainOnGpu(network, train, { epochs, learningRate })
      if (done) backend = 'gpu'
    } catch (error) {
      log.warn(`GPU training unavailable (${error.message}); using the CPU`)
    }
  }

  if (backend === 'cpu') {
    const batchSize = Math.min(profile.batchMax, Math.max(1, Math.floor(train.length / 4)))
    for (let epoch = 0; epoch < epochs; epoch += 1) {
      for (let start = 0; start < train.length; start += batchSize) {
        network.train(train.slice(start, start + batchSize), { learningRate, step: epoch + 1 })
      }
      // Hand the event loop back: this is the difference between training
      // "while playing" and training "instead of playing". A phone yields
      // more often because its scheduler is less forgiving.
      if (epoch % profile.yieldEvery === 0) await new Promise((resolve) => setImmediate(resolve))
    }
  }

  return {
    network,
    shape: [FEATURES.length, ...shape, ACTIONS.length],
    hidden: shape,
    backend,
    warmed,
    accuracyBefore: Number(accuracyBefore.toFixed(3)),
    accuracyAfter: Number(accuracy(network, test).toFixed(3)),
    loss: Number(loss(network, test).toFixed(5)),
    parameters: network.parameterCount,
    ms: Date.now() - started
  }
}

/** The best candidate: accuracy, then loss, then the smaller model. */
function pickBest(candidates) {
  return [...candidates].sort(
    (a, b) => b.accuracyAfter - a.accuracyAfter || a.loss - b.loss || a.parameters - b.parameters
  )[0]
}

/**
 * Train one or more candidates and activate the best.
 *
 * @returns {Promise<object>} a report, never a throw for "not enough data"
 */
export async function trainModels({
  file = LOG_FILE(),
  store = null,
  count = 1,
  epochs = 0,
  learningRate = 0.01,
  activate = true,
  saveDir = null,
  gpu = 'auto',
  // null means "use the settings"; the old `false` default silently
  // overrode `settings.fast` on every call.
  fast = null,
  shape = null,
  warm = false,
  station = null,
  profile = null
} = {}) {
  const started = Date.now()
  const budget = profile ?? trainingProfile()
  // Bound the read as well as the set: a phone should not deserialize 20,000
  // rows only to throw most of them away.
  const records = readSeams({ file, store, limit: budget.maxPairs })
  // Bound the set before splitting: a phone should not pay for two years of
  // seams, and the most recent behaviour is the behaviour worth learning.
  let pairs = buildDataset(records)
  if (pairs.length > budget.maxPairs) pairs = pairs.slice(-budget.maxPairs)
  if (pairs.length < 12) {
    return {
      trained: false,
      reason: `only ${pairs.length} labelled seams (12 needed)`,
      seams: records.length,
      labelled: pairs.length,
      logged: file
    }
  }

  const { train, test, holdout } = split(pairs)
  const total = Math.max(1, Math.min(8, Number(count) || 1))
  const fastMode = fast ?? modelSettings().fast
  const candidatesShapes = shape ? [shape] : shapesFor({ fast: fastMode, count: total, profile: budget })
  const runs = epochs || (fastMode ? budget.fastEpochs : budget.epochs)
  const settings = modelSettings()

  // A random network sets the floor. Beating the incumbent is checked later,
  // against the active model's own held-out score.
  const baselineNetwork = new Network([FEATURES.length, ...(candidatesShapes[0] ?? DEFAULT_SHAPE), ACTIONS.length])
  const baseline = accuracy(baselineNetwork, test)
  const incumbent = models.active?.network ? accuracy(models.active.network, test) : null

  const candidates = []
  for (let index = 0; index < candidatesShapes.length; index += 1) {
    try {
      const candidate = await trainCandidate({
        train,
        test,
        shape: candidatesShapes[index],
        epochs: runs,
        learningRate,
        // One GPU at a time is plenty; a multi-run trains on the CPU.
        // A phone profile never asks: WebGPU is not reachable from Termux.
        gpu: budget.gpu ? (candidatesShapes.length > 1 ? (gpu === true ? false : gpu) : gpu) : 'off',
        seed: 0x5eed + index * 7919,
        warm,
        profile: budget
      })
      candidates.push({ index, ...candidate })
    } catch (error) {
      candidates.push({ index, error: error.message })
    }
  }

  const usable = candidates.filter((candidate) => candidate.network)
  if (!usable.length) {
    return { trained: false, reason: 'every candidate failed', seams: records.length, labelled: pairs.length, candidates }
  }

  const best = pickBest(usable)
  const reference = incumbent ?? baseline
  const improved = best.accuracyAfter >= reference

  const savedCandidates = []
  for (const candidate of usable) {
    if (!candidate.network) continue
    const isBest = candidate === best
    const shouldActivate = Boolean(activate && improved && isBest)
    try {
      const saved = saveModel(candidate.network, {
        features: FEATURES,
        steps: runs,
        activate: shouldActivate,
        dir: saveDir
      })
      const record = recordModel(
        {
          name: saved.name,
          digest: saved.digest,
          file: saved.file,
          shape: candidate.shape,
          parameters: candidate.parameters,
          accuracy: candidate.accuracyAfter,
          loss: candidate.loss,
          backend: candidate.backend,
          station,
          active: shouldActivate
        },
        { store }
      )
      savedCandidates.push({ ...candidate, network: undefined, name: saved.name, digest: saved.digest, file: saved.file, activated: shouldActivate, record })
      // The caller never needs the network; drop it from the report.
      candidate.network = null
    } catch (error) {
      savedCandidates.push({ ...candidate, network: undefined, error: `could not save: ${error.message}` })
      candidate.network = null
    }
  }

  if (improved && activate) models.reload()
  models.noteTraining({ activated: improved && activate })

  const savedBest = savedCandidates.find((candidate) => candidate.name && candidate.accuracyAfter === best.accuracyAfter) ?? savedCandidates[0] ?? null

  const report = {
    trained: true,
    mode: candidatesShapes.length > 1 ? 'multi' : 'single',
    profile: budget.id,
    fast: fastMode,
    seams: records.length,
    labelled: pairs.length,
    train: train.length,
    test: test.length,
    holdout,
    candidates: savedCandidates.map(({ network: _network, ...rest }) => rest),
    best: savedBest,
    count: candidatesShapes.length,
    backend: best.backend,
    epochs: runs,
    learningRate,
    shape: best.shape,
    parameters: best.parameters,
    warm: best.warmed,
    accuracyBefore: Number(reference.toFixed(3)),
    accuracyAfter: best.accuracyAfter,
    incumbentAccuracy: incumbent == null ? null : Number(incumbent.toFixed(3)),
    loss: best.loss,
    improved,
    activated: Boolean(activate && improved),
    model: improved && activate ? { file: savedBest?.file ?? null, name: savedBest?.name ?? null, digest: savedBest?.digest ?? null, activated: true } : null,
    ms: Date.now() - started
  }
  if (!improved) report.reason = `held-out accuracy ${best.accuracyAfter} did not beat ${report.accuracyBefore}; candidates kept, active model unchanged`
  log.info(
    `trained ${candidatesShapes.length} candidate(s) in ${report.ms} ms: ${best.accuracyAfter} held-out${report.activated ? `, activated ${savedBest?.name}` : ', kept incumbent'}`
  )
  return report
}

/** The original single-model entry point, kept compatible. */
export async function trainModel({ fast = null, count = 1, ...options } = {}) {
  return trainModels({ ...options, fast, count })
}

/** The trainer as a background job the owner API can call. */
export async function trainInBackground(options = {}) {
  return trainModels(options).catch((error) => ({ trained: false, reason: error.message }))
}

/**
 * The seam the model would see, from what the station knows. Kept here so the
 * trainer's features and the server's features cannot drift apart.
 */
export function seamFor({ report = {}, track = null, next = null, hour = new Date().getHours() } = {}) {
  return {
    bpmOut: report.beat?.bpm ?? report.bpmOut ?? 0,
    bpmIn: report.beat?.toBpm ?? report.bpmIn ?? 0,
    matched: Boolean(report.beat?.matched),
    correlation: report.correlation ?? 0,
    loudnessGap: report.loudness?.appliedDb ?? 0,
    energy: report.energy ?? 0.5,
    energyIn: report.energyIn ?? report.energy ?? 0.5,
    vocalOut: report.vocal?.out ?? 0,
    vocalIn: report.vocal?.in ?? 0,
    fadeMs: report.blendMs ?? 6000,
    phraseAligned: Boolean(report.phrase?.aligned),
    talkover: Boolean(report.dj),
    hour,
    out: track?.id ?? null,
    in: next?.id ?? null
  }
}

export default trainModels
