/**
 * The bulletin's voice, rendered off the event loop.
 *
 * Voicing a six-story Vietnamese bulletin is ~1,600 characters, which the
 * provider serves as a dozen separate MP3s. That is a dozen sockets, a dozen
 * buffers and a concat — all of it on the same thread that is supposed to be
 * releasing an MP3 frame every 26 ms. It usually gets away with it; under
 * load it does not, and a station that stutters while reading the news is
 * worse than one that reads no news.
 *
 * So the work happens in a worker thread. This file is the worker: it takes
 * a phrase, fetches the pieces, stitches them and writes the file the TTS
 * cache expects. It holds no state between tasks, keeps nothing in memory
 * after posting a result, and never touches the station.
 *
 * Everything about it is bounded, because a worker that can hang is worse
 * than no worker:
 *
 *   • the text is capped before a single request is made;
 *   • every fetch has its own timeout *and* the whole task has one;
 *   • the number of chunks in flight is fixed by the provider itself;
 *   • the file is written to a temporary name and renamed, so a killed
 *     worker can never leave a half-written clip in the cache;
 *   • anything unexpected is reported back as a failure, not thrown into
 *     the void — the parent then renders inline and the listener hears the
 *     bulletin anyway.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

import { PROVIDERS } from '../../src/tts/providers.ts'

/** Hard limits. These are the safety net, not the configuration. */
export const LIMITS = {
  maxCharacters: 20_000,
  fetchTimeoutMs: 8000
}

/**
 * Tests point this at a local server instead of the real one; nothing else
 * uses it.
 */
const endpoint = workerData?.endpoint ?? null

/**
 * Render one phrase into the file the parent named.
 *
 * The parent owns the cache name (the engine decides it, and the worker
 * must not have a second opinion), and the provider modules own the actual
 * speech — the same code the engine runs inline, so a clip rendered here is
 * identical to one rendered there.
 */
export async function render({ text, language = 'vi', speed = 1, provider = 'google', voice = null, file, cacheDir }) {
  if (!file) throw new Error('no destination file')
  const phrase = String(text ?? '').trim()
  if (!phrase) throw new Error('nothing to say')
  if (phrase.length > LIMITS.maxCharacters) throw new Error(`text too long (${phrase.length} > ${LIMITS.maxCharacters})`)

  const engine = PROVIDERS[provider]
  if (!engine) throw new Error(`unknown speech provider "${provider}"`)

  // Somebody may have rendered it already — a bulletin repeated at 17:30 and
  // 18:00, the same ident every hour.
  try {
    const stat = await fs.stat(file)
    if (stat.size > 1024) return { file, cached: true, bytes: stat.size, chunks: 0 }
  } catch {
    /* not rendered yet */
  }

  const audio = await engine.speak({
    text: phrase,
    language,
    speed,
    settings: { ...(voice ? { voice } : {}), ...(endpoint ? { endpoint } : {}) },
    timeoutMs: LIMITS.fetchTimeoutMs
  })
  if (!audio || audio.length < 512) throw new Error('the provider returned nothing usable')

  // Write, then rename: a reader can only ever see a complete file, even if
  // this worker is killed mid-task.
  const temporary = `${file}.${process.pid}.${Date.now()}.part`
  await fs.mkdir(cacheDir ?? path.dirname(file), { recursive: true })
  await fs.writeFile(temporary, audio)
  await fs.rename(temporary, file)

  return { file, cached: false, bytes: audio.length }
}

/* --------------------------- worker plumbing --------------------------- */

if (parentPort) {
  parentPort.on('message', async (task) => {
    if (!task || typeof task !== 'object' || task.id == null) return
    try {
      const result = await render(task)
      parentPort.postMessage({ id: task.id, ok: true, ...result })
    } catch (error) {
      // Failure is a message, never an exception: the parent has a fallback
      // and a dead worker would only make the bulletin late.
      parentPort.postMessage({ id: task.id, ok: false, error: error?.message ?? String(error) })
    }
  })
}

export default render
