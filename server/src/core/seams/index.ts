/**
 * Seams: where a song can be left, entered, or folded back on itself.
 *
 *   features.ts    what the audio is doing, frame by frame, as it streams
 *   beats.ts       where the beats are, and what each one sounds like
 *   detectors.ts   six opinions about where a seam belongs, and their fusion
 *   categories.ts  what kind of beat each one is
 *   jukebox.ts     which beats sound like which (the Infinite Jukebox graph)
 *   fj.ts          the same graph on a Forever Jukebox analysis, and its client
 *   forever.ts     playing that graph as MP3 frames, without end
 *   scout.ts       all of the above, kept up to date behind a live stream
 */
export { FeatureStream, FRAME, HOP } from './features.ts'
export { trackBeats, estimatePeriod, placeBeats, VECTOR } from './beats.ts'
export type { Beat, BeatTrack } from './beats.ts'
export { DETECTORS, DETECTOR_WEIGHTS, detectAll, fuse } from './detectors.ts'
export type { SeamCandidate, DetectorName } from './detectors.ts'
export { CATEGORIES, DESCRIPTOR, PROTOTYPES, describeBeats, fitCentroids, nearest, sortBeats } from './categories.ts'
export type { Category } from './categories.ts'
export { buildGraph, beatDistance, nearestNeighbours, useNativeKernel, JukeboxWalker } from './jukebox.ts'
export type { JukeboxGraph, Edge } from './jukebox.ts'
export { ForeverJukebox } from './forever.ts'
export type { Jump, Segment } from './forever.ts'
export { FjClient, DEFAULT_FJ_API, normaliseFjAnalysis, graphFromFjAnalysis, beatTrackFromFj, beatPairDistance, matchPercent, fjClient } from './fj.ts'
export type { FjAnalysis, FjQuantum, FjSegment, FjClientInfo } from './fj.ts'
export { SeamScout } from './scout.ts'
export type { Analysis, ScoutOptions } from './scout.ts'
