/**
 * Public automix surface. Implementation is split by job: defaults, audio,
 * the ten renderers, transition choice, joint tempo analysis, the DJ voice,
 * and the engine.
 */
export { AUTO_EFFECT, BUILT_IN_EFFECTS, DEFAULT_AUTOMIX, EFFECTS } from './defaults.js'
export { decodeMp3, encodeMp3, resample } from './audio.js'
export { registerEffect, unregisterEffect } from './renderers.js'
export { EFFECT_TRAITS, chooseEffect, chooseEffectWithModel, smartCrossfadeMs, smoothEdges } from './effects.js'
export { Automix } from './engine.js'
export { default } from './engine.js'
