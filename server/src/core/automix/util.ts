/**
 * Small PCM helpers shared by the renderers and the engine.
 */
import { resample } from '../dsp.ts'

export const monoOf = (pcm) => {
  const out = new Float32Array(pcm.left.length)
  for (let i = 0; i < out.length; i += 1) out[i] = (pcm.left[i] + pcm.right[i]) / 2
  return out
}

export const sliceChannels = (pcm, from, to) => ({
  left: pcm.left.subarray(from, to),
  right: pcm.right.subarray(from, to),
  sampleRate: pcm.sampleRate,
  length: Math.max(0, to - from)
})

export function fitRate(pcm, sampleRate) {
  if (!pcm || pcm.sampleRate === sampleRate) return pcm
  return {
    left: resample(pcm.left, pcm.sampleRate, sampleRate),
    right: resample(pcm.right, pcm.sampleRate, sampleRate),
    sampleRate,
    length: Math.round((pcm.length * sampleRate) / pcm.sampleRate)
  }
}

