/**
 * Owner control plane. Implementation is split across `owner/` by job:
 * stations, models, plugins and node-wide tools.
 */
export { ANNOUNCEMENT_PRESETS, createOwnerRouter, isOwner, ownerKey } from './owner/index.js'
export { default } from './owner/index.js'
