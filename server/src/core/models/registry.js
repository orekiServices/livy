/**
 * The model registry — every candidate, which one is on air, and where the
 * copies live.
 *
 * The filesystem remains the source of truth for *loading* (the host reads the
 * manifest), while MetroDB keeps the history the owner console needs: which
 * run produced a model, how it scored, and whether it was ever pushed to
 * Hugging Face. Losing the database degrades this view, never playback.
 */
import fs from 'node:fs'
import path from 'node:path'
import createLogger from '../../util/logger.js'
import { models } from './host.js'
import { activateLocal, listModels, readLocalModel, removeLocalModel, resolveModel, writableModelDir } from './storage/local.js'
import { downloadFile, ensureRepo, hfConfig, hfReady, hubStatus, listRemote, uploadFile } from './storage/hf.js'
import { seamCount } from './trainer/dataset.js'

const log = createLogger('dj-registry')

/** One row per file on disk, enriched with the database's row when present. */
export function modelInventory({ store = null } = {}) {
  const records = new Map((store?.listModelRecords?.() ?? []).map((record) => [record.name, record]))
  const activeFile = resolveModel()?.file ?? null
  return listModels().map((entry) => {
    const record = records.get(entry.name) ?? null
    return {
      name: entry.name,
      bytes: entry.bytes,
      modified: entry.modified,
      active: entry.file === activeFile,
      accuracy: record?.accuracy ?? null,
      loss: record?.loss ?? null,
      backend: record?.backend ?? null,
      shape: record?.shape ?? null,
      parameters: record?.parameters ?? null,
      remote: record?.remote ?? null,
      createdAt: record?.createdAt ?? entry.modified
    }
  })
}

/** Point the node at a model that already exists on disk. */
export function activateModel(name, { store = null } = {}) {
  const entry = listModels().find((candidate) => candidate.name === name || candidate.file === name)
  if (!entry) throw Object.assign(new Error(`No model named ${name}`), { status: 404 })
  const manifest = activateLocal(entry.file)
  store?.activateModelRecord?.(entry.name)
  models.forget()
  log.info(`active model: ${entry.name}`)
  return { active: entry.name, manifest, info: models.info() }
}

export function forgetModel(name, { store = null } = {}) {
  const entry = listModels().find((candidate) => candidate.name === name || candidate.file === name)
  if (!entry) return { removed: false, reason: 'not found' }
  if (models.name === entry.name) throw Object.assign(new Error('That model is on air; activate another one first'), { status: 409 })
  removeLocalModel(entry.file)
  store?.deleteModelRecord?.(entry.name)
  return { removed: true, name: entry.name }
}

/** Record one trained candidate. The trainer calls this once per model. */
export function recordModel(record, { store = null } = {}) {
  if (!store?.saveModelRecord) return record
  try {
    store.saveModelRecord(record)
  } catch (error) {
    log.debug(`could not record model ${record?.name}: ${error.message}`)
  }
  return record
}

/** Push local models to the private HF repo. Push the active one by default. */
export async function pushModels({ names = null, store = null, cfg = hfConfig(), fetchImpl = fetch } = {}) {
  if (!hfReady(cfg)) throw new Error('HF storage is not configured (set LIVY_HF_REPO and HF_TOKEN)')
  const repo = await ensureRepo(cfg, { fetchImpl })
  const wanted = names?.length ? names : models.name ? [models.name] : listModels().slice(0, 1).map((entry) => entry.name)
  if (!wanted.length) throw Object.assign(new Error('No model to push'), { status: 404 })

  const pushed = []
  for (const name of wanted) {
    const entry = listModels().find((candidate) => candidate.name === name)
    if (!entry) continue
    const buffer = fs.readFileSync(entry.file)
    const remote = await uploadFile(buffer, name, cfg, { fetchImpl })
    store?.setModelRemote?.(name, { repo: cfg.repo, path: remote.path, revision: cfg.revision })
    pushed.push({ name, ...remote })
  }
  return { repo, pushed }
}

/** Pull models from HF into the writable directory. */
export async function pullModels({ names = null, store = null, cfg = hfConfig(), activate = false, fetchImpl = fetch } = {}) {
  if (!hfReady(cfg)) throw new Error('HF storage is not configured (set LIVY_HF_REPO and HF_TOKEN)')
  const remote = await listRemote(cfg, { fetchImpl })
  const wanted = names?.length ? remote.filter((entry) => names.includes(entry.name) || names.includes(entry.path)) : remote
  if (!wanted.length) return { pulled: [] }

  const dir = writableModelDir()
  fs.mkdirSync(dir, { recursive: true })
  const pulled = []
  for (const entry of wanted) {
    const buffer = await downloadFile(entry.path, cfg, { fetchImpl })
    const file = path.join(dir, entry.name)
    fs.writeFileSync(`${file}.${process.pid}.tmp`, buffer)
    fs.renameSync(`${file}.${process.pid}.tmp`, file)
    store?.setModelRemote?.(entry.name, { repo: cfg.repo, path: entry.path, revision: cfg.revision })
    pulled.push({ name: entry.name, bytes: buffer.length })
  }
  if (activate && pulled.length) activateModel(pulled[pulled.length - 1].name, { store })
  return { pulled, active: models.name }
}

/** What the owner dashboard shows: files, history, and the hub. */
export async function registryState({ store = null, cfg = hfConfig(), fetchImpl = fetch } = {}) {
  return {
    models: modelInventory({ store }),
    active: models.info(),
    runs: store?.recentTrainingRuns?.(10) ?? [],
    // Same fallback the trainer uses: the JSONL log still counts when the
    // table is empty, so the console never says "0 seams" beside a model that
    // was just trained from them.
    seams: seamCount({ store }),
    hf: await hubStatus(cfg, { fetchImpl }),
    dir: writableModelDir()
  }
}

/** Verify a pulled file before it is allowed near the host. */
export function inspectModel(name) {
  return readLocalModel(name)
}
