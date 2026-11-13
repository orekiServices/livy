/**
 * The codec the seam renderers share: whichever encoder and decoder this
 * process has (MetroS natively, lamejs + mpg123 otherwise), behind the three
 * calls `util/splice.ts` needs.
 */
import { MetroFramer, decodeExact, decodeMp3, encodeMp3, engineInfo } from './metro.js'
import { parseFrameHeader } from './mp3.js'

const SLICE = 64 * 1024

export const codec = {
  encode: (pcm) => encodeMp3(pcm),
  decode: (buffer) => decodeMp3(buffer),
  // The framer hands back a bounded number of frames per push, so a whole
  // file goes through it in pieces.
  frames: (buffer) => {
    const framer = new MetroFramer()
    const frames = []
    for (let at = 0; at < buffer.length; at += SLICE) {
      for (const frame of framer.push(buffer.subarray(at, at + SLICE)).frames) frames.push(frame)
    }
    return frames
  }
}

/** Cache key for the measured delay: it belongs to an encoder/decoder pair. */
export const codecKey = () => {
  const info = engineInfo()
  return `${info.encoder}/${info.decoder}`
}

/** Samples in a run of frames (1152 each for MPEG-1, 576 for the low rates). */
export function samplesIn(frames) {
  let total = 0
  for (const frame of frames) total += parseFrameHeader(frame, 0)?.samples ?? 1152
  return total
}

/** Decode frames to PCM that is exactly as long as the frames say it is. */
export async function decodeFrames(frames) {
  if (frames.length === 0) return null
  return decodeExact(Buffer.concat(frames), samplesIn(frames))
}

export default codec
