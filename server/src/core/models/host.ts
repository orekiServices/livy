/**
 * The loaded policy, and the only thing a station asks about models.
 *
 * Rules unchanged from the original host, and they are the reason a model can
 * be trained on a live node: a missing, corrupt or mismatched file is a
 * warning and `null`, never an outage.
 */
import fs from 'node:fs'
import path from 'node:path'
import createLogger from '../../util/logger.ts'
import { Network } from './network.ts'
import { digestOf, unpackModel } from './format.ts'
import { ACTIONS, FEATURES, featuresFor } from './features.ts'
import { listModels, modelDirs, resolveModel } from './storage/local.ts'

const log = createLogger('dj-model')

class ModelHost {
  #cache = new Map()
  #active = null
  #loaded = false
  #mismatch = null
  #stats = { loads: 0, failures: 0, predictions: 0, trainings: 0, activated: 0 }

  /** The model in use, loaded lazily. `null` means the heuristic decides. */
  get active() {
    if (this.#loaded) return this.#active
    return this.reload()
  }

  get name() {
    return this.active?.name ?? null
  }

  /** Force a re-read — after training, after a pull, and by the owner API. */
  reload() {
    const found = resolveModel()
    this.#loaded = true
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

  /** Score every transition for a seam; `null` means "ask the heuristic". */
  score(seam: any = {}) {
    const model = this.active
    if (!model) return null
    if (model.features.length !== FEATURES.length || model.features.some((name, index) => name !== FEATURES[index])) {
      if (this.#mismatch !== model.name) {
        this.#mismatch = model.name
        log.warn(`DJ model ${model.name} was trained on ${model.features.length} features; this build needs ${FEATURES.length}. Ignoring it.`)
      }
      return null
    }
    try {
      const features = featuresFor(seam)
      const output = Array.from(model.network.predict(features) as Iterable<number>)
      const order = ACTIONS.map((name, index) => ({ name, score: Number(output[index]) })).sort((a, b) => b.score - a.score)
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

  /** First-order sensitivity: why the model chose what it chose. */
  explain(seam: any = {}, action: any = null) {
    const model = this.active
    if (!model) return null
    const features = featuresFor(seam)
    const base = Array.from(model.network.predict(features) as Iterable<number>)
    const wanted = ACTIONS.indexOf(action ?? ACTIONS[base.indexOf(Math.max(...base))])
    if (wanted < 0) return null
    const contributions = FEATURES.map((name, index) => {
      const probe = features.slice()
      probe[index] = Math.max(-1, Math.min(1, probe[index] + 0.1))
      const moved = Array.from(model.network.predict(probe) as Iterable<number>)
      return { feature: name, contribution: Number((moved[wanted] - base[wanted]).toFixed(4)) }
    })
    contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    return { action: ACTIONS[wanted], base: Number(base[wanted].toFixed(4)), contributions: contributions.slice(0, 6) }
  }

  /** The public view — no absolute paths. */
  info() {
    const model = this.active
    return {
      loaded: Boolean(model),
      enabled: true,
      available: listModels().map((entry) => ({ name: entry.name, bytes: entry.bytes, modified: entry.modified })),
      stats: { ...this.#stats },
      model: model
        ? {
            name: model.name,
            source: model.source,
            steps: model.steps,
            trainedAt: model.trainedAt,
            features: model.features.length,
            parameters: model.network.parameterCount,
            digest: model.digest
          }
        : null
    }
  }

  /** Owner view: everything above, plus where the files live. */
  detail() {
    return { ...this.info(), dirs: modelDirs() }
  }

  /** Called by the trainer so the owner API can show training volume. */
  noteTraining(report: any = {}) {
    this.#stats.trainings += 1
    if (report.activated) this.#stats.activated += 1
  }

  forget() {
    this.#cache.clear()
    this.#loaded = false
    this.#active = null
    return this.reload()
  }
}

export const models = new ModelHost()

export { ModelHost }
