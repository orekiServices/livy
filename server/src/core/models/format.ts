/**
 * DJ model format — `.bin`.
 *
 * A trained model is a small, versioned binary: a magic number, a header, the
 * feature list, and the weights. It is deliberately not JSON and not ONNX:
 *
 *   • **Small.** A DJ policy is a few thousand floats. A JSON copy is 3–4× the
 *     size and has to be parsed into floats at boot; this is `mmap`-friendly
 *     and reads straight into a `Float32Array`.
 *   • **Self-describing.** The header carries the feature *names* and the
 *     normalisation they were trained with. A model and a feature vector that
 *     disagree about column order is the classic silent failure — the mix still
 *     renders, it is just bad — so the loader checks both names and count and
 *     refuses a mismatch rather than guessing.
 *   • **Versioned.** `version` is checked on read. A newer file loads on an
 *     older server only if the layout is unchanged; otherwise it is refused
 *     with a message that says which version it found.
 *
 * Layout (all little-endian):
 *
 *   0   4   magic "LVDJ"
 *   4   2   u16 version (1)
 *   6   2   u16 layer count
 *   8   4   u32 feature count
 *   12  4   u32 training steps
 *   16  8   f64 trained-at (ms since epoch)
 *   24  4   u32 feature-name byte length
 *   28   n   UTF-8 feature names, newline separated, in column order
 *        …   per layer: u32 in, u32 out, f32 in×out weights, f32 out biases
 *        …   u32 checksum (FNV-1a over everything before it)
 */
import { createHash } from 'node:crypto'

export const MAGIC = 'LVDJ'
export const VERSION = 1

/** FNV-1a over a buffer — cheap, and enough to catch a truncated file. */
export function checksum(buffer) {
  let hash = 0x811c9dc5
  for (let i = 0; i < buffer.length; i += 1) {
    hash ^= buffer[i]
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * Serialize a model to a `.bin` buffer.
 *
 * @param {object} model
 * @param {number[][]} model.weights   per layer, in×out, row-major
 * @param {number[][]} model.biases    per layer
 * @param {string[]} model.features    column names, in order
 * @param {number} [model.steps]       training steps taken
 * @param {number} [model.trainedAt]   epoch ms
 * @returns {Buffer}
 */
export function packModel(model) {
  const { weights, biases, features } = model
  if (!Array.isArray(weights) || !Array.isArray(biases) || weights.length !== biases.length) {
    throw new Error('packModel: weights and biases must be parallel arrays')
  }
  if (!Array.isArray(features) || features.length === 0) throw new Error('packModel: a model needs named features')
  if (weights.length === 0) throw new Error('packModel: a model needs at least one layer')

  const names = Buffer.from(features.join('\n'), 'utf8')
  const header = Buffer.alloc(28)
  header.write(MAGIC, 0, 'ascii')
  header.writeUInt16LE(VERSION, 4)
  header.writeUInt16LE(weights.length, 6)
  header.writeUInt32LE(features.length, 8)
  header.writeUInt32LE(Math.max(0, Math.floor(model.steps ?? 0)), 12)
  header.writeDoubleLE(model.trainedAt ?? Date.now(), 16)
  header.writeUInt32LE(names.length, 24)

  // The input width of a layer is the *previous* layer's output width — or the
  // feature count for the first one. Deriving it by division is the bug this
  // comment exists to prevent: `in × out / out` only works if the bias length
  // and the output width are the same number, and for the first layer that
  // number is the feature count, not the hidden width.
  const parts = [header, names]
  let width = features.length
  for (let layer = 0; layer < weights.length; layer += 1) {
    const output = biases[layer].length
    if (weights[layer].length !== width * output) {
      throw new Error(`packModel: layer ${layer} has ${weights[layer].length} weights, expected ${width} × ${output}`)
    }
    const shape = Buffer.alloc(8)
    shape.writeUInt32LE(width, 0)
    shape.writeUInt32LE(output, 4)
    parts.push(shape, asFloat32(weights[layer]), asFloat32(biases[layer]))
    width = output
  }

  const body = Buffer.concat(parts)
  const tail = Buffer.alloc(4)
  tail.writeUInt32LE(checksum(body), 0)
  return Buffer.concat([body, tail])
}

const asFloat32 = (values) => {
  const out = Buffer.alloc(values.length * 4)
  for (let i = 0; i < values.length; i += 1) out.writeFloatLE(values[i], i * 4)
  return out
}

/**
 * Read a `.bin` model back.
 *
 * Throws with a message that says *why*: a wrong magic, a version this build
 * does not understand, a truncated body, or a feature list that does not match
 * the layer it feeds. The caller (the model host) treats any throw as "no
 * model", which is what makes a corrupt file a warning rather than a station
 * that will not start.
 */
export function unpackModel(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer)
  if (buffer.length < 32) throw new Error('dj model: file is too short to be a model')
  if (buffer.toString('ascii', 0, 4) !== MAGIC) throw new Error('dj model: bad magic (not a Livy DJ model)')

  const version = buffer.readUInt16LE(4)
  if (version !== VERSION) throw new Error(`dj model: version ${version} is not supported (this build reads ${VERSION})`)

  const layers = buffer.readUInt16LE(6)
  const featureCount = buffer.readUInt32LE(8)
  const steps = buffer.readUInt32LE(12)
  const trainedAt = buffer.readDoubleLE(16)
  const nameBytes = buffer.readUInt32LE(24)

  const bodyCheck = buffer.subarray(0, buffer.length - 4)
  const expected = buffer.readUInt32LE(buffer.length - 4)
  const actual = checksum(bodyCheck)
  if (actual !== expected) throw new Error('dj model: checksum failed (the file is truncated or was edited)')

  let offset = 28
  if (offset + nameBytes > buffer.length - 4) throw new Error('dj model: feature list runs past the end of the file')
  const features = buffer.toString('utf8', offset, offset + nameBytes).split('\n').filter(Boolean)
  offset += nameBytes

  const weights = []
  const biases = []
  let input = featureCount
  for (let layer = 0; layer < layers; layer += 1) {
    if (offset + 8 > buffer.length - 4) throw new Error(`dj model: layer ${layer} header runs past the end of the file`)
    const rows = buffer.readUInt32LE(offset)
    const columns = buffer.readUInt32LE(offset + 4)
    offset += 8
    if (rows !== input) {
      throw new Error(`dj model: layer ${layer} expects ${input} inputs but the model declares ${rows}`)
    }
    const weightBytes = rows * columns * 4
    const biasBytes = columns * 4
    if (offset + weightBytes + biasBytes > buffer.length - 4) throw new Error(`dj model: layer ${layer} is truncated`)
    const w = new Array(weightBytes / 4)
    for (let i = 0; i < w.length; i += 1) w[i] = buffer.readFloatLE(offset + i * 4)
    offset += weightBytes
    const b = new Array(biasBytes / 4)
    for (let i = 0; i < b.length; i += 1) b[i] = buffer.readFloatLE(offset + i * 4)
    offset += biasBytes
    weights.push(w)
    biases.push(b)
    input = columns
  }

  return { weights, biases, features, steps, trainedAt, version, layers, featureCount, digest: digestOf(buffer) }
}

/** A short content hash, used to name a checkpoint and to dedupe. */
export const digestOf = (buffer) => createHash('sha1').update(buffer).digest('hex').slice(0, 12)
