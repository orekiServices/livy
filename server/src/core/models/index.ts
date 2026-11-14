/**
 * DJ models — the public surface.
 *
 * The implementation is split by job: `storage/` (disk and Hugging Face),
 * `trainer/` (dataset, CPU/GPU training, multi-train), `registry.js` (which
 * candidate is on air) and `auto.js` (training while the station plays).
 * Everything a station needs is re-exported here.
 */
export { ModelHost, models } from './host.ts'
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
} from './storage/local.ts'
export { downloadFile, ensureRepo, hfConfig, hfReady, hubStatus, listRemote, uploadFile } from './storage/hf.ts'
export { activateModel, forgetModel, modelInventory, pullModels, pushModels, recordModel, registryState } from './registry.ts'
export { DEFAULT_MODEL_SETTINGS, configureModels, modelSettings, updateModelSettings } from './settings.ts'
export { MODEL_PRESETS, MODEL_PRESET_IDS, isModelPreset, modelPresets } from './presets.ts'
export { AutoTrainer } from './auto.ts'
export {
  DEFAULT_SHAPE,
  FAST_SHAPE,
  buildDataset,
  gpuAvailable,
  readSeams,
  recordSeam,
  seamCount,
  trainBackend,
  trainInBackground,
  trainModel,
  trainModels,
  torchStatus
} from './trainer/index.ts'
export { ACTIONS, FEATURES, featuresFor } from './features.ts'
export { Network } from './network.ts'
export { packModel, unpackModel } from './format.ts'

export {
  AUTOMIX_STRATEGIES,
  CURVE_CHANNELS,
  NEURAL_AUTOMIX_PRESETS,
  NeuralAutoMixModel,
  PAIR_FEATURE_DIM,
  SEQ_FEATURE_DIM,
  STAGE1_DIM,
  estimateParameters,
  listNeuralPresets,
  normalizeSequence
} from './architectures.ts'
export type {
  ArchitectureKind,
  ArchitecturePreset,
  AutoMixStrategy,
  NeuralAutoMixConfig,
  NeuralInput,
  NeuralPrediction,
  NeuralTarget,
  ParamTensor,
  StepMetrics
} from './architectures.ts'
export {
  LVMX_MAGIC,
  LVMX_VERSION,
  loadNeuralCheckpoint,
  packNeuralCheckpoint,
  unpackNeuralCheckpoint
} from './neuralFormat.ts'
export type {
  CheckpointMetadata,
  FeatureNormalization,
  UnpackedCheckpoint
} from './neuralFormat.ts'
export {
  NeuralAutoMixHost,
  applyNormalization,
  decodeNeuralPrediction,
  encodeAutomationTarget,
  extractPairFeatures,
  extractTrackSequences,
  neuralAutomix
} from './neuralAutomix.ts'
export type { DecodedNeuralPlan } from './neuralAutomix.ts'
export {
  alignTrackInMix,
  extractDatasetFromManifest,
  extractDjSupervision,
  loadAudioFile,
  readTransitionDataset,
  toTrainingSample,
  validateDatasetProvenance,
  writeTransitionDataset
} from './djDataset.ts'
export type {
  AudioBufferLike,
  DjMixManifest,
  DjMixTrackEntry,
  ExtractedTransitionExample,
  TrackAlignment
} from './djDataset.ts'
export {
  evaluateNeuralModel,
  fitNormalization,
  groupSplitByMix,
  runDjTrainingPipeline
} from './djPipeline.ts'
export type {
  EpochLog,
  EvaluationReport,
  PipelineOptions,
  PipelineResult,
  SplitDataset
} from './djPipeline.ts'
export { benchmarkArchitectures, measureInferenceLatency } from './benchmark.ts'
export type { ArchitectureBenchmarkEntry, BenchmarkReport } from './benchmark.ts'

export { models as default } from './host.ts'
