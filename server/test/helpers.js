/**
 * Shared test kit.
 *
 * Every test in this suite is hermetic: no network, no real TTS, no shared
 * database, no fixed sleeps. Audio is synthesised here so the DSP and automix
 * tests know exactly what the answer should be.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRadioServer } from '../src/index.js'
import { buildSilence } from '../src/util/mp3.js'
import { encodeMp3 } from '../src/core/automix.js'
import { configureLogging, resetLogging } from '../src/util/logger.js'

// Hermetic: no test reaches foreverjukebox.com. A test that wants the API
// points a client at a local stub instead.
process.env.LIVY_FJ_API ??= 'off'

/** Quiet by default; set TEST_LOGS=debug to watch a run. */
export function quietLogs(level = process.env.TEST_LOGS ?? 'error') {
  configureLogging({ level, color: false, buffer: 50, file: { enabled: false } })
}
export { resetLogging }

const created = new Set()

/** Temp directory removed when the process exits. */
export function tmpdir(prefix = 'livy-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  created.add(dir)
  return dir
}

process.on('exit', () => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true })
})

/** Write `count` playable (silent) MP3s into `dir` for the local source. */
export function makeMedia(dir, { count = 3, ms = 6000, artist = 'Test Artist' } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const names = []
  for (let i = 0; i < count; i += 1) {
    const name = `${artist} - Track ${i + 1}.mp3`
    fs.writeFileSync(path.join(dir, name), Buffer.concat(buildSilence(ms).frames))
    names.push(name)
  }
  return names
}

/** Boot a whole node with hermetic defaults. `overrides` are deep-ish merged. */
export async function boot(overrides = {}) {
  const dir = overrides._dir ?? tmpdir()
  const mediaDir = overrides.sources?.mediaDir ?? path.join(dir, 'media')
  fs.mkdirSync(mediaDir, { recursive: true })

  return createRadioServer({
    server: { host: '127.0.0.1', port: 0, password: '', cors: '*' },
    logging: { level: process.env.TEST_LOGS ?? 'error', color: false, buffer: 100, file: { enabled: false } },
    web: { enabled: false, dir: path.join(dir, 'no-web') },
    plugins: { enabled: false, dir: path.join(dir, 'no-plugins') },
    // Even with the store off, credentials live beside its path; keep that
    // inside the test's temp directory so a developer's real owner.auth.json
    // can never leak into a test run.
    store: { enabled: false, file: path.join(dir, 'livy.db') },
    tts: { enabled: false },
    relay: { metaint: 4000 },
    ...overrides,
    sources: { defaultSearch: 'local', hiRes: false, liveFallback: false, mediaDir, ...(overrides.sources ?? {}) },
    stationDefaults: {
      bufferAheadMs: 3000,
      burstMs: 300,
      shuffle: false,
      loop: true,
      trackLimit: 10,
      automix: { enabled: false },
      ...(overrides.stationDefaults ?? {})
    }
  })
}

/** `await api(base, '/api/v1/setup')` → parsed JSON plus the status code. */
export async function api(base, url, { method = 'GET', body, key, raw = false } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'x-owner-key': key } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  if (raw) return res
  const payload = await res.json().catch(() => ({}))
  return Object.assign(payload, { _status: res.status })
}

/** Poll until `fn()` is truthy — never a fixed sleep. */
// Stations are paced in real time, and the suite runs several nodes at once
// on whatever CPU it is given: a station that takes four seconds to reach
// the air on a laptop can take twelve in CI. Waiting longer costs nothing
// when the condition is met early, which it almost always is.
export async function waitFor(fn, { timeout = 20_000, interval = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

/** Resolve on the next `event`, or reject on timeout. */
export function waitEvent(emitter, event, { timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler)
      reject(new Error(`timed out waiting for "${event}"`))
    }, timeout)
    const handler = (...args) => {
      clearTimeout(timer)
      resolve(args.length > 1 ? args : args[0])
    }
    emitter.once(event, handler)
  })
}

/* ------------------------------------------------------------------ *
 * Synthetic audio
 * ------------------------------------------------------------------ */

/** Stereo sine, optionally amplitude-modulated — deterministic test material. */
export function tone({ seconds = 2, freq = 220, sampleRate = 44100, gain = 0.4 } = {}) {
  const n = Math.round(seconds * sampleRate)
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  for (let i = 0; i < n; i += 1) {
    const v = Math.sin((2 * Math.PI * freq * i) / sampleRate) * gain
    left[i] = v
    right[i] = v
  }
  return { left, right, sampleRate, length: n }
}

/**
 * A loop with an unmistakable beat: a kick-ish decaying sine on every beat
 * over a quiet bed, so onset detection and tempo estimation have something
 * real to find.
 */
export function beatLoop({ bpm = 120, seconds = 8, sampleRate = 44100, freq = 180, gain = 0.5 } = {}) {
  const n = Math.round(seconds * sampleRate)
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  const period = Math.round((60 / bpm) * sampleRate)

  for (let i = 0; i < n; i += 1) {
    const bed = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.05
    const intoBeat = i % period
    const env = Math.exp(-intoBeat / (sampleRate * 0.045))
    const click = Math.sin((2 * Math.PI * 60 * intoBeat) / sampleRate) * env * gain
    const noise = (((i * 1103515245 + 12345) >>> 16) % 1000) / 1000 - 0.5
    const v = click + bed + noise * 0.01 * env
    left[i] = v
    right[i] = v
  }
  return { left, right, sampleRate, length: n, bpm, period }
}

/** Encode synthetic audio to MP3 frames the station/automix path can eat. */
export async function toMp3(audio, bitrate = 128) {
  return encodeMp3({ left: audio.left, right: audio.right, sampleRate: audio.sampleRate, bitrate })
}

/** Frame records (`{ data, ms, track }`) as the reader hands them to automix. */
export function framesFrom(buffer, track, { sampleRate = 44100 } = {}) {
  const frames = []
  const frameMs = (1152 / sampleRate) * 1000
  const size = 418 // 128 kbps @ 44.1 kHz — close enough for pacing maths
  for (let at = 0; at < buffer.length; at += size) {
    frames.push({ data: buffer.subarray(at, Math.min(at + size, buffer.length)), ms: frameMs, track })
  }
  return frames
}
