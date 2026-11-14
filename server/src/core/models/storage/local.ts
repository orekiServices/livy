/**
 * Models on this filesystem.
 *
 * `models/` next to the server ships with a release and may be read-only, so
 * the writable data directory (`data/models`) wins for the same name. Every
 * operation here is tolerant of missing directories: a node with no models is
 * a node where the heuristic decides, which is always a working station.
 */
import fs from 'node:fs'
import path from 'node:path'
import { paths } from '../../../config.ts'
import { unpackModel, digestOf, packModel } from '../format.ts'
import { FEATURES } from '../features.ts'
import { modelSettings } from '../settings.ts'

export const MANIFEST = 'manifest.json'

/**
 * Where trained models are written.
 *
 * `models.saveDir` (and `LIVY_MODEL_DIR`) let an owner put weights on a bigger
 * disk. That directory then has to be the *first* place the host looks, or a
 * model can be trained and activated without automix ever finding it.
 */
export function writableModelDir() {
  const configured = modelSettings()?.saveDir
  if (configured) return path.isAbsolute(configured) ? configured : path.resolve(paths.root, configured)
  return path.join(paths.data, 'models')
}

/** Configured writable first, then the baked release folder. */
export function modelDirs() {
  const baked = path.join(paths.root, 'models')
  const writable = writableModelDir()
  return path.resolve(writable) === path.resolve(baked) ? [baked] : [writable, baked]
}

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
        if (!seen.has(name)) seen.set(name, { file, name, bytes: stat.size, modified: stat.mtimeMs, dir })
      } catch {
        // Vanished between readdir and stat.
      }
    }
  }
  return [...seen.values()].sort((a, b) => b.modified - a.modified)
}

/** Env override → manifest → newest file. */
export function resolveModel({ file = process.env.LIVY_DJ_MODEL }: any = {}) {
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

/** Point the manifest at an existing `.bin`. Used by activation and pull. */
export function activateLocal(name, { dir = writableModelDir() }: any = {}) {
  const file = path.isAbsolute(name) ? name : path.join(dir, name)
  if (!fs.existsSync(file)) throw new Error(`No model file named ${path.basename(file)}`)
  const buffer = fs.readFileSync(file)
  const model = unpackModel(buffer)
  const manifest = {
    file: path.basename(file),
    digest: digestOf(buffer),
    steps: model.steps,
    features: model.features,
    trainedAt: model.trainedAt,
    parameters: model.weights.reduce((total, layer) => total + layer.length, 0) + model.biases.reduce((total, layer) => total + layer.length, 0)
  }
  fs.mkdirSync(dir, { recursive: true })
  const temporary = path.join(dir, `${MANIFEST}.${process.pid}.tmp`)
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2))
  fs.renameSync(temporary, path.join(dir, MANIFEST))
  return { ...manifest, file, activated: true }
}

/** Load one saved model without going through the host cache. */
export function readLocalModel(name, { dir = writableModelDir() }: any = {}) {
  const file = path.isAbsolute(name) ? name : path.join(dir, name)
  const buffer = fs.readFileSync(file)
  return { ...unpackModel(buffer), file, digest: digestOf(buffer), name: path.basename(file) }
}

/**
 * Save a network as an active model, or as a candidate next to the active one.
 * Writes atomically so a station reading the directory never sees half a file.
 */
export function saveModel(network, { features = FEATURES, steps = 0, name = null, activate = true, dir = null }: any = {}) {
  const target = dir ?? writableModelDir()
  fs.mkdirSync(target, { recursive: true })

  const buffer = packModel({ ...network.parameters(), features, steps, trainedAt: Date.now() })
  const digest = digestOf(buffer)
  const file = name ?? `dj-${new Date().toISOString().slice(0, 10)}-${digest}.bin`
  const full = path.join(target, file)

  const temporary = `${full}.${process.pid}.tmp`
  fs.writeFileSync(temporary, buffer)
  fs.renameSync(temporary, full)

  let manifest = null
  if (activate) manifest = activateLocal(file, { dir: target })

  return { file: full, name: file, bytes: buffer.length, digest, activated: activate, manifest }
}

/** Delete a model file. The active one is left alone: switch away first. */
export function removeLocalModel(name, { dir = writableModelDir() }: any = {}) {
  const file = path.isAbsolute(name) ? name : path.join(dir, name)
  if (!fs.existsSync(file)) return false
  fs.rmSync(file, { force: true })
  return true
}
