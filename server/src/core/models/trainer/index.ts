/**
 * Training, single and multi.
 *
 * `trainModel` is the one-shot call the API has always had. `trainModels`
 * trains several candidate networks — different widths and seeds — scores them
 * on the same held-out split and activates the best. Both run in the event
 * loop's gaps: a station never waits for a model to finish learning.
 */
import createLogger from '../../../util/logger.ts'
import { Network } from '../network.ts'
import { ACTIONS, FEATURES } from '../features.ts'
import { models } from '../host.ts'
import { saveModel } from '../storage/local.ts'
import { modelSettings } from '../settings.ts'
import { recordModel } from '../registry.ts'
import { buildDataset, accuracy, brier, brierSkill, confidence, loss, readSeams, recencySummary, split, support, LOG_FILE } from './dataset.ts'
import { gpuAvailable, trainOnGpu } from './gpu.ts'
import { planTorch, trainWithTorch, torchStatus, trainBackend } from './torch.ts'
import { trainingProfile } from '../device.ts'
import { trainRL } from '../rl.ts'

export {
  readSeams,
  recordSeam,
  buildDataset,
  split,
  accuracy,
  brier,
  brierSkill,
  confidence,
  loss,
  recencySummary,
  sampleWeight,
  support,
  LOG_FILE,
  seamCount
} from './dataset.ts'
export { gpuAvailable, trainOnGpu } from './gpu.ts'
export { planTorch, torchStatus, trainBackend } from './torch.ts'

const log = createLogger('dj-trainer')

/** Two hidden layers by default: 16 → 24 → 16 → 10 learns this quickly. */
export const DEFAULT_SHAPE = [24, 16]
export const FAST_SHAPE = [16, 12]

/** Different widths give the multi-run something real to choose between. */
function shapesFor({ fast, count, profile = trainingProfile() }) {
  const pool = fast ? profile.fastShapes : profile.shapes
  return pool.slice(0, count)
}

/**
 * The order a candidate sees its rows in, one epoch at a time.
 *
 * Seam logs are chronological, and the trainer used to feed them to the
 * optimiser in that order: every epoch ended on the newest seams and began on
 * the oldest, so the last few batches of a run — the ones that decide where
 * the weights come to rest — were always a small, unrepresentative slice. With
 * recency weights on the rows that is worse still: the weights only mean
 * something if a batch is drawn from the whole set.
 *
 * Shuffling per epoch, from a seeded generator, fixes both and keeps the run
 * reproducible: same log, same seed, same model.
 */
export function shuffledIndexes(length, seed) {
  const order = new Uint32Array(length)
  for (let i = 0; i < length; i += 1) order[i] = i
  let state = (seed ^ 0x9e3779b9) >>> 0
  for (let i = length - 1; i > 0; i -= 1) {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    const j = state % (i + 1)
    const swap = order[i]
    order[i] = order[j]
    order[j] = swap
  }
  return order
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

async function trainCandidate({
  train,
  test,
  shape,
  epochs,
  learningRate,
  gpu,
  seed,
  warm,
  profile = trainingProfile(),
  // A candidate trained elsewhere (PyTorch, see `./torch.js`): the weights are
  // already learned, so this only measures them. A random network of the same
  // shape answers for "before", which is what the report means by baseline.
  pretrained = null
}) {
  const started = Date.now()
  const network = pretrained?.network ?? new Network([FEATURES.length, ...shape, ACTIONS.length], { seed })
  const warmed = pretrained ? false : warm ? warmStart(network) : false
  const accuracyBefore = accuracy(pretrained ? new Network([FEATURES.length, ...shape, ACTIONS.length], { seed }) : network, test)

  let backend = pretrained?.backend ?? 'cpu'
  const wantsGpu = !pretrained && (gpu === true || (gpu === 'auto' && (await gpuAvailable())))
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
      const order = shuffledIndexes(train.length, seed + epoch * 7919)
      for (let start = 0; start < train.length; start += batchSize) {
        const batch = []
        for (let i = start; i < Math.min(start + batchSize, order.length); i += 1) batch.push(train[order[i]])
        if (batch.length) network.train(batch, { learningRate, step: epoch + 1 })
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
    torch: pretrained?.meta ?? null,
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
  profile = null,
  preset = null,
  // 'auto' uses PyTorch when the host has it, 'js' never does, 'torch' asks
  // for it and still falls back rather than failing the run.
  backend = null
}: any = {}): Promise<Record<string, any>> {
  const started = Date.now()
  // A per-run `preset` wins over the saved setting, which wins over `auto`.
  const budget = profile ?? trainingProfile({ preset: preset ?? modelSettings().preset ?? 'auto' })
  // Bound the read as well as the set: a phone should not deserialize 20,000
  // rows only to throw most of them away.
  const records = readSeams({ file, store, limit: budget.maxPairs })
  // Bound the set before splitting: a phone should not pay for two years of
  // seams, and the most recent behaviour is the behaviour worth learning.
  let pairs = buildDataset(records)
  if (pairs.length > budget.maxPairs) pairs = pairs.slice(-budget.maxPairs)
  // RL learns from the same log and needs far less of it, so it is refitted
  // whether or not there is enough for a network.
  let rlReport = null
  try {
    rlReport = trainRL(records, { save: activate !== false && !saveDir })
  } catch (error) {
    rlReport = { codename: 'RL', trained: false, reason: error.message }
  }
  if (pairs.length < 12) {
    return {
      trained: false,
      rl: rlReport,
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

  // PyTorch first, when the host has it: every candidate in one round trip to
  // the interpreter, which is the difference between a sweep costing seconds
  // and costing the station's CPU for a minute. The JavaScript trainer still
  // measures every candidate and is the fallback for each one that fails.
  const preference = backend ?? trainBackend()
  const parameters = candidatesShapes.reduce((total, hidden) => {
    const widths = [FEATURES.length, ...hidden, ACTIONS.length]
    return total + widths.slice(1).reduce((sum, width, index) => sum + width * widths[index], 0)
  }, 0)
  let torchRun = null
  if (preference !== 'js' && budget.gpu !== false) {
    // Ask the workload before the interpreter: a small hosted node should not
    // start Python at all to be told JavaScript is the faster answer.
    const plan = planTorch({ backend: preference, rows: pairs.length, parameters })
    if (plan.use) {
      const status = await torchStatus()
      if (!status.available && preference !== 'torch') {
        torchRun = { available: false, reason: status.reason }
      } else {
        torchRun = await trainWithTorch({
          train,
          jobs: candidatesShapes.map((shape, index) => ({ shape, seed: 0x5eed + index * 7919 })),
          epochs: runs,
          learningRate
        })
      }
    } else {
      torchRun = { available: false, reason: plan.reason, planned: false }
    }
    if (torchRun.available) {
      log.info(
        `trained ${torchRun.results.length} candidate(s) with PyTorch ${torchRun.torch} on ${torchRun.device} in ${torchRun.ms} ms`
      )
    } else if (preference === 'torch') {
      log.warn(`PyTorch was asked for but is unavailable (${torchRun.reason}); training in JavaScript`)
    }
  }

  const candidates = []
  for (let index = 0; index < candidatesShapes.length; index += 1) {
    try {
      const fromTorch = torchRun?.available ? torchRun.results[index] : null
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
        profile: budget,
        pretrained: fromTorch
          ? {
              network: fromTorch.network,
              backend: 'torch',
              meta: { device: torchRun.device, torch: torchRun.torch, steps: fromTorch.steps, ms: fromTorch.ms, batch: torchRun.batch }
            }
          : null
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
  // Kept before the save loop nulls `network` on every candidate: the report
  // still needs to score the winner.
  const bestNetwork = best.network
  const reference = incumbent ?? baseline
  // Against a random network a tie is still a trained model. Against a model
  // that is already on air it is not an improvement: replacing the incumbent
  // on a tie swapped models every training run for nothing, and a model that
  // changes under an owner who did not ask is worse than one that does not.
  const improved = incumbent == null ? best.accuracyAfter >= reference : best.accuracyAfter > reference || (best.accuracyAfter === reference && best.loss < loss(models.active.network, test))

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

  const report: Record<string, any> = {
    trained: true,
    mode: candidatesShapes.length > 1 ? 'multi' : 'single',
    profile: budget.id,
    preset: budget.preset ?? 'auto',
    host: budget.host ?? budget.id,
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
    // What the numeric accuracy does not say: how confident the winner is on
    // rows it has never seen, and whether it learned more than one answer.
    eval: {
      brier: Number(brier(bestNetwork ?? baselineNetwork, test).toFixed(4)),
      // 0 = no better than a uniform guess; 1 = certain and right.
      skill: Number(brierSkill(bestNetwork ?? baselineNetwork, test).toFixed(3)),
      confidence: Number(confidence(bestNetwork ?? baselineNetwork, test).toFixed(3)),
      support: support(train),
      heldOut: test.length
    },
    // The weights the run used, so a model trained on a year of log and one
    // trained on last month can be told apart from the report.
    recency: recencySummary(train),
    incumbentAccuracy: incumbent == null ? null : Number(incumbent.toFixed(3)),
    loss: best.loss,
    improved,
    // What the interpreter did, if it was asked. `null` means the JavaScript
    // trainer was used for every candidate.
    torch: torchRun
      ? torchRun.available
        ? { available: true, used: true, device: torchRun.device, version: torchRun.torch, interpreter: torchRun.interpreter, batch: torchRun.batch, ms: torchRun.ms }
        : { available: false, used: false, reason: torchRun.reason, planned: torchRun.planned !== false }
      : { available: false, used: false, reason: preference === 'js' ? 'the JavaScript trainer was asked for' : 'not attempted' },
    rl: rlReport,
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
export async function trainModel({ fast = null, count = 1, ...options }: any = {}) {
  return trainModels({ ...options, fast, count })
}

/** The trainer as a background job the owner API can call. */
export async function trainInBackground(options: any = {}) {
  return trainModels(options).catch((error) => ({ trained: false, reason: error.message }))
}

/**
 * The seam the model would see, from what the station knows. Kept here so the
 * trainer's features and the server's features cannot drift apart.
 */
export function seamFor({ report = {}, track = null, next = null, hour = new Date().getHours() }: any = {}) {
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
