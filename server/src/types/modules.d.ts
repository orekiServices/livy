declare module '@breezystack/lamejs' {
  export class Mp3Encoder {
    constructor(channels: number, samplerate: number, kbps: number)
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array | Uint8Array
    flush(): Int8Array | Uint8Array
  }
  const lamejs: { Mp3Encoder: typeof Mp3Encoder }
  export default lamejs
}

declare module 'mpg123-decoder' {
  export interface DecodedAudio {
    channelData: Float32Array[]
    samplesDecoded: number
    sampleRate: number
    errors?: Array<{ message: string; frameLength: number; frameNumber: number; inputOffset: number; outputOffset: number }>
  }
  export class MPEGDecoder {
    ready: Promise<void>
    decode(data: Uint8Array): DecodedAudio
    decodeFrame(data: Uint8Array): DecodedAudio
    decodeFrames(frames: Uint8Array[]): DecodedAudio
    reset(): Promise<void>
    free(): void
  }
}

declare module 'libmetro' {
  export * from '../../../native/libmetro/index.d.ts'
}

declare module 'metrodb' {
  export * from '../../../native/metrodb/index.d.ts'
}

declare module 'metrofx' {
  export * from '../../../native/metrofx/index.d.ts'
}

declare module 'bun:sqlite' {
  export class Statement {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
  export class Database {
    constructor(filename?: string, options?: Record<string, unknown>)
    exec(sql: string): void
    run(sql: string, ...params: unknown[]): unknown
    query(sql: string): Statement
    prepare(sql: string): Statement
    transaction<T extends (...args: unknown[]) => unknown>(fn: T): T
    close(): void
  }
}

declare const GPUBufferUsage: any
declare const GPUMapMode: any
interface Navigator {
  gpu?: any
}
