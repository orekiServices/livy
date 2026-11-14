/**
 * Versioned binary checkpoint format (`.lvmx`) for Multi-Stage Neural AutoMix
 * models.
 *
 * Layout (little-endian):
 *   0   4   magic "LVMX"
 *   4   2   u16 version (2)
 *   6   2   u16 tensor count
 *   8   4   u32 JSON header byte length
 *   12  n   UTF-8 JSON header: { config, normalization, provenance, metrics, trainedAt, steps }
 *       …   per tensor:
 *             u16 nameLen, UTF-8 name,
 *             u8 rank, u32[rank] shape,
 *             u32 numElements, f32[numElements] data
 *       …   u32 FNV-1a checksum over all preceding bytes
 */
import { createHash } from 'node:crypto'
import { checksum } from './format.ts'
import { NeuralAutoMixModel, type NeuralAutoMixConfig } from './architectures.ts'

export const LVMX_MAGIC = 'LVMX'
export const LVMX_VERSION = 2

export interface FeatureNormalization {
  mean: number[]
  std: number[]
}

export interface CheckpointMetadata {
  config: NeuralAutoMixConfig
  normalization?: FeatureNormalization | null
  provenance?: {
    dataset?: string
    mixCount?: number
    transitionCount?: number
    realDjDataOnly?: boolean
    license?: string
  } | null
  metrics?: Record<string, number | string> | null
  steps?: number
  trainedAt?: number
}

export interface UnpackedCheckpoint {
  version: number
  metadata: CheckpointMetadata
  weights: Record<string, { shape: number[]; data: Float32Array }>
  parameterCount: number
  digest: string
}

/** Serialize a NeuralAutoMixModel and its training metadata into a `.lvmx` Buffer. */
export function packNeuralCheckpoint(model: NeuralAutoMixModel, meta: Partial<CheckpointMetadata> = {}): Buffer {
  const headerObj: CheckpointMetadata = {
    config: model.config,
    normalization: meta.normalization ?? null,
    provenance: meta.provenance ?? null,
    metrics: meta.metrics ?? null,
    steps: Math.max(0, Math.floor(meta.steps ?? 0)),
    trainedAt: meta.trainedAt ?? Date.now()
  }
  const headerJson = Buffer.from(JSON.stringify(headerObj), 'utf8')
  const weights = model.exportWeights()
  const entries = Object.entries(weights)

  const prefix = Buffer.alloc(12)
  prefix.write(LVMX_MAGIC, 0, 'ascii')
  prefix.writeUInt16LE(LVMX_VERSION, 4)
  prefix.writeUInt16LE(entries.length, 6)
  prefix.writeUInt32LE(headerJson.length, 8)

  const parts: Buffer[] = [prefix, headerJson]
  for (const [name, tensor] of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const rank = tensor.shape.length
    const metaBuf = Buffer.alloc(2 + nameBuf.length + 1 + rank * 4 + 4)
    let off = 0
    metaBuf.writeUInt16LE(nameBuf.length, off)
    off += 2
    nameBuf.copy(metaBuf, off)
    off += nameBuf.length
    metaBuf.writeUInt8(rank, off)
    off += 1
    for (let r = 0; r < rank; r += 1) {
      metaBuf.writeUInt32LE(tensor.shape[r], off)
      off += 4
    }
    metaBuf.writeUInt32LE(tensor.data.length, off)

    const dataBuf = Buffer.allocUnsafe(tensor.data.length * 4)
    for (let i = 0; i < tensor.data.length; i += 1) dataBuf.writeFloatLE(tensor.data[i], i * 4)
    parts.push(metaBuf, dataBuf)
  }

  const body = Buffer.concat(parts)
  const tail = Buffer.alloc(4)
  tail.writeUInt32LE(checksum(body), 0)
  return Buffer.concat([body, tail])
}

/** Deserialize and verify a `.lvmx` checkpoint buffer. */
export function unpackNeuralCheckpoint(input: Buffer | Uint8Array): UnpackedCheckpoint {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (buffer.length < 16) throw new Error('neural automix checkpoint: file too short')
  if (buffer.toString('ascii', 0, 4) !== LVMX_MAGIC) {
    throw new Error('neural automix checkpoint: bad magic (expected LVMX)')
  }
  const version = buffer.readUInt16LE(4)
  if (version !== LVMX_VERSION) {
    throw new Error(`neural automix checkpoint: unsupported version ${version} (expected ${LVMX_VERSION})`)
  }
  const tensorCount = buffer.readUInt16LE(6)
  const headerBytes = buffer.readUInt32LE(8)

  const expectedChecksum = buffer.readUInt32LE(buffer.length - 4)
  const actualChecksum = checksum(buffer.subarray(0, buffer.length - 4))
  if (actualChecksum !== expectedChecksum) {
    throw new Error('neural automix checkpoint: checksum mismatch (corrupted or truncated)')
  }

  let off = 12
  if (off + headerBytes > buffer.length - 4) throw new Error('neural automix checkpoint: truncated metadata header')
  const metadata = JSON.parse(buffer.toString('utf8', off, off + headerBytes)) as CheckpointMetadata
  off += headerBytes

  const weights: Record<string, { shape: number[]; data: Float32Array }> = {}
  let parameterCount = 0
  const limit = buffer.length - 4

  for (let t = 0; t < tensorCount; t += 1) {
    if (off + 2 > limit) throw new Error(`neural automix checkpoint: truncated tensor #${t}`)
    const nameLen = buffer.readUInt16LE(off)
    off += 2
    if (off + nameLen + 1 > limit) throw new Error(`neural automix checkpoint: truncated name at tensor #${t}`)
    const name = buffer.toString('utf8', off, off + nameLen)
    off += nameLen
    const rank = buffer.readUInt8(off)
    off += 1
    if (off + rank * 4 + 4 > limit) throw new Error(`neural automix checkpoint: truncated shape at tensor "${name}"`)
    const shape: number[] = []
    for (let r = 0; r < rank; r += 1) {
      shape.push(buffer.readUInt32LE(off))
      off += 4
    }
    const count = buffer.readUInt32LE(off)
    off += 4
    if (off + count * 4 > limit) throw new Error(`neural automix checkpoint: truncated data at tensor "${name}"`)
    const data = new Float32Array(count)
    for (let i = 0; i < count; i += 1) data[i] = buffer.readFloatLE(off + i * 4)
    off += count * 4
    weights[name] = { shape, data }
    parameterCount += count
  }

  const digest = createHash('sha1').update(buffer).digest('hex').slice(0, 12)
  return { version, metadata, weights, parameterCount, digest }
}

/** Instantiate a ready-to-run NeuralAutoMixModel from a `.lvmx` checkpoint buffer. */
export function loadNeuralCheckpoint(buffer: Buffer | Uint8Array): {
  model: NeuralAutoMixModel
  checkpoint: UnpackedCheckpoint
} {
  const checkpoint = unpackNeuralCheckpoint(buffer)
  const model = new NeuralAutoMixModel(checkpoint.metadata.config)
  model.loadWeights(checkpoint.weights)
  return { model, checkpoint }
}
