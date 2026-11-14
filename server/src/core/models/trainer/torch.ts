/**
 * PyTorch training, when Python is there.
 *
 * The policy is a handful of matrices; `network.js` trains it exactly, in
 * JavaScript, and that path never goes away. This one runs the same network —
 * same initialisation, same loss, same Adam — in PyTorch (`python/train.py`)
 * when the host has an interpreter with torch installed. What that buys:
 *
 *   • **Speed.** One matrix multiply per layer per step instead of one row at
 *     a time, over batches sized for BLAS, on as many threads as the process
 *     is given — and on a GPU, which the JavaScript path cannot use at all.
 *   • **A model that can grow.** The next policy will not be 500 parameters.
 *   • **One definition.** Weights come back in the `.bin` layout and are
 *     loaded into a real `Network`, so the accuracy the trainer reports is
 *     measured by the code that mixes the music. There is no second inference
 *     path, and no Python at request time.
 *
 * The worker is a long-lived child process speaking one JSON line per request
 * (`train.py --serve`): importing torch costs about a second, and paying that
 * per training run would cost more than the training. If the interpreter is
 * missing, torch will not import, or the child dies, every call answers
 * `{available: false, reason}` and the caller trains in JavaScript — a node
 * without Python is a node, not a broken install.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import createLogger from '../../../util/logger.ts'
import { Network } from '../network.ts'

const log = createLogger('dj-torch')

const here = path.dirname(fileURLToPath(import.meta.url))
/** `server/` — the directory with `python/train.py` and a possible `.venv`. */
const serverRoot = path.resolve(here, '../../../..')
const SCRIPT = path.join(serverRoot, 'python', 'train.py')

/** How long a training request may take before the worker is considered hung. */
const TRAIN_TIMEOUT_MS = Number(process.env.LIVY_TORCH_TIMEOUT_MS) || 120_000
const PROBE_TIMEOUT_MS = 30_000
/** After a failure, do not retry for this long: a node without torch should
 *  not spawn an interpreter on every training run. */
const RETRY_AFTER_MS = 120_000
/** Steps per candidate. Past this the network has learned what it will. */
const MAX_STEPS = Number(process.env.LIVY_TORCH_MAX_STEPS) || 1200

/**
 * Which interpreter to try, in order.
 *
 * A virtualenv inside the server is the documented install, so it comes first;
 * `LIVY_PYTHON` overrides everything (a host with several Pythons, or a test
 * that wants to prove the fallback); bare names are left to `PATH`.
 */
export function pythonCandidates(env = process.env) {
  const list = []
  if (env.LIVY_PYTHON && env.LIVY_PYTHON !== 'off') list.push(env.LIVY_PYTHON)
  const venvs = [path.join(serverRoot, '.venv'), path.join(serverRoot, 'venv'), path.resolve(serverRoot, '..', '.venv'), path.resolve(serverRoot, '..', 'venv')]
  for (const venv of venvs) {
    for (const name of ['python3', 'python']) {
      const candidate = path.join(venv, 'bin', name)
      if (fs.existsSync(candidate)) list.push(candidate)
    }
    for (const name of ['python.exe', 'python']) {
      const candidate = path.join(venv, 'Scripts', name)
      if (fs.existsSync(candidate)) list.push(candidate)
    }
  }
  if (env.LIVY_PYTHON !== 'off') list.push('python3', 'python')
  return [...new Set(list)]
}

/* ------------------------------- the worker ------------------------------ */

let worker = null
let workerPath = null
let sequence = 0
const waiting = new Map()
let chain = Promise.resolve()
let lastFailure = null
let failureAt = 0
let starting = null

function killWorker(reason) {
  const child = worker
  worker = null
  workerPath = null
  if (!child) return
  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
  for (const [id, entry] of waiting) {
    waiting.delete(id)
    clearTimeout(entry.timer)
    entry.reject(new Error(reason))
  }
}

function startWorker(python) {
  const child = spawn(python, [SCRIPT, '--serve'], { cwd: serverRoot, stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
  worker = child
  workerPath = python
  // The worker is a service, not a reason to stay alive: a CLI or a test that
  // asked one question must be able to exit. An in-flight request is held open
  // by its own timer instead.
  child.unref()
  ;(child.stdin as any)?.unref?.()
  ;(child.stdout as any)?.unref?.()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (!line) continue
      let message = null
      try {
        message = JSON.parse(line)
      } catch {
        log.warn(`torch worker said something that is not JSON: ${line.slice(0, 120)}`)
      }
      if (!message) continue
      const entry = waiting.get(message.id)
      if (entry) {
        waiting.delete(message.id)
        clearTimeout(entry.timer)
        entry.resolve(message)
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) log.debug(`torch worker: ${text.slice(0, 400)}`)
  })
  child.on('error', (error) => {
    lastFailure = error.message
    failureAt = Date.now()
    killWorker(`torch worker failed to start (${error.message})`)
  })
  child.on('exit', (code, signal) => {
    if (worker === child) {
      lastFailure = `torch worker exited (${signal ?? code})`
      failureAt = Date.now()
      killWorker(lastFailure)
    }
  })
  return child
}

/** One request, written whole, answered by id. Requests are serialised so a
 *  multi-megabyte dataset cannot interleave with the next one on the pipe. */
function ask(request, timeoutMs) {
  const run = async () => {
    if (!worker) throw new Error('no torch worker')
    const id = ++sequence
    const line = `${JSON.stringify({ ...request, id })}\n`
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id)
        killWorker(`torch worker timed out after ${Math.round(timeoutMs / 1000)} s`)
        reject(new Error(`torch training timed out after ${Math.round(timeoutMs / 1000)} s`))
      }, timeoutMs)
      waiting.set(id, { resolve, reject, timer })
      try {
        worker.stdin.write(line)
      } catch (error) {
        clearTimeout(timer)
        waiting.delete(id)
        killWorker(`could not write to the torch worker (${error.message})`)
        reject(error)
      }
    })
  }
  const next: Promise<any> = chain.then(run, run)
  chain = next.then(() => undefined, () => undefined)
  return next
}

/**
 * Start a worker on the first interpreter that answers, and remember what it
 * said. The probe runs *inside* the worker, so the import that costs a second
 * is paid once for the probe and the training that follows.
 */
async function ensureWorker(env = process.env) {
  if (worker) return true
  if (starting) return starting
  if (lastFailure && Date.now() - failureAt < RETRY_AFTER_MS) return false
  if (!fs.existsSync(SCRIPT)) {
    lastFailure = `no ${path.relative(serverRoot, SCRIPT)}`
    failureAt = Date.now()
    return false
  }

  starting = (async () => {
    const reasons = []
    for (const python of pythonCandidates(env)) {
      if (python.includes(path.sep) && !fs.existsSync(python)) continue
      try {
        startWorker(python)
        const answer: any = await ask({ kind: 'probe' }, PROBE_TIMEOUT_MS)
        if (answer.ok) {
          cache.probe = { available: true, interpreter: python, ...answer }
          cache.at = Date.now()
          return true
        }
        reasons.push(`${python}: ${answer.reason ?? 'refused'}`)
      } catch (error) {
        reasons.push(`${python}: ${error.message}`)
      }
      killWorker('probe failed')
    }
    lastFailure = reasons.slice(0, 3).join('; ') || 'no python interpreter found'
    failureAt = Date.now()
    return false
  })().finally(() => {
    starting = null
  })
  return starting
}

/* -------------------------------- the API -------------------------------- */

const cache = { probe: null, at: 0 }

/** What to tell an owner whose node has no torch. */
const INSTALL_HINT = 'python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt'

/**
 * Can this node train with PyTorch?
 *
 * Cached: the answer changes when someone installs a venv, not between two
 * training runs, and finding it out costs an interpreter start.
 */
export async function torchStatus({ fresh = false, env = process.env, wait = true }: any = {}) {
  if (env.LIVY_TRAIN_BACKEND === 'js') return { available: false, reason: 'LIVY_TRAIN_BACKEND=js', interpreter: null }
  if (env.LIVY_PYTHON === 'off') return { available: false, reason: 'LIVY_PYTHON=off', interpreter: null }
  if (!fresh && cache.probe && Date.now() - cache.at < 60_000) return cache.probe
  if (fresh) {
    stopTorch()
  }
  // `wait: false` is for the console: starting an interpreter costs a second,
  // and a page that asks "is torch here?" should not hang for it. The answer
  // is `available: null` (probing) on the first request and the real one on the
  // next poll, which reads the cache this call warmed.
  if (!wait) {
    if (lastFailure && Date.now() - failureAt < RETRY_AFTER_MS) {
      return { available: false, reason: lastFailure, interpreter: null, install: INSTALL_HINT, backend: 'js' }
    }
    const probing = Boolean(starting)
    ensureWorker(env).catch(() => {})
    return {
      available: null,
      probing: true,
      reason: probing ? 'the interpreter is still starting' : 'probing the interpreter',
      interpreter: null,
      backend: 'auto'
    }
  }
  const ready = await ensureWorker(env)
  if (ready && cache.probe) return { ...cache.probe, backend: 'torch' }
  return {
    available: false,
    reason: lastFailure ?? 'no python interpreter found',
    interpreter: null,
    install: INSTALL_HINT,
    backend: 'js'
  }
}

/** Test seam, and the path a crashed worker takes back to life. */
export function stopTorch() {
  killWorker('torch worker stopped')
  cache.probe = null
  cache.at = 0
  lastFailure = null
  failureAt = 0
}

/** Warm the worker before the first training run (boot, or the console). */
export async function warmTorch() {
  return torchStatus()
}

/** Why the last call gave up — for the owner API and the logs. */
export function torchFailure() {
  return lastFailure ? { reason: lastFailure, at: failureAt } : null
}

/**
 * Should this training run go to PyTorch?
 *
 * Not "always, when installed". The model is 500 parameters, and on a CPU a
 * Python optimiser step costs about half a millisecond in kernel dispatch no
 * matter how small the matrices are — for a few hundred seams the JavaScript
 * trainer, which loops in the same process, is genuinely quicker. PyTorch wins
 * when the arithmetic finally outweighs the dispatch: a GPU, a much wider
 * model, or a log big enough that batching rows into BLAS calls is the whole
 * difference between seconds and minutes.
 *
 * `auto` therefore asks the workload first and the interpreter second, and
 * reports which way it went: a console can then say *why* the fast path was
 * not taken instead of silently not taking it.
 */
export function planTorch({ backend = 'auto', rows = 0, parameters = 0, device = 'cpu' }: any = {}) {
  if (backend === 'js') return { use: false, reason: 'the JavaScript trainer was asked for' }
  if (device && device !== 'cpu') return { use: true, reason: `PyTorch on ${device}` }
  if (rows >= 4000) return { use: true, reason: `${rows} rows — batching them is worth the interpreter` }
  if (parameters >= 5000) return { use: true, reason: `${parameters} parameters — a wider model than the JS loop runs well` }
  if (backend === 'torch') return { use: true, reason: 'PyTorch was asked for' }
  return { use: false, reason: `JavaScript is faster for ${rows} rows and ${parameters} parameters on this CPU` }
}

/** The backend the trainer should use: `auto` (torch when it works), `js`, `torch`. */
export function trainBackend(env = process.env) {
  const asked = String(env.LIVY_TRAIN_BACKEND ?? 'auto').toLowerCase()
  return asked === 'js' || asked === 'torch' ? asked : 'auto'
}

/**
 * Train one candidate per `jobs` entry, in a single round trip.
 *
 * @param {object} options
 * @param {Array<{x: number[], y: number[]}>} options.train the labelled pairs
 * @param {Array<{shape: number[], seed?: number}>} options.jobs
 * @param {number} options.epochs
 * @param {number} options.learningRate
 * @param {number} [options.batch] rows per optimiser step
 * @param {string} [options.device] `auto`, `cpu`, `cuda`, `mps`
 * @returns {Promise<object>} `{available, results?: [{network, ms, steps, loss}], …}`
 */
export async function trainWithTorch({ train = [], jobs = [], epochs = 120, learningRate = 0.01, batch = 0, l2 = 1e-4, device = 'auto', threads = 0, maxSteps = MAX_STEPS }: any = {}) {
  if (!jobs.length) return { available: false, reason: 'no candidates' }
  if (train.length < 8) return { available: false, reason: 'too few rows for the interpreter round trip' }

  const status = await torchStatus()
  if (!status.available) return { available: false, reason: status.reason }

  const rows = train.length
  // One optimiser step is a handful of matrix multiplies plus a few dozen
  // kernel dispatches, and the dispatches do not care how many rows are in the
  // batch. Sizing the batch by the data — rather than the JavaScript trainer's
  // 16 rows — is what turns a run into a fraction of a second; the step
  // ceiling keeps a 20,000-row log from turning epochs into minutes.
  const asked = batch > 0 ? batch : Number(process.env.LIVY_TORCH_BATCH) || 0
  const perStep = asked > 0 ? Math.min(rows, Math.max(1, asked)) : Math.min(1024, Math.max(16, Math.round(rows / 8)))

  const request = {
    kind: 'train',
    x: train.map((row) => row.x),
    y: train.map((row) => row.y),
    // Recency weights (see `sampleWeight`): the same rows the JavaScript
    // trainer would weight, so both backends fit the same objective.
    w: train.map((row) => (Number.isFinite(row.w) ? row.w : 1)),
    epochs,
    learningRate,
    batch: perStep,
    maxSteps,
    l2,
    device,
    threads,
    jobs: jobs.map((job) => ({ shape: job.shape, seed: job.seed ?? 0x5eed }))
  }

  const started = Date.now()
  let answer
  try {
    answer = await ask(request, TRAIN_TIMEOUT_MS)
  } catch (error) {
    lastFailure = error.message
    failureAt = Date.now()
    log.warn(`PyTorch training failed (${error.message}); falling back to the JavaScript trainer`)
    return { available: false, reason: error.message }
  }
  if (!answer.ok) {
    lastFailure = answer.reason ?? 'unknown'
    failureAt = Date.now()
    return { available: false, reason: answer.reason ?? 'training failed' }
  }

  const results = []
  for (const result of answer.results ?? []) {
    try {
      const network = new Network(result.shape)
      // The format's layer order is the one the script exports, so the weights
      // are loaded, not reinterpreted.
      network.load({ weights: result.weights, biases: result.biases })
      results.push({ network, ...result })
    } catch (error) {
      log.warn(`PyTorch returned weights this build cannot use (${error.message})`)
      return { available: false, reason: error.message }
    }
  }
  return {
    available: true,
    results,
    device: answer.device,
    torch: answer.torch,
    interpreter: status.interpreter,
    batch: answer.batch,
    ms: Date.now() - started,
    trainMs: answer.ms
  }
}

export { SCRIPT as TORCH_SCRIPT, serverRoot as SERVER_ROOT }
