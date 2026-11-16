/**
 * File-to-file Automix rendering for the CLI. Only the tail of the outgoing
 * MP3 and the head of the incoming MP3 enter the renderer; the written file
 * stops at the end of the rendered seam.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Mp3FrameSplitter, parseFrameHeader } from '../../util/mp3.ts'
import { Automix } from './engine.ts'
import { DEFAULT_AUTOMIX } from './defaults.ts'
import { getSongBpmStatus } from './getsongbpm.ts'

const FRAME_CONTEXT_MS = 750
const INPUT_SAFETY_MS = 1000

export interface AutomixMp3Options {
  outgoing: string
  incoming: string
  output?: string
  outgoingTitle?: string
  outgoingArtist?: string
  incomingTitle?: string
  incomingArtist?: string
  crossfadeMs?: number
  preRollMs?: number
  bitrate?: number
  curve?: 'auto' | 'equal-power' | 'equal-gain'
  smart?: boolean
  beatmatch?: boolean
}

function trackFor(file: string, id: string, title: string | undefined, artist: string | undefined, bitrate: number) {
  const fallbackTitle = path.basename(file, path.extname(file)).trim() || id
  return {
    id,
    title: String(title ?? fallbackTitle).trim() || fallbackTitle,
    artist: String(artist ?? '').trim() || null,
    source: 'local',
    streamBitrate: bitrate
  }
}

/**
 * Read only one edge of an MP3. For a tail, a sliding frame window keeps
 * memory bounded while the file is scanned; for a head, reading stops as soon
 * as enough complete frames have arrived.
 */
async function readEdge(file: string, durationMs: number, edge: 'head' | 'tail', track: any) {
  const frames: Array<{ data: Buffer; ms: number; track: any } | null> = []
  const splitter = new Mp3FrameSplitter()
  let first = 0
  let totalMs = 0
  let reachedHead = false
  const stream = fs.createReadStream(file, { highWaterMark: 256 * 1024 })

  try {
    for await (const chunk of stream) {
      const parsed = splitter.push(chunk).frames
      for (const data of parsed) {
        const header = parseFrameHeader(data, 0)
        if (!header || header.layer !== 3) continue
        const frame = { data: Buffer.from(data), ms: header.durationMs, track }
        frames.push(frame)
        totalMs += frame.ms

        if (edge === 'head') {
          if (totalMs >= durationMs) {
            reachedHead = true
            break
          }
          continue
        }

        while (first < frames.length - 1 && totalMs - (frames[first]?.ms ?? 0) >= durationMs) {
          totalMs -= frames[first]?.ms ?? 0
          frames[first] = null
          first += 1
        }
        if (first >= 8192 && first * 2 >= frames.length) {
          frames.splice(0, first)
          first = 0
        }
      }
      if (reachedHead) {
        stream.destroy()
        break
      }
    }
  } finally {
    if (!stream.destroyed) stream.destroy()
  }

  const selected = frames.slice(first).filter((frame): frame is NonNullable<typeof frame> => Boolean(frame))
  const selectedMs = selected.reduce((sum, frame) => sum + frame.ms, 0)
  if (!selected.length) throw new Error(`No valid MP3 audio frames found in ${file}`)
  return { frames: selected, durationMs: selectedMs, reachedHead }
}

function holdWindowMs(crossfadeMs: number, smart: boolean) {
  if (!smart) return crossfadeMs + 100
  const max = Math.max(crossfadeMs, Number(DEFAULT_AUTOMIX.maxCrossfadeMs) || 30_000)
  const requested = Number(DEFAULT_AUTOMIX.holdMs) || 12_000
  return Math.max(crossfadeMs, Math.min(max, requested)) + 100
}

function chooseOutput(outgoing: string, incoming: string, output?: string) {
  if (output) return path.resolve(output)
  const safe = (value: string) => path.basename(value, path.extname(value)).replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'track'
  return path.resolve(`${safe(outgoing)}-to-${safe(incoming)}-transition.mp3`)
}

/** Render the final part of `outgoing` into the opening of `incoming`. */
export async function renderAutomixMp3(options: AutomixMp3Options) {
  const outgoingFile = path.resolve(String(options.outgoing ?? ''))
  const incomingFile = path.resolve(String(options.incoming ?? ''))
  if (!options.outgoing || !options.incoming) throw new Error('Both outgoing and incoming MP3 paths are required.')

  const crossfadeMs = Number(options.crossfadeMs ?? DEFAULT_AUTOMIX.crossfadeMs)
  const preRollMs = Number(options.preRollMs ?? 3000)
  const bitrate = Number(options.bitrate ?? DEFAULT_AUTOMIX.bitrate)
  const smart = options.smart !== false
  const beatmatch = options.beatmatch === true
  const curve = options.curve ?? 'auto'
  if (!Number.isFinite(crossfadeMs) || crossfadeMs < 500 || crossfadeMs > 30_000) throw new Error('--crossfade-ms must be between 500 and 30000.')
  if (!Number.isFinite(preRollMs) || preRollMs < 0 || preRollMs > 30_000) throw new Error('--pre-roll-ms must be between 0 and 30000.')
  if (!Number.isSafeInteger(bitrate) || bitrate < 96 || bitrate > 320) throw new Error('--bitrate must be an integer from 96 to 320 kbps.')
  if (!['auto', 'equal-power', 'equal-gain'].includes(curve)) throw new Error('--curve must be auto, equal-power, or equal-gain.')
  if (beatmatch && !getSongBpmStatus().configured) {
    throw new Error('Beatmatching needs a GetSongBPM key; set GETSONGBPM_API_KEY or LIVY_GETSONGBPM_API_KEY, or omit --beatmatch.')
  }

  const outputFile = chooseOutput(outgoingFile, incomingFile, options.output)
  if (path.extname(outputFile).toLowerCase() !== '.mp3') throw new Error('Output file must use the .mp3 extension.')
  if (outputFile === outgoingFile || outputFile === incomingFile) throw new Error('Output must not overwrite either input MP3.')
  const [outgoingStat, incomingStat] = await Promise.all([fsp.stat(outgoingFile), fsp.stat(incomingFile)])
  if (!outgoingStat.isFile() || !incomingStat.isFile()) throw new Error('Outgoing and incoming paths must both be files.')

  const outgoing = trackFor(outgoingFile, 'outgoing', options.outgoingTitle, options.outgoingArtist, bitrate)
  const incoming = trackFor(incomingFile, 'incoming', options.incomingTitle, options.incomingArtist, bitrate)
  const holdMs = holdWindowMs(crossfadeMs, smart)
  const landingMs = Number(DEFAULT_AUTOMIX.landingMs)
  const outgoingWindowMs = holdMs + preRollMs + FRAME_CONTEXT_MS + INPUT_SAFETY_MS
  const incomingWindowMs = Math.max(crossfadeMs, holdMs) + 2000 + landingMs + INPUT_SAFETY_MS

  const [tail, head] = await Promise.all([
    readEdge(outgoingFile, outgoingWindowMs, 'tail', outgoing),
    readEdge(incomingFile, incomingWindowMs, 'head', incoming)
  ])
  if (tail.durationMs < holdMs + preRollMs) {
    throw new Error(`Outgoing MP3 is too short for this seam; need about ${(holdMs + preRollMs) / 1000}s from its end.`)
  }
  if (head.durationMs < Math.max(crossfadeMs, holdMs) + 2000 + landingMs) {
    throw new Error(`Incoming MP3 is too short for this seam; need about ${(Math.max(crossfadeMs, holdMs) + 2000 + landingMs) / 1000}s from its start.`)
  }

  const automix = new Automix({
    effect: 'crossfade',
    curve,
    crossfadeMs,
    smart,
    minTrackMs: 0,
    holdMs: smart ? holdMs - 100 : undefined,
    beatAlign: beatmatch,
    beatmatch,
    bitrate,
    dj: { ...DEFAULT_AUTOMIX.dj, enabled: false }
  })
  const rendered: any[] = []
  for (const frame of tail.frames) rendered.push(...(await automix.push([frame])))
  for (const frame of head.frames) rendered.push(...(await automix.push([frame])))
  rendered.push(...(await automix.flush('cli')))

  const firstMixed = rendered.findIndex((frame) => frame.track?.automix === true)
  let lastMixed = -1
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    if (rendered[index].track?.automix === true) {
      lastMixed = index
      break
    }
  }
  if (!automix.info().last || firstMixed < 0 || lastMixed < firstMixed) {
    throw new Error('Automix could not render this pair. Try longer MP3s, or use files with valid MPEG audio frames.')
  }

  let start = firstMixed
  let preRoll = 0
  while (start > 0 && preRoll < preRollMs) {
    start -= 1
    preRoll += rendered[start].ms
  }
  const clip = rendered.slice(start, lastMixed + 1)
  if (clip.some((frame) => !['outgoing', 'incoming'].includes(frame.track?.id))) {
    throw new Error('Automix returned frames outside the outgoing-to-incoming transition.')
  }
  const bytes = Buffer.concat(clip.map((frame) => frame.data))
  await fsp.mkdir(path.dirname(outputFile), { recursive: true })
  await fsp.writeFile(outputFile, bytes)

  return {
    output: outputFile,
    bytes: bytes.length,
    durationMs: Math.round(clip.reduce((sum, frame) => sum + frame.ms, 0)),
    outgoingWindowMs: Math.round(tail.durationMs),
    incomingWindowMs: Math.round(head.durationMs),
    preRollMs: Math.round(preRoll),
    report: automix.info().last
  }
}

export function parseAutomixMp3Args(argv: string[]) {
  const positional: string[] = []
  const options: Record<string, any> = {}
  const values: Record<string, string> = {
    '-o': 'output',
    '--output': 'output',
    '--outgoing-title': 'outgoingTitle',
    '--outgoing-artist': 'outgoingArtist',
    '--incoming-title': 'incomingTitle',
    '--incoming-artist': 'incomingArtist',
    '--crossfade-ms': 'crossfadeMs',
    '--pre-roll-ms': 'preRollMs',
    '--bitrate': 'bitrate',
    '--curve': 'curve'
  }
  const args = argv[0] === '--' ? argv.slice(1) : argv
  let help = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (arg === '--fixed') {
      options.smart = false
      continue
    }
    if (arg === '--beatmatch') {
      options.beatmatch = true
      continue
    }
    if (arg === '--no-beatmatch') {
      options.beatmatch = false
      continue
    }
    const key = values[arg]
    if (key) {
      const value = args[++index]
      if (value == null || value.startsWith('--')) throw new Error(`${arg} requires a value.`)
      options[key] = ['crossfadeMs', 'preRollMs', 'bitrate'].includes(key) ? Number(value) : value
      continue
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    positional.push(arg)
  }
  if (help) return { help: true as const }
  if (positional.length !== 2) throw new Error('Expected an outgoing MP3 followed by an incoming MP3.')
  return { help: false as const, options: { ...options, outgoing: positional[0], incoming: positional[1] } as AutomixMp3Options }
}

export const AUTOMIX_MP3_USAGE = `Usage: bun run automix:mp3 -- <outgoing.mp3> <incoming.mp3> [options]

Render a short MP3 transition from the outgoing file's END into the incoming file's START.
The output contains only the outgoing pre-roll and the rendered seam (not either full song).

Options:
  -o, --output <file.mp3>     Output path (default: <outgoing>-to-<incoming>-transition.mp3)
  --crossfade-ms <number>     Requested blend length (default: ${DEFAULT_AUTOMIX.crossfadeMs})
  --pre-roll-ms <number>      Outgoing audio before the blend (default: 3000)
  --fixed                     Use the requested blend length without smart timing
  --curve <name>              auto, equal-power, or equal-gain
  --bitrate <kbps>            Output bitrate from 96 to 320 (default: ${DEFAULT_AUTOMIX.bitrate})
  --beatmatch                 Use GetSongBPM (requires an API key; metadata options can improve matching)
  --outgoing-title <title>    Title used for GetSongBPM lookup
  --outgoing-artist <artist>  Artist used for GetSongBPM lookup
  --incoming-title <title>    Title used for GetSongBPM lookup
  --incoming-artist <artist>  Artist used for GetSongBPM lookup
  -h, --help                  Show this help

Example:
  bun run automix:mp3 -- end-of-track.mp3 next-track.mp3 -o transition.mp3
`
