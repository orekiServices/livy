export class Biquad {
  constructor(b0: number, b1: number, b2: number, a1: number, a2: number)
  setCoefficients(b0: number, b1: number, b2: number, a1: number, a2: number): void
  process(left: Float32Array, right: Float32Array, length: number): void
  reset(): void
}

export class Compressor {
  constructor(sampleRate: number, thresholdDb: number, ratio: number, attackSec: number, releaseSec: number, gain: number, makeupGain: number)
  configure(thresholdDb: number, ratio: number, attackSec: number, releaseSec: number, gain: number, makeupGain: number): void
  process(left: Float32Array, right: Float32Array, length: number): void
  reset(): void
}

export class Reverb {
  constructor(sampleRate: number, roomSize: number, damping: number, wet: number, dry: number, width: number, mix: number)
  configure(roomSize: number, damping: number, wet: number, dry: number, width: number, mix: number): void
  process(left: Float32Array, right: Float32Array, length: number): void
  reset(): void
}

export class Distortion {
  constructor(scale: number, offset: number)
  configure(scale: number, offset: number): void
  process(left: Float32Array, right: Float32Array, length: number): void
  reset(): void
}

export const available: boolean
export function version(): string
export function describe(): Record<string, unknown>
export const triedNames: string[]
export const loadErrors: string[]
