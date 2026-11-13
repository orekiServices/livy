/**
 * MP3 in / MP3 out. MetroS does both natively when a binary is present and
 * falls back to the WASM decoder / lamejs when it is not.
 */
import { decodeMp3 as metroDecode, encodeMp3 as metroEncode } from '../../util/metro.js'
import { resample } from '../dsp.js'

export { resample }

/** Decode MP3 to float channels, or null when no decoder is available. */
export async function decodeMp3(buffer) {
  return metroDecode(buffer)
}

/** Encode float channels back to MP3. */
export async function encodeMp3({ left, right, sampleRate, bitrate = 128 }) {
  return metroEncode({ left, right, sampleRate, bitrate })
}
