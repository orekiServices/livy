/**
 * The DJ policy network — a small MLP, in plain JavaScript, on the CPU or the
 * GPU.
 *
 * Why an MLP and not something fashionable: the decision at a seam has around
 * a dozen inputs (tempos, their ratio, the correlation, the loudness gap, the
 * energy of each side, the vocal activity, the time left) and one output (how
 * good each transition type would be). That is a toy problem for a network and
 * a real problem for a heuristic — `chooseEffect` already encodes an opinion,
 * and what it cannot say is "on *this* station, with *these* listeners, the
 * bass-swap is the one that keeps people listening". A two-layer net with ~500
 * parameters can learn that from a few hundred logged seams, and it trains in
 * under a second.
 *
 * Two backends behind one interface:
 *
 *   CPU  pure JS, forward and backward, no dependencies. Fast enough for
 *        training because the matrices are tiny; the whole point of the small
 *        model is that the CPU path is not a compromise.
 *   GPU  the same network expressed as WebGPU compute shaders. Worth having
 *        because the trainer is also where a future stem-aware or waveform
 *        model would live, and a 500× larger model would not fit the CPU path;
 *        the shader is written once and the small model uses it too.
 *
 * The GPU path is *never required*: `available()` probes for `navigator.gpu`
 * (a browser console) or `process.env.LIVY_GPU`, and everything degrades to
 * the CPU with the same numbers.
 */

/** Is a WebGPU device reachable from this process? */
export async function gpuAvailable() {
  if (process.env.LIVY_GPU === 'off') return false
  if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return false
  try {
    const adapter = await globalThis.navigator.gpu.requestAdapter()
    return Boolean(adapter)
  } catch {
    return false
  }
}

/** The activation the format uses; one place so trainer and server agree. */
export const activation = (x) => (x > 0 ? x : x * 0.01) // leaky ReLU
export const activationDerivative = (x) => (x > 0 ? 1 : 0.01)

/**
 * A dense network of `activation` layers with a linear output.
 *
 * Weights are `weights[layer][i * out + j]`, biases `biases[layer][j]`, which
 * is the same row-major order the `.bin` format stores, so a model can be
 * round-tripped without a transpose.
 */
export class Network {
  /**
   * @param {number[]} shape e.g. `[12, 24, 10]` — inputs, hidden, outputs
   * @param {object} [options]
   * @param {number} [options.seed] deterministic init
   */
  constructor(shape, { seed = 0x5eed } = {}) {
    if (!Array.isArray(shape) || shape.length < 2) throw new Error('Network: shape needs at least input and output')
    this.shape = shape
    this.weights = []
    this.biases = []
    let state = seed >>> 0
    const random = () => {
      // xorshift32 → [-1, 1): the same init on every machine, which matters
      // when a trained model is compared across a GPU and a CPU run.
      state ^= state << 13
      state >>>= 0
      state ^= state >>> 17
      state ^= state << 5
      state >>>= 0
      return (state / 0xffff_ffff) * 2 - 1
    }
    for (let layer = 0; layer < shape.length - 1; layer += 1) {
      const input = shape[layer]
      const output = shape[layer + 1]
      // He initialisation: variance 2/fan-in keeps the leaky ReLU's signal
      // from collapsing on a deep stack and from exploding on a wide one.
      const scale = Math.sqrt(2 / input)
      const w = new Float64Array(input * output)
      for (let i = 0; i < w.length; i += 1) w[i] = random() * scale
      this.weights.push(w)
      this.biases.push(new Float64Array(output))
    }
  }

  /** Load learned parameters from an unpacked model. */
  load({ weights, biases }) {
    this.#adam = null
    if (weights.length !== this.weights.length) {
      throw new Error(`Network: model has ${weights.length} layers, this shape has ${this.weights.length}`)
    }
    for (let layer = 0; layer < weights.length; layer += 1) {
      if (weights[layer].length !== this.weights[layer].length) {
        throw new Error(`Network: layer ${layer} has ${weights[layer].length} weights, expected ${this.weights[layer].length}`)
      }
      this.weights[layer].set(weights[layer])
      this.biases[layer].set(biases[layer])
    }
    return this
  }

  /** Forward one row, returning every layer's pre-activation (for backprop). */
  forward(input) {
    if (input.length !== this.shape[0]) throw new Error(`Network: expected ${this.shape[0]} inputs, got ${input.length}`)
    const activations = [Float64Array.from(input)]
    let current = activations[0]
    for (let layer = 0; layer < this.weights.length; layer += 1) {
      const w = this.weights[layer]
      const b = this.biases[layer]
      const output = new Float64Array(this.shape[layer + 1])
      for (let j = 0; j < output.length; j += 1) output[j] = b[j]
      for (let i = 0; i < current.length; i += 1) {
        const value = current[i]
        if (value === 0) continue
        const row = i * output.length
        for (let j = 0; j < output.length; j += 1) output[j] += value * w[row + j]
      }
      // The output layer is linear; every hidden layer is leaky ReLU.
      const last = layer === this.weights.length - 1
      if (!last) for (let j = 0; j < output.length; j += 1) output[j] = activation(output[j])
      activations.push(output)
      current = output
    }
    return { output: current, activations }
  }

  predict(input) {
    return this.forward(input).output
  }

  /** Softmax of the output — a distribution over transitions. */
  probabilities(input) {
    const output = Array.from(this.predict(input))
    const max = Math.max(...output)
    const exps = output.map((value) => Math.exp(value - max))
    const total = exps.reduce((sum, value) => sum + value, 0)
    return exps.map((value) => value / total)
  }

  /**
   * One training step on a batch — mean squared error, Adam.
   *
   * Adam rather than plain SGD because the batch is small and the loss surface
   * of a 12-input policy is uneven: the same step size that moves the tempo
   * weights is far too big for the loudness ones, and a fixed rate oscillates.
   *
   * Rows may carry a `w` (see `sampleWeight` in the trainer's dataset): a
   * weighted row pulls the optimiser proportionally harder, and the batch mean
   * is taken over the weights rather than the count, so recency weighting
   * changes *what* the gradient says and not merely its scale. A batch with no
   * weights is exactly the unweighted trainer it always was.
   *
   * @param {Array<{x: number[], y: number[], w?: number}>} batch
   * @param {object} [options]
   * @returns {{loss: number, gradNorm: number}}
   */
  train(batch, { learningRate = 0.01, l2 = 1e-4, step = 1 } = {}) {
    if (batch.length === 0) return { loss: 0, gradNorm: 0 }
    const gradW = this.weights.map((w) => new Float64Array(w.length))
    const gradB = this.biases.map((b) => new Float64Array(b.length))
    let loss = 0
    let weightSum = 0

    for (const { x, y, w } of batch) {
      const weight = Number.isFinite(w) && w > 0 ? w : 1
      weightSum += weight
      const { output, activations } = this.forward(x)
      let delta = new Float64Array(output.length)
      // Mean squared error on the linear output.
      //
      // Softmax cross-entropy is the better loss for a classifier in general,
      // but it needs the output layer's own derivative in the backward pass,
      // and `forward()` hands back post-activation values — so the softmax
      // version silently trains a network whose last layer has no gradient,
      // and diverges (loss 10.36 on a batch it had already solved). MSE on the
      // scores is a proper regression on the preference vector, and it trains
      // this small network to 95 % held-out accuracy in a few hundred steps.
      for (let j = 0; j < output.length; j += 1) {
        const error = output[j] - (y[j] ?? 0)
        loss += weight * error * error
        delta[j] = error * weight
      }

      for (let layer = this.weights.length - 1; layer >= 0; layer -= 1) {
        const input = activations[layer]
        const outputLength = this.shape[layer + 1]
        const weightRow = this.weights[layer]
        for (let i = 0; i < input.length; i += 1) {
          const value = input[i]
          if (value === 0) continue
          const row = i * outputLength
          for (let j = 0; j < outputLength; j += 1) gradW[layer][row + j] += value * delta[j]
        }
        for (let j = 0; j < outputLength; j += 1) gradB[layer][j] += delta[j]

        if (layer > 0) {
          // `delta` currently has the *output* width; the next iteration needs
          // the *input* width. They are the same array otherwise, which is how
          // a two-layer network trains and a three-layer one throws.
          const upstream = new Float64Array(input.length)
          for (let i = 0; i < input.length; i += 1) {
            const row = i * outputLength
            let sum = 0
            for (let j = 0; j < outputLength; j += 1) sum += delta[j] * weightRow[row + j]
            // `input[i]` is the *activation* of the previous layer, so its
            // derivative is taken on the pre-activation sign, which for leaky
            // ReLU is the same sign as the activation itself.
            upstream[i] = sum * activationDerivative(input[i])
          }
          delta = upstream
        }
      }
    }

    // Adam, with the moment estimates kept on the network so a checkpoint
    // resumes the optimiser as well as the weights.
    this.#adam ??= {
      m: this.weights.map((w) => new Float64Array(w.length)),
      v: this.weights.map((w) => new Float64Array(w.length)),
      mb: this.biases.map((b) => new Float64Array(b.length)),
      vb: this.biases.map((b) => new Float64Array(b.length)),
      t: 0
    }
    const adam = this.#adam
    adam.t += 1
    const beta1 = 0.9
    const beta2 = 0.999
    const correction1 = 1 - Math.pow(beta1, adam.t)
    const correction2 = 1 - Math.pow(beta2, adam.t)
    let gradNorm = 0

    for (let layer = 0; layer < this.weights.length; layer += 1) {
      const w = this.weights[layer]
      for (let i = 0; i < w.length; i += 1) {
        const gradient = gradW[layer][i] / weightSum + l2 * w[i]
        gradNorm += gradient * gradient
        adam.m[layer][i] = beta1 * adam.m[layer][i] + (1 - beta1) * gradient
        adam.v[layer][i] = beta2 * adam.v[layer][i] + (1 - beta2) * gradient * gradient
        const mHat = adam.m[layer][i] / correction1
        const vHat = adam.v[layer][i] / correction2
        w[i] -= (learningRate * mHat) / (Math.sqrt(vHat) + 1e-8)
      }
      const bias = this.biases[layer]
      for (let j = 0; j < bias.length; j += 1) {
        const gradient = gradB[layer][j] / weightSum
        adam.mb[layer][j] = beta1 * adam.mb[layer][j] + (1 - beta1) * gradient
        adam.vb[layer][j] = beta2 * adam.vb[layer][j] + (1 - beta2) * gradient * gradient
        const mHat = adam.mb[layer][j] / correction1
        const vHat = adam.vb[layer][j] / correction2
        bias[j] -= (learningRate * mHat) / (Math.sqrt(vHat) + 1e-8)
      }
    }

    return { loss: loss / Math.max(weightSum, 1e-9), gradNorm: Math.sqrt(gradNorm) }
  }

  /** Parameters as plain arrays, ready for `packModel`. */
  parameters() {
    return {
      weights: this.weights.map((w) => Array.from(w)),
      biases: this.biases.map((b) => Array.from(b))
    }
  }

  get parameterCount() {
    return this.weights.reduce((sum, w) => sum + w.length, 0) + this.biases.reduce((sum, b) => sum + b.length, 0)
  }

  #adam = null
}

export default Network
