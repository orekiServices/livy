/**
 * Compatibility entry point. The trainer now lives in `trainer/`.
 */
export * from './trainer/index.ts'
export { trainModels as default } from './trainer/index.ts'
