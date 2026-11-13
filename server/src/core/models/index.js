/**
 * DJ models — the public surface.
 *
 * The implementation is split by job: `storage/` (disk and Hugging Face),
 * `trainer/` (dataset, CPU/GPU training, multi-train), `registry.js` (which
 * candidate is on air) and `auto.js` (training while the station plays).
 * Everything a station needs is re-exported here.
 */
export { ModelHost, models } from './host.js'
export {
  MANIFEST,
  activateLocal,
  listModels,
  modelDirs,
  readLocalModel,
  removeLocalModel,
  resolveModel,
  saveModel,
  writableModelDir
} from './storage/local.js'
export { downloadFile, ensureRepo, hfConfig, hfReady, hubStatus, listRemote, uploadFile } from './storage/hf.js'
export { activateModel, forgetModel, modelInventory, pullModels, pushModels, recordModel, registryState } from './registry.js'
export { DEFAULT_MODEL_SETTINGS, configureModels, modelSettings, updateModelSettings } from './settings.js'
export { AutoTrainer } from './auto.js'
export {
  DEFAULT_SHAPE,
  FAST_SHAPE,
  buildDataset,
  gpuAvailable,
  readSeams,
  recordSeam,
  seamCount,
  trainInBackground,
  trainModel,
  trainModels
} from './trainer/index.js'
export { ACTIONS, FEATURES, featuresFor } from './features.js'
export { Network } from './network.js'
export { packModel, unpackModel } from './format.js'

export { models as default } from './host.js'
