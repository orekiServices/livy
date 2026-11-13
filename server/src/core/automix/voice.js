/**
 * The voice-tracking DJ: render the line, condition it, duck the bed under it.
 */
import { createHash } from 'node:crypto'
import { Biquad, DB, clamp, compressorGain, integratedLoudness, samplePeak } from '../dsp.js'
import { decodeMp3 } from './audio.js'
import { fitRate } from './util.js'

export function voiceTrack(options, { left, right, voice, voiceStart, sampleRate }) {

    const dj = options.dj
    const control = new Float32Array(left.length)
    for (let i = 0; i < voice.length; i += 1) {
      const j = voiceStart + i
      if (j >= 0 && j < control.length) control[j] = voice.data[i]
    }

    const duck = compressorGain(control, sampleRate, {
      thresholdDb: dj.thresholdDb,
      ratio: dj.ratio,
      attackMs: dj.attackMs,
      releaseMs: dj.releaseMs,
      rangeDb: Number(dj.duckDb) || -9
    })

    const bedHp = [Biquad.highpass(dj.bedHighpassHz ?? 180, sampleRate), Biquad.highpass(dj.bedHighpassHz ?? 180, sampleRate)]
    for (let i = 0; i < left.length; i += 1) {
      const gain = duck[i]
      // How much of the high-passed bed to use: only while it is ducked.
      const blend = clamp((1 - gain) / Math.max(0.001, 1 - DB(Number(dj.duckDb) || -9)), 0, 1)
      const l = left[i] * (1 - blend) + bedHp[0].process(left[i]) * blend
      const r = right[i] * (1 - blend) + bedHp[1].process(right[i]) * blend
      left[i] = l * gain + (control[i] ?? 0)
      right[i] = r * gain + (control[i] ?? 0)
    }
  
}

export async function speak({ sources, options, log }, text, sampleRate) {

    try {
      const id = `tts:dj:${createHash('sha1').update(text).digest('hex').slice(0, 12)}`
      const opened = await sources.stream(
        { source: 'tts', id, title: 'DJ', artist: options.dj.name, text, announcement: true, duration: 0, bitrate: 128, streamable: true },
        {}
      )
      const chunks = []
      for await (const chunk of opened.stream) chunks.push(chunk)
      const pcm = await decodeMp3(Buffer.concat(chunks))
      if (!pcm) return null
      const fitted = fitRate(pcm, sampleRate)

      // Mono, de-rumbled, compressed like a voice channel, then normalised to
      // the DJ target so every line sits at the same level over the bed.
      const hp = Biquad.highpass(90, sampleRate)
      const mono = new Float32Array(fitted.left.length)
      for (let i = 0; i < mono.length; i += 1) mono[i] = hp.process((fitted.left[i] + fitted.right[i]) / 2)

      const gains = compressorGain(mono, sampleRate, { thresholdDb: -26, ratio: 3, attackMs: 2, releaseMs: 80, kneeDb: 6 })
      for (let i = 0; i < mono.length; i += 1) mono[i] *= gains[i]

      const loud = integratedLoudness([mono, mono], sampleRate)
      let gain = 1
      if (loud != null) gain = DB(clamp((options.dj.voiceTargetLufs ?? -14) - loud, -12, 18))
      const peak = samplePeak([mono])
      if (peak * gain > 0.89) gain = 0.89 / Math.max(1e-6, peak)
      for (let i = 0; i < mono.length; i += 1) mono[i] *= gain

      return { data: mono, length: mono.length }
    } catch (error) {
      log.debug(`dj voice failed: ${error.message}`)
      return null
    }
  
}
