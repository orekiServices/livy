/**
 * The parent half of the voice worker: a supervisor.
 *
 * A worker thread only helps if it cannot hurt, so this owns all the ways
 * the arrangement can go wrong:
 *
 *   • **It is optional.** No worker, a worker that will not start, a worker
 *     that dies — every path ends with the phrase being rendered inline by
 *     the node's own TTS engine. The listener always gets the bulletin.
 *   • **It is bounded.** One task at a time, a short queue, a hard timeout
 *     per task. A worker that misses its deadline is terminated and replaced,
 *     not waited on.
 *   • **It is lazy and it lets go.** The thread starts on the first bulletin
 *     and is `unref`'d, so it never holds the process open, and it is torn
 *     down when the plugin unloads.
 *   • **It stays out of the audio path.** The worker only writes into the
 *     TTS cache; the station still asks the engine for the phrase, and by
 *     then the file is simply there.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const WORKER_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'voice-worker.ts')

export class VoicePool {
  declare endpoint: any
  declare log: any
  declare maxQueue: any
  declare maxRestarts: any
  declare stats: any
  declare timeoutMs: any
  declare tts: any

  #worker = null
  #retiring = new WeakSet()
  #pending = new Map()
  #nextId = 1
  #restarts = 0
  #broken = false

  /**
   * @param {object} options
   * @param {object} options.tts          the node's TTS engine (the fallback)
   * @param {Function} [options.log]      where to report trouble
   * @param {number} [options.timeoutMs]  per-task deadline
   * @param {number} [options.maxQueue]   tasks waiting before we stop trying
   * @param {number} [options.maxRestarts] give up on the worker after this
   * @param {string} [options.endpoint]   override the provider (tests)
   */
  constructor({ tts, log = () => {}, timeoutMs = 20_000, maxQueue = 4, maxRestarts = 3, endpoint = null }: any = {}) {
    this.tts = tts
    this.log = log
    this.timeoutMs = timeoutMs
    this.maxQueue = maxQueue
    this.maxRestarts = maxRestarts
    this.endpoint = endpoint
    this.stats = { rendered: 0, cached: 0, fallbacks: 0, failures: 0, timeouts: 0, restarts: 0 }
  }

  /** True when the worker is up and taking work. */
  get available() {
    return Boolean(this.#worker) && !this.#broken
  }

  #start() {
    if (this.#worker || this.#broken) return this.#worker

    try {
      const worker = new Worker(WORKER_FILE, {
        workerData: this.endpoint ? { endpoint: this.endpoint } : {},
        // A voice thread must never be the reason a node cannot exit.
        stdout: true,
        stderr: true
      })
      worker.unref()

      worker.on('message', (message) => {
        const task = this.#pending.get(message?.id)
        if (!task) return
        this.#pending.delete(message.id)
        clearTimeout(task.timer)
        if (message.ok) {
          if (message.cached) this.stats.cached += 1
          else this.stats.rendered += 1
          task.resolve(message)
        } else {
          this.stats.failures += 1
          task.reject(new Error(message.error ?? 'render failed'))
        }
      })

      worker.on('error', (error) => this.#collapse(`worker error: ${error.message}`))
      worker.on('exit', (code) => {
        // A thread we terminated on purpose has already been accounted for;
        // reporting its exit again would count one incident twice.
        if (this.#retiring.has(worker)) return
        if (code !== 0) this.#collapse(`worker exited with code ${code}`)
        else if (this.#worker === worker) this.#worker = null
      })

      this.#worker = worker
      return worker
    } catch (error) {
      this.#broken = true
      this.log(`voice worker unavailable (${error.message}); rendering inline`)
      return null
    }
  }

  /** The worker died or misbehaved: fail everything waiting, then rebuild. */
  #collapse(reason) {
    const worker = this.#worker
    this.#worker = null
    if (worker) {
      this.#retiring.add(worker)
      worker.terminate?.().catch(() => {})
    }

    for (const [, task] of this.#pending) {
      clearTimeout(task.timer)
      task.reject(new Error(reason))
    }
    this.#pending.clear()

    this.#restarts += 1
    this.stats.restarts = this.#restarts
    if (this.#restarts > this.maxRestarts) {
      this.#broken = true
      this.log(`${reason} — giving up on the worker, bulletins will render inline`)
    } else {
      this.log(`${reason} — will start a fresh one`)
    }
  }

  /**
   * Voice a phrase, wherever is safest.
   *
   * @returns {Promise<{file: string, via: 'worker'|'inline', cached: boolean}>}
   */
  async speak(text, { language = 'vi', speed = 1 }: any = {}) {
    const inline = async (why) => {
      if (why) this.log(why)
      this.stats.fallbacks += 1
      const rendered = await this.tts.speak(text, { language, speed })
      return { file: rendered.file, via: 'inline', cached: rendered.cached === true }
    }

    if (!this.tts?.cacheDir || typeof this.tts.cachePathFor !== 'function') return inline(null)
    // The engine can be switched off entirely; then there is nothing to
    // pre-render into and the station's own fallback takes over.
    if (this.tts.provider === 'off') return inline(null)
    if (this.#broken) return inline(null)
    if (this.#pending.size >= this.maxQueue) return inline('voice worker is backed up; rendering inline')

    const worker = this.#start()
    if (!worker) return inline(null)

    const id = this.#nextId
    this.#nextId += 1

    // A bulletin is voiced in pieces and some services are far slower than
    // others, so the deadline follows the length of the script instead of
    // being a flat number that is wrong for one of them.
    const deadline = Math.min(this.timeoutMs * 6, Math.max(this.timeoutMs, 10_000 + String(text).length * 40))

    try {
      const result: any = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pending.delete(id)
          this.stats.timeouts += 1
          // A task that has run out of time is not merely late: the thread
          // is suspect, so it goes.
          this.#collapse(`voice worker timed out after ${deadline}ms`)
          reject(new Error('render timed out'))
        }, deadline)
        timer.unref?.()

        this.#pending.set(id, { resolve, reject, timer })
        // The engine owns the cache name — the worker writes exactly where
        // the station will look, with the service the node is set to.
        const provider = this.tts.provider
        worker.postMessage({
          id,
          text,
          language,
          speed,
          provider,
          voice: this.tts.voiceFor?.(provider) ?? null,
          file: this.tts.cachePathFor(text, { language, speed, provider }),
          cacheDir: this.tts.cacheDir
        })
      })

      return { file: result.file, via: 'worker', cached: Boolean(result.cached) }
    } catch (error) {
      return inline(`voice worker failed (${error.message}); rendering inline`)
    }
  }

  /** Stop the thread. Safe to call twice, and to call when never started. */
  async close() {
    const worker = this.#worker
    this.#worker = null
    if (worker) this.#retiring.add(worker)
    for (const [, task] of this.#pending) {
      clearTimeout(task.timer)
      task.reject(new Error('shutting down'))
    }
    this.#pending.clear()
    if (worker) await worker.terminate().catch(() => {})
  }
}

export default VoicePool
