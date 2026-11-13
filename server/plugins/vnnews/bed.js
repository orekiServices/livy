/**
 * The music under the news.
 *
 * A voice alone on a music station sounds like a mistake — a hole in the
 * programme. Every newsroom in the world puts a bed under the bulletin: it
 * starts before the first word, sits well under the voice, and carries the
 * silence at the end back into the music.
 *
 * Nothing here is new machinery. The node already decodes and encodes with
 * MetroS and already has a proper sidechain ducker in `core/dsp.js` — the
 * one the automix DJ uses — so the bed is mixed with the same tools:
 *
 *   1. decode the spoken bulletin and the bed (any format MetroS can read);
 *   2. loop the bed to length, with a lead-in before the first word and a
 *      tail after the last;
 *   3. duck it out of the way with a compressor keyed off the voice;
 *   4. mix, hold the peak below −1 dBFS, and encode one MP3.
 *
 * The result is a file, so the station plays it exactly as it plays any
 * other announcement — and if any step fails, the bulletin simply goes out
 * dry rather than not at all.
 *
 * **Free music only.** The shipped default is a ccMixter search, which is
 * Creative Commons by construction; anything else is the owner's own file
 * or URL.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { decodeMp3, transcodeToMp3, encodeMp3, sniff } from '../../src/util/metro.js'
import { compressorGain, samplePeak, resample, TO_DB, DB } from '../../src/core/dsp.js'

/** Where a bed can come from, in the order they are tried. */
const CACHE_TTL_MS = 12 * 3600_000
const beds = new Map() // key → { at, pcm }

/**
 * Fetch and decode the bed named in the settings.
 *
 * `bed` may be a URL, a path, or a source query (`ccsearch:ambient`,
 * `local:beds/news.mp3`, `adsearch:instrumental`). A query goes through the
 * node's own source registry, so a bed is found the same way music is.
 */
export async function loadBed(settings, ctx) {
  const reference = String(settings.bed ?? '').trim()
  if (!reference || reference === 'none') return null

  const cached = beds.get(reference)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.pcm

  let bytes = null

  if (/^https?:\/\//i.test(reference)) {
    const res = await fetch(reference, { headers: { 'user-agent': 'Livy/3 (news bed)' } })
    if (!res.ok) throw new Error(`bed ${res.status}`)
    bytes = Buffer.from(await res.arrayBuffer())
  } else if (fs.existsSync(reference)) {
    bytes = await fs.promises.readFile(reference)
  } else {
    // A source query: ccMixter, Audius, archive.org, a local folder…
    const resolved = await ctx.resolve(reference)
    const track = (resolved.tracks ?? []).find((candidate) => candidate.streamable !== false)
    if (!track) throw new Error(`nothing playable for bed "${reference}"`)

    const opened = await ctx.stations.every()[0]?.sources?.stream?.(track)
    const stream = opened?.stream
    if (!stream) throw new Error('bed could not be opened')

    const chunks = []
    let size = 0
    for await (const chunk of stream) {
      chunks.push(chunk)
      size += chunk.length
      // A bed is a loop, not an album: three minutes is plenty.
      if (size > 6 << 20) break
    }
    stream.destroy?.()
    bytes = Buffer.concat(chunks)
  }

  if (!bytes?.length) throw new Error('bed was empty')
  // Anything MetroS can read: mp3, flac, m4a, ogg…
  const mp3 = sniff(bytes) === 'mp3' ? bytes : await transcodeToMp3(bytes, { bitrate: 192 })
  const pcm = await decodeMp3(mp3)
  if (!pcm) throw new Error('bed could not be decoded')

  beds.set(reference, { at: Date.now(), pcm })
  return pcm
}

/** Read one channel of a bed, looping, with a gentle wrap at the seam. */
function bedAt(bed, index, channel) {
  const source = channel === 0 ? bed.left : bed.right
  const length = source.length
  if (length === 0) return 0
  const at = index % length
  // 20 ms crossfade across the loop point so the join is inaudible.
  const blend = 882
  if (at < blend && index >= length) {
    const t = at / blend
    return source[at] * t + source[length - blend + at] * (1 - t)
  }
  return source[at]
}

/**
 * Mix a spoken bulletin over a music bed and write one MP3.
 *
 * @returns {Promise<string|null>} the mixed file, or null if it could not be made
 */
export async function mixWithBed({
  voiceFile,
  bed,
  cacheDir,
  gainDb = -14,
  duckDb = -9,
  leadInMs = 2500,
  tailMs = 3000,
  bitrate = 128
}) {
  if (!bed || !voiceFile || !cacheDir) return null

  const voiceBytes = await fs.promises.readFile(voiceFile)
  const voice = await decodeMp3(voiceBytes)
  if (!voice?.length) return null

  const rate = voice.sampleRate

  // The bed and the voice rarely agree: a speech service answers at 24 kHz
  // and music is 44.1. Playing one at the other's rate transposes it — the
  // bed would come out a third low — so resample first.
  if (bed.sampleRate !== rate) {
    bed = {
      left: resample(bed.left, bed.sampleRate, rate),
      right: resample(bed.right, bed.sampleRate, rate),
      sampleRate: rate,
      length: 0
    }
    bed.length = bed.left.length
  }
  const lead = Math.max(0, Math.round((leadInMs / 1000) * rate))
  const tail = Math.max(0, Math.round((tailMs / 1000) * rate))
  const total = lead + voice.length + tail

  // The cache name covers everything that changes the sound, so a repeated
  // bulletin is not mixed twice.
  const key = createHash('sha1')
    .update(`${voiceFile}|${bed.left.length}|${rate}|${gainDb}|${duckDb}|${leadInMs}|${tailMs}`)
    .digest('hex')
    .slice(0, 20)
  const out = path.join(cacheDir, `news-${key}.mp3`)
  if (fs.existsSync(out) && fs.statSync(out).size > 1024) return out

  // The key for the ducker: the voice, in place, as a mono control signal.
  const control = new Float32Array(total)
  for (let i = 0; i < voice.length; i += 1) {
    const at = lead + i
    control[at] = (Math.abs(voice.left[i]) + Math.abs(voice.right[i])) * 0.5
  }

  const duck = compressorGain(control, rate, {
    thresholdDb: -40,
    ratio: 12,
    attackMs: 120,
    releaseMs: 700,
    rangeDb: duckDb
  })

  const bedGain = DB(gainDb)
  const left = new Float32Array(total)
  const right = new Float32Array(total)

  // Ramps so the bed arrives and leaves rather than appearing.
  const fadeIn = Math.min(lead || 1, Math.round(rate * 1.2))
  const fadeOut = Math.min(tail || 1, Math.round(rate * 2))

  for (let i = 0; i < total; i += 1) {
    let envelope = 1
    if (i < fadeIn) envelope = i / fadeIn
    else if (i > total - fadeOut) envelope = Math.max(0, (total - i) / fadeOut)

    const gain = bedGain * duck[i] * envelope
    const voiceAt = i - lead
    const speech = voiceAt >= 0 && voiceAt < voice.length ? voiceAt : -1

    left[i] = bedAt(bed, i, 0) * gain + (speech >= 0 ? voice.left[speech] : 0)
    right[i] = bedAt(bed, i, 1) * gain + (speech >= 0 ? voice.right[speech] : 0)
  }

  // Hold it under the ceiling, like every other thing this node airs.
  const ceiling = DB(-1)
  const peak = samplePeak([left, right])
  if (peak > ceiling) {
    const trim = ceiling / peak
    for (let i = 0; i < total; i += 1) {
      left[i] *= trim
      right[i] *= trim
    }
  }

  const mp3 = await encodeMp3({ left, right, sampleRate: rate, bitrate })
  await fs.promises.writeFile(out, mp3)
  return out
}

/** How loud the bed ended up under the voice — used by the tests. */
export const duckedDb = (bedPeak, voicePeak) => Number((TO_DB(bedPeak) - TO_DB(voicePeak)).toFixed(1))

export default { loadBed, mixWithBed }
