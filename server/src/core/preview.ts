/**
 * Hearing a transition before it goes on air.
 *
 * Ten transitions with names like "wash" and "roll" are ten guesses unless
 * you can listen to them. This renders a real seam — the same code path the
 * station uses, the same beatmatching, the same ducker, the same encoder —
 * between two pieces of music, and hands back an MP3.
 *
 * What it mixes, in order of preference:
 *
 *   1. **The station's own music**, when one is named: the last thing it
 *      played into the next thing in its queue. That is the transition you
 *      will actually hear tonight, not an approximation of it.
 *   2. **The shipped demo tracks** in `samples/`, which are two tempo-locked
 *      loops chosen to make a beatmatch audible.
 *   3. **Synthesised loops**, if neither is available — a node with no
 *      samples folder can still audition its transitions.
 *
 * Nothing here touches the transmitter: the preview is rendered in its own
 * Automix instance and returned to the caller.
 */
import fs from 'node:fs'
import path from 'node:path'

import { Automix, EFFECTS, AUTO_EFFECT } from './automix.ts'
import { decodeMp3, encodeMp3, probeMp3, MetroFramer } from '../util/metro.ts'
import { paths } from '../config.ts'
import createLogger from '../util/logger.ts'

const log = createLogger('preview')

/** Two bars of a synthetic loop — the last resort, and it does beat-match. */
function syntheticLoop({ bpm = 124, seconds = 12, sampleRate = 44100, freq = 180, gain = 0.5 }: any = {}) {
  const length = Math.round(seconds * sampleRate)
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  const period = Math.round((60 / bpm) * sampleRate)

  for (let i = 0; i < length; i += 1) {
    const intoBeat = i % period
    const envelope = Math.exp(-intoBeat / (sampleRate * 0.05))
    const click = Math.sin((2 * Math.PI * 62 * intoBeat) / sampleRate) * envelope * gain
    const bed = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.08
    const value = click + bed
    left[i] = value
    right[i] = value * 0.98
  }
  return { left, right, sampleRate, length }
}

async function encodeLoop(loop, bitrate = 128) {
  return encodeMp3({ left: loop.left, right: loop.right, sampleRate: loop.sampleRate, bitrate })
}

/** The demo material that ships with the node, if it is there. */
async function shippedSamples() {
  const root = path.resolve(paths.root, '..', 'samples')
  const files = ['automix-dj-demo.mp3', 'automix-effects-demo.mp3']
    .map((name) => path.join(root, name))
    .filter((file) => fs.existsSync(file))

  if (files.length === 0) return null
  const bytes = await fs.promises.readFile(files[0])
  const probe = probeMp3(bytes)
  if (!probe.frames) return null

  // Two halves of the same demo make a believable pair: same tempo, same
  // production, different music.
  const half = Math.floor(bytes.length / 2)
  return { a: bytes.subarray(0, half), b: bytes.subarray(half) }
}

/** The last thing this station played, and the next thing it will. */
async function stationPair(station, sources) {
  if (!station || !sources) return null
  const upcoming = station.queue?.[0]
  const current = station.current?.track
  if (!upcoming || !current) return null

  const read = async (track) => {
    const opened = await sources.stream(track)
    const stream = opened?.stream
    if (!stream) return null
    const chunks = []
    let size = 0
    try {
      for await (const chunk of stream) {
        chunks.push(chunk)
        size += chunk.length
        if (size > 3 << 20) break // 20 seconds at 128 kbps is plenty
      }
    } finally {
      stream.destroy?.()
      stream.cancel?.().catch?.(() => {})
      stream.return?.()
    }
    return Buffer.concat(chunks)
  }

  try {
    const [a, b] = await Promise.all([read(current), read(upcoming)])
    if (!a?.length || !b?.length) return null
    return { a, b, titles: [current.title, upcoming.title] }
  } catch (error) {
    log.debug(`station preview material unavailable: ${error.message}`)
    return null
  }
}

/** MP3 bytes → the frame records the automix eats. */
function framesOf(mp3, track) {
  const parsed = new MetroFramer().push(mp3)
  if (parsed.frames.length === 0) return []
  const frameMs = parsed.durationMs / parsed.frames.length
  return parsed.frames.map((data) => ({ data, ms: frameMs, track }))
}

/**
 * Render one transition and return the MP3.
 *
 * @returns {Promise<{mp3: Buffer, report: object, material: string}>}
 */
export async function previewTransition({
  effect = AUTO_EFFECT,
  crossfadeMs = 6000,
  smart = false,
  beatmatch = true,
  station = null,
  sources = null,
  bitrate = 128
}: any = {}) {
  if (effect !== AUTO_EFFECT && !EFFECTS.includes(effect)) {
    throw new Error(`unknown transition "${effect}" (try: ${AUTO_EFFECT}, ${EFFECTS.join(', ')})`)
  }

  let material = 'synthetic'
  let pair: any = await stationPair(station, sources)
  if (pair) material = `${station.id}: ${pair.titles[0]} → ${pair.titles[1]}`
  else {
    pair = await shippedSamples()
    if (pair) material = 'the shipped demo'
  }

  if (!pair) {
    pair = {
      a: await encodeLoop(syntheticLoop({ bpm: 124, seconds: 14, freq: 180 }), bitrate),
      b: await encodeLoop(syntheticLoop({ bpm: 124, seconds: 14, freq: 240 }), bitrate)
    }
  }

  const outgoing = { id: 'preview:a', title: 'Outgoing', artist: 'Preview', source: 'preview', duration: 0 }
  const incoming = { id: 'preview:b', title: 'Incoming', artist: 'Preview', source: 'preview', duration: 0 }

  const mix = new Automix(
    {
      enabled: true,
      effect,
      crossfadeMs,
      smart: smart === true,
      beatmatch: beatmatch !== false,
      // A preview must be quick and self-contained: no DJ, and a low bar for
      // "long enough to be worth mixing".
      minTrackMs: 1000,
      maxRenderMs: Math.max(30_000, crossfadeMs * 3),
      dj: { enabled: false },
      bitrate
    },
    { station: { name: 'Preview', subscribers: new Set() } }
  )

  const first = framesOf(pair.a, outgoing)
  const second = framesOf(pair.b, incoming)
  if (first.length === 0 || second.length === 0) throw new Error('the preview material had no audio')

  await mix.push(first)
  const out = await mix.push(second)
  const tail = await mix.flush('preview')

  const frames = [...out, ...tail].filter((frame) => frame?.data)
  if (frames.length === 0) throw new Error('nothing was rendered')

  const report = mix.info().last ?? { effect, blendMs: crossfadeMs }
  log.info(`preview: ${report.effect ?? effect} over ${material} (${report.blendMs ?? crossfadeMs}ms)`)

  return { mp3: Buffer.concat(frames.map((frame) => frame.data)), report, material }
}

export default previewTransition
