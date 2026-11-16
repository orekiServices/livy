import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { packModel } from '../src/core/models/format.ts'
import { Network } from '../src/core/models/network.ts'
import { packNetworkSafetensors, packSafetensors, unpackNetworkSafetensors, unpackSafetensors } from '../src/core/models/safetensors.ts'
import { activateLocal, saveModel } from '../src/core/models/storage/local.ts'
import { tmpdir } from './helpers.ts'

test('Safetensors output follows the standard header and round-trips F32 tensors', () => {
  const buffer = packSafetensors(
    {
      'weights.0': { dtype: 'F32', shape: [2, 2], data: [1, -2, 3.25, 4] },
      'biases.0': { dtype: 'F32', shape: [2], data: [0.5, -0.25] }
    },
    { purpose: 'unit-test' }
  )

  const headerLength = Number(buffer.readBigUInt64LE(0))
  assert.equal(headerLength % 8, 0, 'the JSON header is padded to eight bytes')
  const header = JSON.parse(buffer.toString('utf8', 8, 8 + headerLength).trimEnd())
  assert.deepEqual(header.__metadata__, { purpose: 'unit-test' })
  assert.deepEqual(header['weights.0'], { dtype: 'F32', shape: [2, 2], data_offsets: [0, 16] })

  const decoded = unpackSafetensors(buffer)
  assert.deepEqual(Array.from(decoded.tensors['weights.0'].data), [1, -2, 3.25, 4])
  assert.deepEqual(Array.from(decoded.tensors['biases.0'].data), [0.5, -0.25])
  assert.deepEqual(decoded.metadata, { purpose: 'unit-test' })
})

test('Livy network Safetensors preserve shape, features, training metadata and weights', () => {
  const network = new Network([3, 4, 2], { seed: 1 })
  const buffer = packNetworkSafetensors({
    ...network.parameters(),
    features: ['tempo', 'energy', 'requested'],
    steps: 123,
    trainedAt: 1_700_000_000_000,
    metadata: { task: 'next-track-ranking' }
  })
  const decoded = unpackNetworkSafetensors(buffer)
  const restored = new Network([3, 4, 2]).load(decoded)

  assert.deepEqual(decoded.features, ['tempo', 'energy', 'requested'])
  assert.equal(decoded.steps, 123)
  assert.equal(decoded.trainedAt, 1_700_000_000_000)
  assert.equal(decoded.metadata.task, 'next-track-ranking')
  assert.deepEqual(restored.shape, [3, 4, 2])
  for (let layer = 0; layer < network.weights.length; layer += 1) {
    for (let i = 0; i < network.weights[layer].length; i += 1) {
      assert.ok(Math.abs(restored.weights[layer][i] - network.weights[layer][i]) < 1e-6)
    }
    for (let i = 0; i < network.biases[layer].length; i += 1) {
      assert.ok(Math.abs(restored.biases[layer][i] - network.biases[layer][i]) < 1e-6)
    }
  }
})

test('new model saves use Safetensors and explicit legacy .bin activation converts atomically', () => {
  const dir = tmpdir('livy-safetensors-')
  const network = new Network([2, 3, 2], { seed: 7 })
  const saved = saveModel(network, { features: ['tempo', 'vocal'], steps: 9, activate: false, dir })
  assert.equal(path.extname(saved.file), '.safetensors')
  assert.equal(saved.name.endsWith('.safetensors'), true)
  assert.deepEqual(unpackNetworkSafetensors(fs.readFileSync(saved.file)).features, ['tempo', 'vocal'])

  const legacyFile = path.join(dir, 'legacy-policy.bin')
  fs.writeFileSync(
    legacyFile,
    packModel({ ...network.parameters(), features: ['tempo', 'vocal'], steps: 42, trainedAt: 1_650_000_000_000 })
  )
  const activated = activateLocal(legacyFile, { dir })

  assert.equal(activated.converted, true)
  assert.equal(activated.convertedFrom, 'legacy-policy.bin', 'the manifest records only the basename')
  assert.equal(path.extname(activated.file), '.safetensors')
  assert.equal(activated.format, 'safetensors')
  assert.equal(activated.convertedFrom, 'legacy-policy.bin')
  assert.ok(fs.existsSync(activated.file))
  const converted = unpackNetworkSafetensors(fs.readFileSync(activated.file))
  assert.deepEqual(converted.features, ['tempo', 'vocal'])
  assert.equal(converted.steps, 42)
  assert.equal(converted.metadata.legacyFormat, 'LVDJ-bin')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).file, 'legacy-policy.safetensors')
})

test('Safetensors rejects malformed shapes, offsets, headers and non-finite weights', () => {
  assert.throws(() => packSafetensors({ bad: { dtype: 'F32', shape: [2], data: [1] } }), /expected 2/)
  assert.throws(() => packSafetensors({ bad: { dtype: 'F32', shape: [1], data: [Number.NaN] } }), /not finite/)

  const valid = packSafetensors({ tensor: { dtype: 'F32', shape: [1], data: [1] } })
  assert.throws(() => unpackSafetensors(valid.subarray(0, valid.length - 1)), /size|unclaimed|offsets/)
  const badHeader = Buffer.from(valid)
  badHeader.writeBigUInt64LE(BigInt(valid.length), 0)
  assert.throws(() => unpackSafetensors(badHeader), /header length/)
})
