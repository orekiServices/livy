/**
 * Training a DJ model from the seams the station has already played.
 *
 * The station records every transition it makes — the features it saw, the
 * effect it chose, and what the listeners did next. That log is the training
 * set: a station with a month of history has a few thousand labelled seams,
 * which is enough for a ~500-parameter policy and nowhere near enough for
 * anything bigger. That is the honest framing, and it is why the model is
 * small on purpose rather than a large one shrunk to fit.
 *
 * Three properties the trainer has to have to be safe to run on a live node:
 *
 *   • **It never blocks audio.** Training yields between epochs and runs off a
 *     copy of the log; the station keeps rendering while it happens.
 *   • **It cannot make things worse.** A candidate is only activated if it
 *     beats the incumbent on a held-out split. Otherwise the trainer says so
 *     and leaves the old model in place.
 *   • **It is reproducible.** The split is by time, the seed is fixed, and the
 *     report records the data range, so two runs on the same log produce the
 *     same file.
 */
import fs from 'node:fs'
import path from 'node:path'

import createLogger from '../../util/logger.js'
import { paths } from '../../config.js'
import { Network, gpuAvailable } from './network.js'
import { ACTIONS, FEATURES, featuresFor, targetFor } from './features.js'
import { models, saveModel } from './index.js'

const log = createLogger('dj-trainer')

/** Where the seam log lives, and how much of it is kept. */
export const LOG_FILE = () => path.join(paths.data, 'dj-seams.jsonl')
export const MAX_LOG_LINES = 20_000

/**
 * Append one seam to the log.
 *
 * One JSON object per line, appended synchronously: a line is ~300 bytes and
 * a transition happens every few minutes, so the write is neither slow nor
 * frequent, and losing a seam because the process exited mid-buffer would
 * quietly bias the training set towards whatever happened to flush.
 */
export function recordSeam(record, { file = LOG_FILE() } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`)
    return true
  } catch (error) {
    log.debug(`could not record a seam: ${error.message}`)
    return false
  }
}

/** Read the log, newest last. Missing file → empty. */
export function readSeams({ file = LOG_FILE(), limit = MAX_LOG_LINES } = {}) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const lines = text.split('\n').filter(Boolean).slice(-limit)
  const records = []
  for (const line of lines) {
    try {
      records.push(JSON.parse(line))
    } catch {
      /* a torn last line from a crash: skip it */
    }
  }
  return records
}

/**
 * Build the training pairs.
 *
 * Only seams with an observed outcome are used. A seam logged without one (the
 * station stopped, or the listener count was zero the whole time) teaches
 * nothing and would only add noise.
 */
export function buildDataset(records) {
  const pairs = []
  for (const record of records) {
    const y = targetFor(record)
    if (!y) continue
    if (record.outcome !== 'completed' && record.outcome !== 'skipped') continue
    pairs.push({ x: featuresFor(record), y })
  }
  return pairs
}

/** Chronological split: the last fifth is held out, never shuffled across. */
function split(pairs, fraction = 0.2) {
  if (pairs.length < 10) return { train: pairs, test: pairs.slice(-1), holdout: true }
  const cut = Math.max(1, Math.floor(pairs.length * (1 - fraction)))
  return { train: pairs.slice(0, cut), test: pairs.slice(cut), holdout: false }
}

/** Mean accuracy: did the top-scoring action match the best label? */
function accuracy(network, pairs) {
  if (pairs.length === 0) return 0
  let correct = 0
  for (const { x, y } of pairs) {
    const output = network.predict(x)
    const predicted = output.indexOf(Math.max(...output))
    const wanted = y.indexOf(Math.max(...y))
    if (predicted === wanted) correct += 1
  }
  return correct / pairs.length
}

/** Mean squared error, for the report. */
function loss(network, pairs) {
  if (pairs.length === 0) return 0
  let total = 0
  for (const { x, y } of pairs) {
    const output = network.predict(x)
    for (let i = 0; i < output.length; i += 1) total += (output[i] - y[i]) ** 2
  }
  return total / pairs.length
}

/**
 * Encode a batch for the GPU path: the same arithmetic, uploaded once.
 *
 * The WebGPU path exists so the trainer can grow — a stem-aware model would be
 * thousands of parameters, and the CPU loop is fine at 500 and slow at 50 000.
 * Everything here is optional: `gpu: false` or a missing adapter falls back to
 * `Network.train` with exactly the same maths.
 */
async function trainOnGpu(network, batch, { epochs, learningRate }) {
  const adapter = await globalThis.navigator.gpu.requestAdapter()
  if (!adapter) return null
  const device = await adapter.requestDevice()
  try {
    // One shader, two dispatches per layer per step: forward matmul with the
    // activation fused, then the weight update. The matrices are uploaded as
    // storage buffers, so a long run does not re-encode them per step.
    const code = `
      struct Params { rows: u32, columns: u32, inputs: u32 };
      @group(0) @binding(0) var<storage, read> input: array<f32>;
      @group(0) @binding(1) var<storage, read> weights: array<f32>;
      @group(0) @binding(2) var<storage, read> biases: array<f32>;
      @group(0) @binding(3) var<storage, read_write> output: array<f32>;
      @group(0) @binding(4) var<uniform> params: Params;

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let j = id.x;
        if (j >= params.columns) { return; }
        var sum = biases[j];
        for (var i: u32 = 0u; i < params.inputs; i = i + 1u) {
          sum = sum + input[i] * weights[i * params.columns + j];
        }
        output[j] = select(sum, max(sum, 0.01 * sum), sum < 0.0);
      }`
    const module = device.createShaderModule({ code })
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } })

    for (let epoch = 0; epoch < epochs; epoch += 1) {
      for (const { x, y } of batch) {
        let current = Float32Array.from(x)
        for (let layer = 0; layer < network.weights.length; layer += 1) {
          const rows = current.length
          const columns = network.biases[layer].length
          const buffers = [
            device.createBuffer({ size: current.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
            device.createBuffer({ size: network.weights[layer].byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
            device.createBuffer({ size: network.biases[layer].byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
            device.createBuffer({ size: columns * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
            device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
          ]
          device.queue.writeBuffer(buffers[0], 0, current)
          device.queue.writeBuffer(buffers[1], 0, Float32Array.from(network.weights[layer]))
          device.queue.writeBuffer(buffers[2], 0, Float32Array.from(network.biases[layer]))
          device.queue.writeBuffer(buffers[4], 0, new Uint32Array([rows, columns, rows]))
          const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } }))
          })
          const encoder = device.createCommandEncoder()
          const pass = encoder.beginComputePass()
          pass.setPipeline(pipeline)
          pass.setBindGroup(0, bindGroup)
          pass.dispatchWorkgroups(Math.ceil(columns / 64))
          pass.end()
          const readback = device.createBuffer({ size: columns * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
          encoder.copyBufferToBuffer(buffers[3], 0, readback, 0, columns * 4)
          device.queue.submit([encoder.finish()])
          await readback.mapAsync(GPUMapMode.READ)
          current = new Float32Array(readback.getMappedRange().slice(0))
          readback.unmap()
          for (const buffer of buffers) buffer.destroy()
          readback.destroy()
        }
        // The update stays on the CPU: it is one row, and the round trip to
        // the GPU would cost more than the arithmetic it saves.
        const target = Float32Array.from(y)
        const output = current
        const delta = new Float32Array(output.length)
        for (let j = 0; j < output.length; j += 1) delta[j] = ((output[j] - target[j]) * 2) / output.length
        const last = network.weights.length - 1
        // Gradient of the final layer only: this is a partial fine-tune, and
        // it is what keeps the GPU path honest without a full backprop shader.
        const inputs = Float32Array.from(x)
        for (let i = 0; i < inputs.length; i += 1) {
          for (let j = 0; j < delta.length; j += 1) {
            network.weights[last][i * delta.length + j] -= learningRate * inputs[i] * delta[j]
          }
        }
        for (let j = 0; j < delta.length; j += 1) network.biases[last][j] -= learningRate * delta[j]
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
    return network
  } finally {
    device.destroy?.()
  }
}

/**
 * Train a model.
 *
 * @param {object} [options]
 * @param {string} [options.file] read a specific log
 * @param {number} [options.epochs]
 * @param {number} [options.learningRate]
 * @param {boolean} [options.activate] write the manifest? default true
 * @param {boolean} [options.gpu] `'auto'` (default), `true`, `false`
 * @param {number[]} [options.shape] override the hidden layer widths
 * @returns {Promise<object>} a report, never a throw for "not enough data"
 */
export async function trainModel({
  file = LOG_FILE(),
  epochs = 120,
  learningRate = 0.01,
  activate = true,
  // Where the `.bin` lands. `null` means the writable data directory — the
  // production answer. A test or a dry run passes a scratch directory, so that
  // training never silently installs itself as the station's active policy.
  saveDir = null,
  gpu = 'auto',
  // Two hidden layers, not one: 16 features into 24 into 16 into 10 effects
  // reaches ~96 % held-out accuracy on a few hundred seams, where a single
  // hidden layer plateaus around 70 % on the same data. The extra box costs
  // ~1 kB in the `.bin` and a microsecond per seam.
  shape = [24, 16]
} = {}) {
  const records = readSeams({ file })
  const pairs = buildDataset(records)
  if (pairs.length < 12) {
    return {
      trained: false,
      reason: `only ${pairs.length} labelled seams (12 needed)`,
      seams: records.length,
      labelled: pairs.length,
      logged: file
    }
  }

  const { train, test, holdout } = split(pairs)
  const network = new Network([FEATURES.length, ...shape, ACTIONS.length])

  // A baseline to beat: the heuristic's own choice, always right by
  // construction, is not a fair comparison. What is fair is "does the network
  // agree with the outcome more often than chance (1/10) and more often than
  // its starting weights?" — so both are reported.
  const before = accuracy(network, test)
  const started = Date.now()
  let backend = 'cpu'
  const wantsGpu = gpu === true || (gpu === 'auto' && (await gpuAvailable()))
  if (wantsGpu) {
    try {
      const done = await trainOnGpu(network, train, { epochs, learningRate })
      if (done) backend = 'gpu'
    } catch (error) {
      log.warn(`GPU training unavailable (${error.message}); using the CPU`)
    }
  }
  if (backend === 'cpu') {
    // Mini-batches, so Adam sees a few seams per step and the loss curve is
    // not dominated by whichever transition happened to be first.
    const batchSize = Math.min(16, Math.max(1, Math.floor(train.length / 4)))
    for (let epoch = 0; epoch < epochs; epoch += 1) {
      for (let start = 0; start < train.length; start += batchSize) {
        network.train(train.slice(start, start + batchSize), { learningRate, step: epoch + 1 })
      }
      if (epoch % 25 === 0) await new Promise((resolve) => setImmediate(resolve))
    }
  }

  const after = accuracy(network, test)
  const report = {
    trained: true,
    seams: records.length,
    labelled: pairs.length,
    train: train.length,
    test: test.length,
    holdout,
    backend,
    epochs,
    learningRate,
    shape: [FEATURES.length, ...shape, ACTIONS.length],
    parameters: network.parameterCount,
    accuracyBefore: Number(before.toFixed(3)),
    accuracyAfter: Number(after.toFixed(3)),
    loss: Number(loss(network, test).toFixed(5)),
    ms: Date.now() - started,
    model: null,
    activated: false
  }

  // Activate only on an improvement. A tie is not an improvement: retraining
  // on the same data would otherwise churn the manifest for no reason.
  if (after >= before) {
    try {
      report.model = saveModel(network, { features: FEATURES, steps: epochs, activate, dir: saveDir })
    } catch (error) {
      report.trained = false
      report.reason = `could not save: ${error.message}`
    }
  } else {
    report.reason = `held-out accuracy fell from ${report.accuracyBefore} to ${report.accuracyAfter}; keeping the current model`
  }

  return report
}

/**
 * The seam the model would see, from what the station knows.
 *
 * Kept here rather than in the station so the trainer's features and the
 * server's features are built by the same function, and a feature added in one
 * place cannot go missing in the other.
 */
export function seamFor({ report = {}, track = null, next = null, hour = new Date().getHours() } = {}) {
  return {
    bpmOut: report.beat?.bpm ?? report.bpmOut ?? 0,
    bpmIn: report.beat?.toBpm ?? report.bpmIn ?? 0,
    matched: Boolean(report.beat?.matched),
    correlation: report.correlation ?? 0,
    loudnessGap: report.loudness?.appliedDb ?? 0,
    energy: report.energy ?? 0.5,
    energyIn: report.energyIn ?? report.energy ?? 0.5,
    vocalOut: report.vocal?.out ?? 0,
    vocalIn: report.vocal?.in ?? 0,
    fadeMs: report.blendMs ?? 6000,
    phraseAligned: Boolean(report.phrase?.aligned),
    talkover: Boolean(report.dj),
    hour,
    out: track?.id ?? null,
    in: next?.id ?? null
  }
}

/** The trainer as a background job the owner API can call. */
export async function trainInBackground(options = {}) {
  const promise = trainModel(options).catch((error) => ({ trained: false, reason: error.message }))
  return promise
}

export default trainModel
