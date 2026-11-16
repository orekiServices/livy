/**
 * Models on this filesystem.
 *
 * `models/` next to the server ships with a release and may be read-only, so
 * the writable data directory (`data/models`) wins for the same name. New
 * checkpoints are Safetensors; legacy Livy `.bin` models remain discoverable
 * and are converted on explicit activation.
 */
import fs from 'node:fs'
import path from 'node:path'
import { paths } from '../../../config.ts'
import { unpackModel, digestOf } from '../format.ts'
import { packNetworkSafetensors, unpackNetworkSafetensors } from '../safetensors.ts'
import { FEATURES } from '../features.ts'
import { modelSettings } from '../settings.ts'

export const MANIFEST = 'manifest.json'
const MODEL_EXTENSIONS = new Set(['.safetensors', '.bin'])

/**
 * Where trained models are written.
 *
 * `models.saveDir` (and `LIVY_MODEL_DIR`) let an owner put weights on a bigger
 * disk. That directory then has to be the *first* place the host looks, or a
 * model can be trained and activated without the server finding it.
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

function readArtifact(file, buffer) {
  return path.extname(file).toLowerCase() === '.safetensors' ? unpackNetworkSafetensors(buffer) : unpackModel(buffer)
}

function writeAtomic(file, buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, buffer)
  fs.renameSync(temporary, file)
}

/** Every Safetensors model and legacy `.bin` in every model directory, newest first. */
export function listModels() {
  const seen = new Map()
  for (const dir of modelDirs()) {
    let names = []
    try {
      names = fs.readdirSync(dir).filter((name) => MODEL_EXTENSIONS.has(path.extname(name).toLowerCase()))
    } catch {
      continue
    }
    for (const name of names) {
      const file = path.join(dir, name)
      try {
        const stat = fs.statSync(file)
        if (!stat.isFile() || seen.has(name)) continue
        const extension = path.extname(name).toLowerCase()
        seen.set(name, {
          file,
          name,
          bytes: stat.size,
          modified: stat.mtimeMs,
          dir,
          format: extension.slice(1),
          legacy: extension === '.bin'
        })
      } catch {
        // Vanished between readdir and stat.
      }
    }
  }
  return [...seen.values()].sort((a, b) => b.modified - a.modified || Number(a.legacy) - Number(b.legacy))
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

/**
 * Activate a model by writing the manifest. Explicit activation of a legacy
 * `.bin` first converts it to Safetensors in the writable model directory;
 * baked release files are copied there rather than modified in place.
 */
export function activateLocal(name, { dir = writableModelDir() }: any = {}) {
  const sourceFile = path.isAbsolute(name) ? name : path.join(dir, name)
  if (!fs.existsSync(sourceFile)) throw new Error(`No model file named ${path.basename(sourceFile)}`)
  const sourceBuffer = fs.readFileSync(sourceFile)
  const extension = path.extname(sourceFile).toLowerCase()
  if (!MODEL_EXTENSIONS.has(extension)) throw new Error(`Unsupported model format "${extension || '(none)'}"`)

  fs.mkdirSync(dir, { recursive: true })
  let activeFile = sourceFile
  let buffer: Buffer<ArrayBufferLike> = sourceBuffer
  let model = readArtifact(sourceFile, sourceBuffer)
  let convertedFrom: string | null = null

  if (extension === '.bin') {
    activeFile = path.join(dir, `${path.basename(sourceFile, extension)}.safetensors`)
    buffer = packNetworkSafetensors({
      ...model,
      metadata: { legacyFormat: 'LVDJ-bin', convertedOnActivation: 'true' }
    })
    writeAtomic(activeFile, buffer)
    model = unpackNetworkSafetensors(buffer)
    convertedFrom = sourceFile
  } else {
    const writableFile = path.join(dir, path.basename(sourceFile))
    if (path.resolve(sourceFile) !== path.resolve(writableFile)) {
      writeAtomic(writableFile, sourceBuffer)
      activeFile = writableFile
    }
  }

  let parameters = 0
  for (const layer of model.weights) parameters += layer.length
  for (const layer of model.biases) parameters += layer.length

  const manifest = {
    file: path.basename(activeFile),
    format: 'safetensors',
    digest: digestOf(buffer),
    steps: model.steps,
    features: model.features,
    trainedAt: model.trainedAt,
    parameters,
    ...(convertedFrom ? { convertedFrom: path.basename(convertedFrom) } : {})
  }
  writeAtomic(path.join(dir, MANIFEST), Buffer.from(JSON.stringify(manifest, null, 2)))
  return { ...manifest, file: activeFile, activated: true, converted: Boolean(convertedFrom) }
}

/** Load one saved model without going through the host cache. */
export function readLocalModel(name, { dir = writableModelDir() }: any = {}) {
  const file = path.isAbsolute(name) ? name : path.join(dir, name)
  const buffer = fs.readFileSync(file)
  return { ...readArtifact(file, buffer), file, digest: digestOf(buffer), name: path.basename(file), format: path.extname(file).slice(1) }
}

/**
 * Save a network as an active model, or as a candidate next to the active one.
 * New training output is Safetensors, written atomically so a station reading
 * the directory never sees half a file.
 */
export function saveModel(network, { features = FEATURES, steps = 0, name = null, activate = true, dir = null }: any = {}) {
  const target = dir ?? writableModelDir()
  fs.mkdirSync(target, { recursive: true })

  const buffer = packNetworkSafetensors({ ...network.parameters(), features, steps, trainedAt: Date.now() })
  const digest = digestOf(buffer)
  const baseName = name ? path.basename(String(name)).replace(/(?:\.bin|\.safetensors)$/i, '') : `dj-${new Date().toISOString().slice(0, 10)}-${digest}`
  const file = `${baseName}.safetensors`
  const full = path.join(target, file)
  writeAtomic(full, buffer)

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
