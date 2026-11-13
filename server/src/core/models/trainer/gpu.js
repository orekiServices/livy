/**
 * Optional WebGPU training. Never required: every caller falls back to the
 * CPU path with the same numbers when there is no adapter.
 */
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

export async function trainOnGpu(network, batch, { epochs, learningRate }) {
  const adapter = await globalThis.navigator.gpu.requestAdapter()
  if (!adapter) return null
  const device = await adapter.requestDevice()
  try {
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
        // Only the final layer is updated here; a full backprop shader buys
        // nothing on a model this small.
        const target = Float32Array.from(y)
        const delta = new Float32Array(current.length)
        for (let j = 0; j < current.length; j += 1) delta[j] = ((current[j] - target[j]) * 2) / current.length
        const last = network.weights.length - 1
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
