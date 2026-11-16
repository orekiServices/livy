/**
 * Safetensors read/write support for Livy's compact DJ networks.
 *
 * The container follows the public Safetensors layout: an eight-byte little-
 * endian header length, a padded JSON header, then contiguous little-endian
 * tensor bytes. Network layout and feature names live in string metadata so
 * Python tooling can inspect weights without importing Livy.
 */

const MAX_HEADER_BYTES = 100 * 1024 * 1024
const MODEL_FORMAT = 'livy-dj-network'
const MODEL_VERSION = '1'

type TensorSpec = {
  dtype: 'F32'
  shape: number[]
  data: ArrayLike<number>
}

function elementCount(shape: number[], name: string) {
  if (!Array.isArray(shape) || shape.some((size) => !Number.isSafeInteger(size) || size < 0)) {
    throw new Error(`safetensors: ${name} has an invalid shape`)
  }
  return shape.reduce((count, size) => count * size, 1)
}

function float32Bytes(values: ArrayLike<number>, name: string) {
  const bytes = Buffer.alloc(values.length * 4)
  for (let i = 0; i < values.length; i += 1) {
    const value = Number(values[i])
    if (!Number.isFinite(value)) throw new Error(`safetensors: ${name}[${i}] is not finite`)
    bytes.writeFloatLE(value, i * 4)
  }
  return bytes
}

/** Pack named F32 tensors into a standard Safetensors buffer. */
export function packSafetensors(tensors: Record<string, TensorSpec>, metadata: Record<string, string> = {}): Buffer {
  if (!tensors || typeof tensors !== 'object' || Array.isArray(tensors) || Object.keys(tensors).length === 0) {
    throw new Error('safetensors: at least one named tensor is required')
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (key === '__metadata__' || typeof value !== 'string') throw new Error(`safetensors: metadata ${key} must be a string`)
  }

  const header: Record<string, any> = {}
  if (Object.keys(metadata).length) header.__metadata__ = metadata
  const payloads: Buffer[] = []
  let offset = 0

  for (const [name, tensor] of Object.entries(tensors)) {
    if (!name || name === '__metadata__' || name.trim() !== name) throw new Error(`safetensors: invalid tensor name ${JSON.stringify(name)}`)
    if (!tensor || tensor.dtype !== 'F32') throw new Error(`safetensors: ${name} must use F32`)
    const count = elementCount(tensor.shape, name)
    if (tensor.data == null || tensor.data.length !== count) {
      throw new Error(`safetensors: ${name} has ${tensor.data?.length ?? 0} values, expected ${count}`)
    }
    const data = float32Bytes(tensor.data, name)
    header[name] = { dtype: tensor.dtype, shape: tensor.shape, data_offsets: [offset, offset + data.length] }
    payloads.push(data)
    offset += data.length
  }

  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const paddedLength = Math.ceil(json.length / 8) * 8
  if (paddedLength > MAX_HEADER_BYTES) throw new Error('safetensors: header is too large')
  const paddedHeader = Buffer.alloc(paddedLength, 0x20)
  json.copy(paddedHeader)
  const prefix = Buffer.alloc(8)
  prefix.writeBigUInt64LE(BigInt(paddedLength), 0)
  return Buffer.concat([prefix, paddedHeader, ...payloads])
}

/** Parse a Safetensors buffer, validating metadata, shapes and data offsets. */
export function unpackSafetensors(input: Buffer | Uint8Array) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (buffer.length < 10) throw new Error('safetensors: file is too short')
  const headerLengthBig = buffer.readBigUInt64LE(0)
  if (headerLengthBig > BigInt(MAX_HEADER_BYTES) || headerLengthBig > BigInt(buffer.length - 8)) {
    throw new Error('safetensors: header length is invalid')
  }
  const headerLength = Number(headerLengthBig)
  if (headerLength === 0) throw new Error('safetensors: header is empty')

  let header: Record<string, any>
  try {
    header = JSON.parse(buffer.toString('utf8', 8, 8 + headerLength).trimEnd())
  } catch {
    throw new Error('safetensors: header is not valid JSON')
  }
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('safetensors: header must be an object')

  const metadata = header.__metadata__ ?? {}
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.values(metadata).some((value) => typeof value !== 'string')) {
    throw new Error('safetensors: metadata must map strings to strings')
  }

  const dataStart = 8 + headerLength
  const dataLength = buffer.length - dataStart
  const entries: Array<{ name: string; start: number; end: number; shape: number[] }> = []
  const tensors: Record<string, { dtype: 'F32'; shape: number[]; data: Float32Array }> = {}

  for (const [name, spec] of Object.entries(header)) {
    if (name === '__metadata__') continue
    if (!name || !spec || typeof spec !== 'object' || spec.dtype !== 'F32') {
      throw new Error(`safetensors: ${name} has an unsupported tensor descriptor`)
    }
    const shape = spec.shape
    const count = elementCount(shape, name)
    const offsets = spec.data_offsets
    if (!Array.isArray(offsets) || offsets.length !== 2 || offsets.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`safetensors: ${name} has invalid data offsets`)
    }
    const [start, end] = offsets
    if (end < start || end - start !== count * 4 || end > dataLength) {
      throw new Error(`safetensors: ${name} data size does not match its shape`)
    }
    entries.push({ name, start, end, shape: [...shape] })
  }

  entries.sort((a, b) => a.start - b.start || a.end - b.end)
  let cursor = 0
  for (const entry of entries) {
    if (entry.start !== cursor) throw new Error('safetensors: tensor data offsets overlap or contain gaps')
    const values = new Float32Array((entry.end - entry.start) / 4)
    for (let i = 0; i < values.length; i += 1) values[i] = buffer.readFloatLE(dataStart + entry.start + i * 4)
    tensors[entry.name] = { dtype: 'F32', shape: entry.shape, data: values }
    cursor = entry.end
  }
  if (cursor !== dataLength) throw new Error('safetensors: unclaimed bytes at the end of the tensor data')
  if (entries.length === 0) throw new Error('safetensors: no tensors found')

  return { tensors, metadata: { ...metadata } as Record<string, string> }
}

/** Serialize the network model structure used by the trainer. */
export function packNetworkSafetensors(model: {
  weights: ArrayLike<ArrayLike<number>>
  biases: ArrayLike<ArrayLike<number>>
  features: string[]
  steps?: number
  trainedAt?: number
  metadata?: Record<string, string>
}): Buffer {
  if (!Array.isArray(model.features) || model.features.length === 0) throw new Error('safetensors model: feature names are required')
  if (!model.weights || !model.biases || model.weights.length === 0 || model.weights.length !== model.biases.length) {
    throw new Error('safetensors model: weights and biases must be non-empty parallel arrays')
  }

  const tensors: Record<string, TensorSpec> = {}
  let inputWidth = model.features.length
  for (let layer = 0; layer < model.weights.length; layer += 1) {
    const weights = model.weights[layer]
    const biases = model.biases[layer]
    const outputWidth = biases?.length ?? 0
    if (!outputWidth || weights.length !== inputWidth * outputWidth) {
      throw new Error(`safetensors model: layer ${layer} dimensions do not connect`)
    }
    tensors[`weights.${layer}`] = { dtype: 'F32', shape: [inputWidth, outputWidth], data: weights }
    tensors[`biases.${layer}`] = { dtype: 'F32', shape: [outputWidth], data: biases }
    inputWidth = outputWidth
  }

  const metadata: Record<string, string> = {
    ...(model.metadata ?? {}),
    format: MODEL_FORMAT,
    version: MODEL_VERSION,
    features: JSON.stringify(model.features),
    layers: String(model.weights.length),
    steps: String(Math.max(0, Math.floor(Number(model.steps) || 0))),
    trainedAt: String(Number(model.trainedAt) || Date.now())
  }
  return packSafetensors(tensors, metadata)
}

/** Reconstruct a Livy network model and check that all tensor dimensions agree. */
export function unpackNetworkSafetensors(input: Buffer | Uint8Array) {
  const { tensors, metadata } = unpackSafetensors(input)
  if (metadata.format !== MODEL_FORMAT || metadata.version !== MODEL_VERSION) {
    throw new Error('safetensors model: unsupported Livy model format or version')
  }

  let features: unknown
  try {
    features = JSON.parse(metadata.features ?? '')
  } catch {
    throw new Error('safetensors model: feature metadata is invalid')
  }
  if (!Array.isArray(features) || features.length === 0 || features.some((feature) => typeof feature !== 'string')) {
    throw new Error('safetensors model: feature metadata must be a non-empty string array')
  }

  const layerCount = Number(metadata.layers)
  if (!Number.isSafeInteger(layerCount) || layerCount < 1) throw new Error('safetensors model: layer count is invalid')
  const weights: number[][] = []
  const biases: number[][] = []
  let inputWidth = features.length
  const expectedNames = new Set<string>()
  for (let layer = 0; layer < layerCount; layer += 1) {
    const weightName = `weights.${layer}`
    const biasName = `biases.${layer}`
    expectedNames.add(weightName)
    expectedNames.add(biasName)
    const weight = tensors[weightName]
    const bias = tensors[biasName]
    if (!weight || !bias || weight.shape.length !== 2 || bias.shape.length !== 1) {
      throw new Error(`safetensors model: layer ${layer} tensors are missing or malformed`)
    }
    const [rows, columns] = weight.shape
    if (rows !== inputWidth || columns !== bias.shape[0]) {
      throw new Error(`safetensors model: layer ${layer} dimensions do not connect`)
    }
    weights.push(Array.from(weight.data))
    biases.push(Array.from(bias.data))
    inputWidth = columns
  }
  if (Object.keys(tensors).some((name) => !expectedNames.has(name))) {
    throw new Error('safetensors model: unexpected tensors are present')
  }

  const steps = Number(metadata.steps) || 0
  const trainedAt = Number(metadata.trainedAt) || 0
  return {
    weights,
    biases,
    features: [...features] as string[],
    steps,
    trainedAt,
    layers: layerCount,
    featureCount: (features as string[]).length,
    version: Number(MODEL_VERSION),
    metadata
  }
}
