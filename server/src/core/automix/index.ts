/**
 * Public automix surface. Implementation is split by job: defaults, audio,
 * the ten renderers, transition choice, joint tempo analysis, the DJ voice,
 * and the engine.
 */
export { AUTO_EFFECT, BUILT_IN_EFFECTS, DEFAULT_AUTOMIX, EFFECTS } from './defaults.ts'
export { decodeMp3, encodeMp3, resample } from './audio.ts'
export { registerEffect, unregisterEffect } from './renderers.ts'
export { EFFECT_TRAITS, chooseEffect, chooseEffectWithModel, rankEffects, smartCrossfadeMs, smoothEdges } from './effects.ts'
export { MAX_NUDGE, MIN_SHOWS, effectNudge, effectOutcomes, outcomeReport } from './outcomes.ts'
export { Automix } from './engine.ts'
export {
  BEAT_FEATURE_DIM,
  analyzeTrackStructure,
  clearStructureCache,
  detectKey,
  extractRhythmPattern,
  fingerprintPcm,
  harmonicCompatibility,
  rhythmSimilarity,
  structureCacheStats
} from './structure.ts'
export type {
  AnalyzeStructureOptions,
  CueCandidate,
  HarmonicMatch,
  MusicalKey,
  MusicalMode,
  PhraseBoundary,
  SectionType,
  SongSection,
  TrackStructure
} from './structure.ts'
export {
  DEFAULT_KNOTS,
  ThreeBandCrossover,
  buildAutomationPlan,
  renderContinuousBlend,
  sampleCurve,
  sanitizeAutomationPlan
} from './blender.ts'
export type {
  AutomationCurves,
  AutomationPlan,
  BlendRenderContext,
  StemSet,
  StereoAudio
} from './blender.ts'
export { evaluateTransition } from './evaluator.ts'
export type {
  CandidateTransitionInput,
  TransitionEvaluation,
  TransitionMetrics
} from './evaluator.ts'
export {
  clearPlanCache,
  planCacheStats,
  planTransition,
  planTransitionFromAudio
} from './planner.ts'
export type { CandidatePlan, PlanTransitionOptions, TransitionPlanResult } from './planner.ts'
export { default } from './engine.ts'
