/**
 * DJ models — where they live, which one is loaded, and how a new one is used.
 *
 * Models are stored in `models/` next to the server, one `.bin` per model,
 * with a `manifest.json` that says which one is active. That directory is
 * committed when a model ships with the release and written to at runtime
 * after training; on Vercel it is read from the bundle and *written* to
 * `data/models`, because the bundle is read-only and a function's `/tmp` does
 * not outlive the instance.
 *
 * Two rules shape everything here:
 *
 *   • **A broken model must never stop a station.** Every failure — missing
 *     directory, corrupt file, shape mismatch — is logged and treated as "no
 *     model", at which point `chooseEffect` is what decides, exactly as it did
 *     before models existed.
 *   • **A model may not do something the console cannot explain.** `explain()`
 *     reports the top features by contribution, so an owner looking at a
 *     surprising transition can see *why* rather than having to trust a blob.
 */
import fs from 'node:fs'
import path from 'node:path'

import { paths } from '../../config.js'
import createLogger from '../../util/logger.js'
import { Network } from './network.js'
import { digestOf, packModel, unpackModel } from './format.js'
import { ACTIONS, FEATURES, featuresFor } from './features.js'

const log = createLogger('dj-model')

/** Where models are read from: the shipped folder, then the writable data dir. */
export function modelDirs() {
  const baked = path.join(paths.root, 'models')
  const writable = path.join(paths.data, 'models')
  return baked === writable ? [baked] : [writable, baked]
}

/** A manifest names the active model; without one, the newest file wins. */
const MANIFEST = 'manifest.json'

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'))
  } catch {
    return null
  }
}

/** Every `.bin` in every model directory, newest first. */
export function listModels() {
  const seen = new Map()
  for (const dir of modelDirs()) {
    let names = []
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.bin'))
    } catch {
      continue
    }
    for (const name of names) {
      const file = path.join(dir, name)
      try {
        const stat = fs.statSync(file)
        // The writable directory shadows the baked one for the same name.
        if (!seen.has(name)) seen.set(name, { file, name, bytes: stat.size, modified: stat.mtimeMs, dir })
      } catch {
        /* vanished between the readdir and the stat */
      }
    }
  }
  return [...seen.values()].sort((a, b) => b.modified - a.modified)
}

/**
 * Pick the model to load.
 *
 * Explicit `LIVY_DJ_MODEL` beats the manifest, which beats the newest file.
 * That order is deliberate: an operator pinning a file in an env var is a
 * deliberate act, a manifest is the last thing the trainer wrote, and "the
 * newest" is the only sane fallback when neither exists.
 */
export function resolveModel({ file = process.env.LIVY_DJ_MODEL } = {}) {
  if (file) return { file: path.isAbsolute(file) ? file : path.resolve(paths.root, file), source: 'env' }
  for (const dir of modelDirs()) {
    const manifest = readManifest(dir)
    if (manifest?.file) {
      const candidate = path.join(dir, manifest.file)
      if (fs.existsSync(candidate)) return { file: candidate, source: 'manifest', manifest }
    }
  }
  const [newest] = listModels()
  return newest ? { file: newest.file, source: 'newest' } : null
}

/**
 * Loaded models, by path, with their network.
 *
 * A cache because the station asks on every seam and the file does not change
 * between seams; invalidated on `mtime`, so a model trained while the station
 * is on air is picked up on the next transition without a restart.
 */
class ModelHost {
  #cache = new Map()
  #active = null
  #mismatch = null
  #stats = { loads: 0, failures: 0, predictions: 0 }

  /** The model in use, loaded lazily. `null` means the heuristic decides. */
  get active() {
    if (this.#active !== undefined && this.#active !== null) return this.#active
    return this.reload()
  }

  /** Force a re-read — used after training and by the owner API. */
  reload() {
    const found = resolveModel()
    if (!found) {
      this.#active = null
      return null
    }
    try {
      const stat = fs.statSync(found.file)
      const cached = this.#cache.get(found.file)
      if (cached && cached.mtime === stat.mtimeMs) {
        this.#active = cached
        return cached
      }
      const buffer = fs.readFileSync(found.file)
      const model = unpackModel(buffer)
      // The shape is in the file: inputs, each layer's output count, and the
      // last layer's width, which is the number of transitions.
      const shape = [model.featureCount, ...model.biases.map((bias) => bias.length)]
      const network = new Network(shape)
      network.load(model)

      const entry = {
        ...model,
        file: found.file,
        source: found.source,
        name: path.basename(found.file),
        network,
        mtime: stat.mtimeMs,
        digest: digestOf(buffer)
      }
      this.#cache.set(found.file, entry)
      this.#active = entry
      this.#stats.loads += 1
      log.info(`loaded ${entry.name} (${model.steps} steps, ${network.parameterCount} params, ${entry.digest})`)
      return entry
    } catch (error) {
      this.#stats.failures += 1
      log.warn(`could not load DJ model ${found.file}: ${error.message}`)
      this.#active = null
      return null
    }
  }

  /**
   * Score every transition type for a seam.
   *
   * Returns `null` when there is no model or it cannot be used, and
   * `{ scores, order, best, margin, features, model }` otherwise. The caller
   * treats a `null` as "ask the heuristic", never as "no transition".
   */
  score(seam = {}) {
    const model = this.active
    if (!model) return null
    // The feature list is part of the model: a file trained with a different
    // set is not usable, and guessing would produce confident nonsense.
    if (model.features.length !== FEATURES.length || model.features.some((name, index) => name !== FEATURES[index])) {
      if (this.#mismatch !== model.name) {
        this.#mismatch = model.name
        log.warn(`DJ model ${model.name} was trained on ${model.features.length} features; this build needs ${FEATURES.length}. Ignoring it.`)
      }
      return null
    }
    try {
      const features = featuresFor(seam)
      const output = Array.from(model.network.predict(features))
      const order = ACTIONS.map((name, index) => ({ name, score: output[index] })).sort((a, b) => b.score - a.score)
      this.#stats.predictions += 1
      return {
        scores: Object.fromEntries(order.map((entry) => [entry.name, Number(entry.score.toFixed(4))])),
        order: order.map((entry) => entry.name),
        best: order[0].name,
        margin: Number((order[0].score - order[1].score).toFixed(4)),
        features: Object.fromEntries(FEATURES.map((name, index) => [name, Number(features[index].toFixed(3))])),
        model: model.name
      }
    } catch (error) {
      log.warn(`DJ model ${model.name} failed to score a seam: ${error.message}`)
      return null
    }
  }

  /**
   * Why the model picked what it picked.
   *
   * A first-order sensitivity: how much the chosen action's score moves when
   * each input moves by a tenth of its range. Not a Shapley value — it is the
   * cheap version that a console can show next to a transition, and it is
   * enough to answer "was it the tempo or the vocal?".
   */
  explain(seam = {}, action = null) {
    const model = this.active
    if (!model) return null
    const features = featuresFor(seam)
    const base = Array.from(model.network.predict(features))
    const wanted = ACTIONS.indexOf(action ?? ACTIONS[base.indexOf(Math.max(...base))])
    if (wanted < 0) return null
    const contributions = FEATURES.map((name, index) => {
      const probe = features.slice()
      probe[index] = Math.max(-1, Math.min(1, probe[index] + 0.1))
      const moved = Array.from(model.network.predict(probe))
      return { feature: name, contribution: Number((moved[wanted] - base[wanted]).toFixed(4)) }
    })
    contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    return { action: ACTIONS[wanted], base: Number(base[wanted].toFixed(4)), contributions: contributions.slice(0, 6) }
  }

  /**
   * The public view.
   *
   * No absolute paths: `/api/v1/setup` is unauthenticated, and a server's
   * directory layout is not something a listener needs. The owner API adds
   * `dirs` separately when it needs to show where to drop a file.
   */
  /** The owner's view: everything `info()` has, plus where the files live. */
  detail() {
    return { ...this.info(), dirs: modelDirs() }
  }

  info() {
    const model = this.active
    return {
      loaded: Boolean(model),
      available: listModels().map((entry) => ({ name: entry.name, bytes: entry.bytes, modified: entry.modified })),
      stats: { ...this.#stats },
      model: model
        ? { name: model.name, source: model.source, steps: model.steps, trainedAt: model.trainedAt, features: model.features.length, parameters: model.network.parameterCount, digest: model.digest }
        : null
    }
  }
}

export const models = new ModelHost()

/**
 * Save a trained network as a new active model.
 *
 * Written atomically: a station reading the directory during a training run
 * sees either the old manifest or the new one, never a half-written file. The
 * previous models are kept — a rollback should not need a retrain.
 */
export function saveModel(network, { features = FEATURES, steps = 0, name = null, activate = true, dir = null } = {}) {
  // Train into the writable data directory by default: `models/` is part of
  // the release and may be read-only (a container image, a Vercel bundle), and
  // a trainer that fails to write is worse than one that writes elsewhere.
  const target = dir ?? path.join(paths.data, 'models')
  fs.mkdirSync(target, { recursive: true })

  const buffer = packModel({ ...network.parameters(), features, steps, trainedAt: Date.now() })
  const digest = digestOf(buffer)
  const file = name ?? `dj-${new Date().toISOString().slice(0, 10)}-${digest}.bin`
  const full = path.join(target, file)

  const temporary = `${full}.${process.pid}.tmp`
  fs.writeFileSync(temporary, buffer)
  fs.renameSync(temporary, full)

  if (activate) {
    const manifest = { file, digest, steps, features, trainedAt: Date.now(), parameters: network.parameterCount }
    fs.writeFileSync(path.join(target, `${MANIFEST}.${process.pid}.tmp`), JSON.stringify(manifest, null, 2))
    fs.renameSync(path.join(target, `${MANIFEST}.${process.pid}.tmp`), path.join(target, MANIFEST))
  }

  // Reload only when this save is the thing being served. A trainer writing a
  // candidate into the data directory must not displace the model an operator
  // pinned with `LIVY_DJ_MODEL` — that would silently change what the station
  // plays as a side effect of training.
  if (activate && !process.env.LIVY_DJ_MODEL) models.reload()
  log.info(`saved ${file} (${buffer.length} bytes, ${steps} steps)`)
  return { file: full, name: file, bytes: buffer.length, digest, activated: activate }
}

export { ACTIONS, FEATURES, featuresFor, Network }
export { unpackModel, packModel } from './format.js'
export default models
