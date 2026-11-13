/* libmetro — MetroS. Hand-written to match src/lib.rs. */

export interface FrameInfo {
  offset: number
  length: number
  bitrate: number
  sampleRate: number
  channels: number
  samples: number
  /** 10 = MPEG 1, 20 = MPEG 2, 25 = MPEG 2.5 (tenths, so it stays an integer). */
  version: number
  layer: number
  durationMs: number
}

export interface StreamInfo {
  frames: number
  bytes: number
  durationMs: number
  bitrate: number
  sampleRate: number
  channels: number
  vbr: boolean
}

export interface DecodedAudio {
  left: Float32Array
  right: Float32Array
  sampleRate: number
  channels: number
  length: number
}

export interface PushResult {
  data: Buffer
  lengths: Uint32Array | null
  frames: number
  durationMs: number
  pending: number
  dropped: number
  info: FrameInfo | null
}

export interface FillResult {
  frames: number
  bytes: number
  durationMs: number
  pending: number
  dropped: number
  overflow: boolean
  /** Sent on the first frames and whenever the stream's format changes. */
  format: FrameInfo | null
}

export declare function version(): string
export declare function describe(): string
export declare function scanFrames(data: Buffer, skipVbrHeader?: boolean): FrameInfo[]
export declare function probe(data: Buffer): StreamInfo
export declare function decode(data: Buffer): DecodedAudio
export declare function decodeAsync(data: Buffer): Promise<DecodedAudio>

export declare class Framer {
  constructor(options?: { skipVbrHeader?: boolean; lengths?: boolean })
  push(chunk: Buffer): PushResult
  /** Allocation-free: writes whole frames into a buffer you own. */
  pushInto(chunk: Buffer, out: Buffer, lengths?: Uint32Array): FillResult
  readonly pending: number
  readonly dropped: number
  stats(): StreamInfo
  reset(): void
}

/** False when no binary exists for this platform — callers should fall back. */
export declare const available: boolean
export declare const triedNames: string[]

/* ---- transcoding ------------------------------------------------------ */

export interface TranscodeStats {
  /** 'mp3' | 'aac' | 'mpeg-ts' | 'ogg' | 'flac' | 'wav' | 'mp4' | 'matroska' */
  kind: string
  /** Bytes buffered and not yet turned into MP3. */
  pending: number
  bytesIn: number
  bytesOut: number
  framesIn: number
  durationMs: number
  sampleRate: number
  channels: number
  /** Output bitrate in kbps, or 0 when the input is forwarded untouched. */
  bitrate: number
  passthrough: boolean
}

/** What is this audio? Answered without decoding a frame. */
export declare function sniff(data: Buffer): string
/** Any supported codec → f32 channels. */
export declare function decodeAudio(data: Buffer): DecodedAudio
/** f32 channels → MP3 (shine). */
export declare function encodeMp3(left: Float32Array, right: Float32Array, sampleRate: number, bitrate?: number): Buffer
/** A whole file or HLS segment → MP3. */
export declare function transcode(data: Buffer, bitrate?: number): Buffer
export declare function transcodeAsync(data: Buffer, bitrate?: number): Promise<Buffer>

/** Streaming transcoder for live relays. MP3 input is passed through. */
export declare class Transcoder {
  constructor(bitrate?: number)
  push(chunk: Buffer): Buffer
  flush(): Buffer
  readonly kind: string
  readonly passthrough: boolean
  stats(): TranscodeStats
}
