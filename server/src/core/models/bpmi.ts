/**
 * BPMi — Livy's CPU-only, seam-supervised tempo model.
 *
 * A BPMi observation is one side of a real seam: the local DSP candidate
 * profile is the input, and a matched track-tempo observation is the label.
 * The training reader deliberately scans the node-wide seam store and log;
 * neither station IDs nor audio-source names are filters. Validation keeps all
 * observations for a recording in one group, then the final fit includes every
 * eligible observation so each source and station contributes to the model.
 *
 * BPMi never uses the DJ policy's GPU/PyTorch backend. It is a small pure-JS
 * network for CPU inference and training. GetSongBPM remains the authoritative
 * beatmatch source in Automix; BPMi runs alongside it for local estimates,
 * quality measurement, and future offline use.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { tempoCandidates } from '../dsp/tempo.ts'
import { Network } from './network.ts'
import { packSafetensors, unpackSafetensors } from './safetensors.ts'
import { readAllSeams } from './trainer/dataset.ts'
import { writableModelDir } from './storage/local.ts'

export const BPMI_NAME = 'BPMi'
export const BPMI_FORMAT = 'livy-bpmi'
export const BPMI_VERSION = '1'
export const BPMI_MAX_CANDIDATES = 8
export const BPMI_MIN_OBSERVATIONS = 24
export const BPMI_MIN_TRACKS = 8
export const BPMI_FILE = 'bpmi.safetensors'
const MIN_BPM = 40
const MAX_BPM = 220
const TARGET_SIGMA = 0.055

export const BPMI_FEATURES = Object.freeze([
  ...Array.from({ length: BPMI_MAX_CANDIDATES }, (_, index) => [
    `candidate${index + 1}.logBpm`,
    `candidate${index + 1}.strength`,
    `candidate${index + 1}.scalarAnchor`
  ]).flat(),
  'signal.confidence',
  'signal.scalarConfidence',
  'candidate.count'
])

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
const validTempo = (value: unknown) => {
  const bpm = Number(value)
  return Number.isFinite(bpm) && bpm >= MIN_BPM && bpm <= MAX_BPM ? bpm : 0
}

function compactTrack(track: any) {
  if (!track || typeof track !== 'object') return null
  return {
    id: track.id == null ? null : String(track.id),
    title: track.title == null ? null : String(track.title),
    artist: track.artist == null ? null : String(track.artist),
    source: track.source == null ? null : String(track.source)
  }
}

/**
 * Build the compact, fixed-size local tempo profile stored with a seam.
 * This is CPU-only DSP; it does not call GetSongBPM or a model backend.
 */
export function makeBpmProfile(mono: Float32Array, sampleRate: number, {
  confidence = 0,
  scalarBpm = 0,
  scalarConfidence = confidence,
  track = null,
  referenceBpm = 0,
  referenceSource = null,
  labelConfidence = 0
}: any = {}) {
  const candidates: any[] = tempoCandidates(mono, sampleRate, {
    minBpm: MIN_BPM,
    maxBpm: MAX_BPM,
    limit: BPMI_MAX_CANDIDATES
  }).map(({ bpm, strength }) => ({ bpm: Number(bpm), strength: clamp(Number(strength) || 0, 0, 1), scalar: false }))
  const anchor = validTempo(scalarBpm)
  const anchorConfidence = clamp(Number(scalarConfidence) || 0, 0, 1)
  if (anchor && anchorConfidence > 0) {
    const existing = candidates.find((candidate) => Math.abs(Math.log(candidate.bpm / anchor)) <= Math.log(1.015))
    if (existing) {
      existing.scalar = true
      existing.strength = Math.max(existing.strength, anchorConfidence)
    } else {
      candidates.push({ bpm: anchor, strength: anchorConfidence, scalar: true })
    }
  }
  candidates.sort((a, b) => b.strength - a.strength || Number(b.scalar) - Number(a.scalar))
  return {
    candidates: candidates.slice(0, BPMI_MAX_CANDIDATES),
    confidence: clamp(Number(confidence) || 0, 0, 1),
    scalarBpm: anchor || null,
    scalarConfidence: anchorConfidence,
    sampleRate: Math.max(0, Math.floor(Number(sampleRate) || 0)),
    windowSeconds: Number((mono.length / Math.max(1, sampleRate)).toFixed(3)),
    referenceBpm: validTempo(referenceBpm) || null,
    referenceSource: referenceSource == null ? null : String(referenceSource),
    labelConfidence: clamp(Number(labelConfidence) || 0, 0, 1),
    track: compactTrack(track)
  }
}

function profileCandidates(profile: any = {}) {
  if (!Array.isArray(profile?.candidates)) return []
  return profile.candidates.slice(0, BPMI_MAX_CANDIDATES).map((candidate: any) => ({
    bpm: validTempo(candidate?.bpm),
    strength: clamp(Number(candidate?.strength) || 0, 0, 1),
    scalar: candidate?.scalar === true
  })).filter((candidate: any) => candidate.bpm > 0)
}

const encodeBpm = (bpm: number) => {
  const range = Math.log2(MAX_BPM / MIN_BPM)
  return clamp(2 * (Math.log2(bpm / MIN_BPM) / range) - 1, -1, 1)
}

/** The input columns shared by the trainer, CPU inference and Safetensors. */
export function featuresForBpmProfile(profile: any = {}) {
  const candidates = profileCandidates(profile)
  const features = new Float32Array(BPMI_FEATURES.length)
  for (let index = 0; index < BPMI_MAX_CANDIDATES; index += 1) {
    const candidate = candidates[index]
    if (!candidate) continue
    const offset = index * 3
    features[offset] = encodeBpm(candidate.bpm)
    features[offset + 1] = candidate.strength
    features[offset + 2] = candidate.scalar ? 1 : 0
  }
  features[BPMI_MAX_CANDIDATES * 3] = clamp(Number(profile.confidence) || 0, 0, 1)
  features[BPMI_MAX_CANDIDATES * 3 + 1] = clamp(Number(profile.scalarConfidence) || 0, 0, 1)
  features[BPMI_MAX_CANDIDATES * 3 + 2] = candidates.length / BPMI_MAX_CANDIDATES
  return features
}

function normaliseName(value: unknown) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function trackKey(profile: any, record: any, side: string, index: number) {
  const track = profile?.track ?? record?.[side === 'outgoing' ? 'trackOut' : 'trackIn'] ?? null
  const title = normaliseName(track?.title)
  const artist = normaliseName(track?.artist)
  if (title && artist) return `${artist}::${title}`
  if (title) return title
  const id = String(track?.id ?? record?.[side === 'outgoing' ? 'from' : 'to'] ?? '')
  const source = String(track?.source ?? record?.[side === 'outgoing' ? 'sourceOut' : 'sourceIn'] ?? '')
  return id ? `${source}:${id}` : `unidentified:${record?.stationId ?? record?.station ?? 'node'}:${record?.at ?? index}:${side}`
}

function softTarget(candidateBpm: number, referenceBpm: number) {
  const distance = Math.abs(Math.log(candidateBpm / referenceBpm))
  return Math.exp(-0.5 * (distance / TARGET_SIGMA) ** 2)
}

/**
 * Turn every eligible side of every seam into one supervised BPMi row.
 * Outcome, station and source are deliberately not filters: tempo labels are
 * useful regardless of whether a listener later completed or skipped a seam.
 */
export function buildBpmDataset(records: any[] = []) {
  const samples: any[] = []
  const stations = new Set<string>()
  const sources = new Set<string>()
  const tracks = new Set<string>()
  let seamsWithProfiles = 0
  let uncovered = 0

  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex] ?? {}
    const profiles = record.bpmi?.profiles ?? record.bpmi ?? record.beat?.bpmi?.profiles ?? null
    if (!profiles || typeof profiles !== 'object') continue
    seamsWithProfiles += 1
    const stationId = String(record.stationId ?? record.station ?? '').trim()
    if (stationId) stations.add(stationId)

    for (const side of ['outgoing', 'incoming']) {
      const profile = profiles[side]
      const candidates = profileCandidates(profile)
      const field = side === 'outgoing' ? 'bpmOut' : 'bpmIn'
      const target = validTempo(profile?.referenceBpm ?? record[field])
      if (target && profile?.track?.source) sources.add(String(profile.track.source))
      if (!target || candidates.length === 0) {
        if (target) uncovered += 1
        continue
      }

      const y = new Float32Array(BPMI_MAX_CANDIDATES)
      const candidateBpms = new Float32Array(BPMI_MAX_CANDIDATES)
      let baseline = 0
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index]
        y[index] = softTarget(candidate.bpm, target)
        candidateBpms[index] = candidate.bpm
        if (candidate.strength > candidates[baseline].strength ||
          (candidate.strength === candidates[baseline].strength && candidate.scalar && !candidates[baseline].scalar)) baseline = index
      }
      const key = trackKey(profile, record, side, recordIndex)
      tracks.add(key)
      const labelConfidence = Number(profile.labelConfidence)
      samples.push({
        x: featuresForBpmProfile(profile),
        y,
        w: clamp(Number.isFinite(labelConfidence) && labelConfidence > 0 ? labelConfidence : 0.75, 0.1, 1),
        target,
        candidateBpms,
        candidateCount: candidates.length,
        baselineIndex: baseline,
        key,
        at: Number(record.at) || null,
        side,
        stationId: stationId || null,
        source: profile.track?.source ? String(profile.track.source) : null
      })
    }
  }

  return {
    samples,
    coverage: {
      seams: records.length,
      seamsWithProfiles,
      observations: samples.length,
      tracks: tracks.size,
      stations: stations.size,
      sources: sources.size,
      stationIds: [...stations].sort(),
      sourceNames: [...sources].sort(),
      uncovered
    }
  }
}

/** Stable group split: all copies of the same recording stay on one side. */
export function splitBpmDataset(samples: any[] = []) {
  const groups = [...new Set(samples.map((sample) => sample.key))].sort((a, b) => {
    const hash = (value: string) => {
      let state = 0x811c9dc5
      for (let i = 0; i < value.length; i += 1) state = Math.imul(state ^ value.charCodeAt(i), 0x01000193) >>> 0
      return state >>> 0
    }
    return hash(a) - hash(b) || a.localeCompare(b)
  })
  if (groups.length < 2) return { train: samples, test: [], trainTracks: groups.length, testTracks: 0 }
  const testCount = Math.max(1, Math.min(groups.length - 1, Math.floor(groups.length * 0.2)))
  const testKeys = new Set(groups.slice(0, testCount))
  const train = samples.filter((sample) => !testKeys.has(sample.key))
  const test = samples.filter((sample) => testKeys.has(sample.key))
  return { train, test, trainTracks: groups.length - testCount, testTracks: testCount }
}

/** Capacity grows with unique seam observations; the top tier stays CPU-sized. */
export function bpmIHiddenShape(observations: number) {
  if (observations >= 1_000_000) return [768, 384, 192]
  if (observations >= 500_000) return [640, 320, 160]
  if (observations >= 250_000) return [512, 256, 128]
  if (observations >= 50_000) return [256, 128, 64]
  if (observations >= 10_000) return [192, 96, 48]
  if (observations >= 2_000) return [96, 48, 24]
  if (observations >= 512) return [48, 24]
  if (observations >= 128) return [24, 12]
  return [12]
}

export function bpmIParameterCount(observations: number) {
  const widths = [BPMI_FEATURES.length, ...bpmIHiddenShape(observations), BPMI_MAX_CANDIDATES]
  let total = 0
  for (let index = 1; index < widths.length; index += 1) total += widths[index - 1] * widths[index] + widths[index]
  return total
}

export function bpmIDefaultEpochs(observations: number, { fast = false }: any = {}) {
  const full = observations < 128 ? 80 : observations < 512 ? 100 : observations < 2_000 ? 120 : observations < 10_000 ? 150 : observations < 50_000 ? 180 : observations < 250_000 ? 220 : observations < 500_000 ? 260 : observations < 1_000_000 ? 300 : 360
  return fast ? Math.max(20, Math.ceil(full * 0.35)) : full
}

function baselineIndex(profile: any) {
  const candidates = profileCandidates(profile)
  if (!candidates.length) return -1
  let best = 0
  for (let index = 1; index < candidates.length; index += 1) {
    if (candidates[index].strength > candidates[best].strength ||
      (candidates[index].strength === candidates[best].strength && candidates[index].scalar && !candidates[best].scalar)) best = index
  }
  return best
}

function bestIndex(scores: ArrayLike<number>, count: number) {
  let best = -1
  for (let index = 0; index < count; index += 1) {
    if (best < 0 || scores[index] > scores[best]) best = index
  }
  return best
}

function measure(network: any, samples: any[], { baseline = false } = {}) {
  if (!samples.length) return { observations: 0, within2Percent: 0, within5Percent: 0, within10Percent: 0, mae: null, medianAbsoluteError: null }
  let within2 = 0
  let within5 = 0
  let within10 = 0
  let absoluteError = 0
  const errors: number[] = []
  for (const sample of samples) {
    const index = baseline ? sample.baselineIndex : bestIndex(network.predict(sample.x), sample.candidateCount)
    const prediction = index >= 0 ? sample.candidateBpms[index] : 0
    const error = Math.abs(prediction - sample.target)
    const relative = error / sample.target
    if (relative <= 0.02) within2 += 1
    if (relative <= 0.05) within5 += 1
    if (relative <= 0.10) within10 += 1
    absoluteError += error
    errors.push(error)
  }
  errors.sort((a, b) => a - b)
  return {
    observations: samples.length,
    within2Percent: Number((within2 / samples.length).toFixed(4)),
    within5Percent: Number((within5 / samples.length).toFixed(4)),
    within10Percent: Number((within10 / samples.length).toFixed(4)),
    mae: Number((absoluteError / samples.length).toFixed(3)),
    medianAbsoluteError: Number((errors[Math.floor(errors.length / 2)] ?? 0).toFixed(3))
  }
}

function shuffleIndexes(length: number, seed: number) {
  const indexes = new Uint32Array(length)
  for (let index = 0; index < length; index += 1) indexes[index] = index
  let state = (seed >>> 0) || 0x5eed
  for (let index = length - 1; index > 0; index -= 1) {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    const other = state % (index + 1)
    const held = indexes[index]
    indexes[index] = indexes[other]
    indexes[other] = held
  }
  return indexes
}

async function fitEpochs(network: any, samples: any[], epochs: number, {
  seed = 0xB0B1,
  learningRate = 0.004,
  batchSize = 32,
  stepStart = 0
}: any = {}) {
  let step = stepStart
  const yieldEvery = batchSize >= 64 ? 1 : 8
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const order = shuffleIndexes(samples.length, seed + epoch * 7919)
    for (let start = 0; start < order.length; start += batchSize) {
      const batch: any[] = []
      for (let cursor = start; cursor < Math.min(start + batchSize, order.length); cursor += 1) batch.push(samples[order[cursor]])
      if (batch.length) network.train(batch, { learningRate, l2: 1e-5, step: ++step })
      if (step % yieldEvery === 0) await new Promise((resolve) => setImmediate(resolve))
    }
  }
  return step - stepStart
}

function dataFingerprint(samples: any[]) {
  const hash = createHash('sha256')
  for (const sample of samples) {
    hash.update(`${sample.key}\u0000${sample.target.toFixed(3)}\u0000`)
    for (let index = 0; index < sample.candidateCount; index += 1) hash.update(`${sample.candidateBpms[index].toFixed(3)};`)
    for (const feature of sample.x) hash.update(`${Number(feature).toFixed(5)};`)
    hash.update('\n')
  }
  return hash.digest('hex')
}

function bpmModelDir(saveDir: string | null = null) {
  return saveDir ? path.resolve(saveDir) : path.join(writableModelDir(), 'bpmi')
}

const modelCache = new Map<string, any>()

function saveCheckpoint(network: any, metadata: Record<string, string>, saveDir: string) {
  const tensors: Record<string, any> = {}
  for (let layer = 0; layer < network.weights.length; layer += 1) {
    const input = network.shape[layer]
    const output = network.shape[layer + 1]
    tensors[`weights.${layer}`] = { dtype: 'F32', shape: [input, output], data: network.weights[layer] }
    tensors[`biases.${layer}`] = { dtype: 'F32', shape: [output], data: network.biases[layer] }
  }
  const buffer = packSafetensors(tensors, {
    format: BPMI_FORMAT,
    version: BPMI_VERSION,
    model: BPMI_NAME,
    features: JSON.stringify(BPMI_FEATURES),
    shape: JSON.stringify(network.shape),
    ...metadata
  })
  fs.mkdirSync(saveDir, { recursive: true })
  const file = path.join(saveDir, BPMI_FILE)
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, buffer)
  fs.renameSync(temporary, file)
  const stat = fs.statSync(file)
  modelCache.set(file, { mtime: stat.mtimeMs, model: null })
  return { file, bytes: buffer.length, digest: createHash('sha256').update(buffer).digest('hex') }
}

/** Load/validate the latest BPMi checkpoint. A missing or corrupt file is not fatal. */
export function loadBPMi({ saveDir = null, force = false }: any = {}) {
  const dir = bpmModelDir(saveDir)
  const file = path.join(dir, BPMI_FILE)
  let stat: any
  try {
    stat = fs.statSync(file)
    if (!stat.isFile()) return null
  } catch {
    return null
  }
  const cached = modelCache.get(file)
  if (!force && cached?.mtime === stat.mtimeMs && cached.model) return cached.model

  try {
    const buffer = fs.readFileSync(file)
    const { tensors, metadata } = unpackSafetensors(buffer)
    if (metadata.format !== BPMI_FORMAT || metadata.version !== BPMI_VERSION || metadata.model !== BPMI_NAME) {
      throw new Error('BPMi checkpoint has an unsupported format or version')
    }
    let features: any
    let shape: any
    try {
      features = JSON.parse(metadata.features ?? '')
      shape = JSON.parse(metadata.shape ?? '')
    } catch {
      throw new Error('BPMi checkpoint metadata is invalid')
    }
    if (JSON.stringify(features) !== JSON.stringify(BPMI_FEATURES) || !Array.isArray(shape) || shape[0] !== BPMI_FEATURES.length || shape.at(-1) !== BPMI_MAX_CANDIDATES || shape.some((width: any) => !Number.isSafeInteger(width) || width < 1)) {
      throw new Error('BPMi checkpoint shape or feature list does not match this build')
    }
    const layers = shape.length - 1
    const weights: number[][] = []
    const biases: number[][] = []
    const expected = new Set<string>()
    for (let layer = 0; layer < layers; layer += 1) {
      const weightName = `weights.${layer}`
      const biasName = `biases.${layer}`
      expected.add(weightName)
      expected.add(biasName)
      const weight = tensors[weightName]
      const bias = tensors[biasName]
      if (!weight || !bias || weight.shape.length !== 2 || bias.shape.length !== 1 || weight.shape[0] !== shape[layer] || weight.shape[1] !== shape[layer + 1] || bias.shape[0] !== shape[layer + 1]) {
        throw new Error(`BPMi checkpoint layer ${layer} is malformed`)
      }
      weights.push(Array.from(weight.data))
      biases.push(Array.from(bias.data))
    }
    if (Object.keys(tensors).some((name) => !expected.has(name))) throw new Error('BPMi checkpoint contains unexpected tensors')
    const network = new Network(shape)
    network.load({ weights, biases })
    const parameterCount = network.parameterCount
    const model = {
      name: BPMI_NAME,
      backend: 'cpu',
      file,
      shape,
      network,
      parameters: parameterCount,
      trainedAt: Number(metadata.trainedAt) || stat.mtimeMs,
      steps: Number(metadata.steps) || 0,
      observations: Number(metadata.observations) || 0,
      tracks: Number(metadata.tracks) || 0,
      stations: Number(metadata.stations) || 0,
      sources: Number(metadata.sources) || 0,
      epochs: Number(metadata.epochs) || 0,
      allDataEpochs: Number(metadata.allDataEpochs) || 0,
      eligible: metadata.eligible === 'true',
      fingerprint: metadata.fingerprint ?? null,
      validation: JSON.parse(metadata.validation ?? '{}'),
      baseline: JSON.parse(metadata.baseline ?? '{}'),
      digest: createHash('sha256').update(buffer).digest('hex')
    }
    modelCache.set(file, { mtime: stat.mtimeMs, model })
    return model
  } catch {
    modelCache.delete(file)
    return null
  }
}

/** CPU-only BPM estimate from one local candidate profile. */
export function estimateBPMi(profile: any, { saveDir = null, model = null }: any = {}) {
  const candidates = profileCandidates(profile)
  if (!candidates.length) return null
  const loaded = model ?? loadBPMi({ saveDir })
  const features = featuresForBpmProfile(profile)
  const scores = loaded?.eligible ? loaded.network.predict(features) : null
  const index = scores ? bestIndex(scores, candidates.length) : baselineIndex(profile)
  const candidate = candidates[index >= 0 ? index : 0]
  return {
    model: BPMI_NAME,
    backend: 'cpu',
    bpm: Number(candidate.bpm.toFixed(3)),
    confidence: Number((Number(profile.confidence) || 0).toFixed(3)),
    candidateStrength: Number(candidate.strength.toFixed(4)),
    modelScore: scores && index >= 0 ? Number(scores[index].toFixed(4)) : null,
    trained: Boolean(loaded?.eligible),
    parameters: loaded?.parameters ?? 0,
    candidates: candidates.length
  }
}

/** All-source, all-station coverage and checkpoint status for the owner API. */
export function bpmIStatus({ store = null, file = undefined, saveDir = null, includeData = true }: any = {}) {
  const model = loadBPMi({ saveDir })
  let coverage: any = null
  if (includeData) coverage = buildBpmDataset(readAllSeams({ store, file })).coverage
  return {
    name: BPMI_NAME,
    backend: 'cpu',
    loaded: Boolean(model),
    file: model ? BPMI_FILE : null,
    parameters: model?.parameters ?? 0,
    shape: model?.shape ?? null,
    trainedAt: model?.trainedAt ?? null,
    steps: model?.steps ?? 0,
    observations: model?.observations ?? 0,
    tracks: model?.tracks ?? 0,
    stations: model?.stations ?? 0,
    sources: model?.sources ?? 0,
    eligible: model?.eligible ?? false,
    validation: model?.validation ?? null,
    baseline: model?.baseline ?? null,
    coverage
  }
}

/** Train BPMi on every eligible seam-side observation, always on the CPU. */
export async function trainBPMi({
  records = null,
  store = null,
  file = undefined,
  saveDir = null,
  epochs = 0,
  learningRate = 0.004,
  fast = false,
  full = true,
  force = false
}: any = {}) {
  const started = Date.now()
  let rows = Array.isArray(records) ? records : readAllSeams({ store, file })
  const dataset = buildBpmDataset(rows)
  const { samples, coverage } = dataset
  if (!Array.isArray(records)) rows = []
  const groups = splitBpmDataset(samples)
  if (samples.length < BPMI_MIN_OBSERVATIONS || coverage.tracks < BPMI_MIN_TRACKS) {
    return {
      trained: false,
      model: BPMI_NAME,
      backend: 'cpu',
      reason: `only ${samples.length} labelled BPM observations across ${coverage.tracks} tracks (${BPMI_MIN_OBSERVATIONS} observations and ${BPMI_MIN_TRACKS} tracks needed)`,
      ...coverage
    }
  }

  const outputDir = bpmModelDir(saveDir)
  const previous = loadBPMi({ saveDir })
  const fingerprint = dataFingerprint(samples)
  if (!force && previous?.fingerprint === fingerprint) {
    return { trained: false, skipped: true, model: BPMI_NAME, backend: 'cpu', reason: 'BPMi is current', ...coverage, parameters: previous.parameters }
  }

  const hidden = bpmIHiddenShape(samples.length)
  const shape = [BPMI_FEATURES.length, ...hidden, BPMI_MAX_CANDIDATES]
  const trainingEpochs = Math.max(1, Math.min(10_000, Number(epochs) > 0 ? Math.floor(Number(epochs)) : bpmIDefaultEpochs(samples.length, { fast })))
  const batchSize = samples.length < 512 ? 16 : samples.length < 10_000 ? 32 : 64
  const seedText = fingerprint.slice(0, 8)
  const seed = Number.parseInt(seedText, 16) >>> 0
  const network = new Network(shape, { seed })
  let steps = 0
  const validationRows = groups.test.length ? groups.test : groups.train
  const baseline = measure(null, validationRows, { baseline: true })

  if (groups.train.length) {
    steps += await fitEpochs(network, groups.train, trainingEpochs, { seed, learningRate, batchSize })
  }
  const validation = measure(network, validationRows)
  const eligible = !groups.test.length || validation.within5Percent >= baseline.within5Percent || validation.mae <= baseline.mae

  // Validation is track-grouped above. The final checkpoint then sees every
  // eligible row from every station/source; no row cap or station filter is
  // applied. Fast mode still sees the complete set, with fewer full epochs.
  const allDataEpochs = full ? Math.max(1, Math.ceil(trainingEpochs / 4)) : 0
  if (allDataEpochs > 0) {
    steps += await fitEpochs(network, samples, allDataEpochs, { seed: seed ^ 0x9e3779b9, learningRate, batchSize, stepStart: steps })
  }

  const trainedAt = Date.now()
  const metadata = {
    steps: String(steps),
    trainedAt: String(trainedAt),
    observations: String(samples.length),
    tracks: String(coverage.tracks),
    stations: String(coverage.stations),
    sources: String(coverage.sources),
    epochs: String(trainingEpochs),
    allDataEpochs: String(allDataEpochs),
    eligible: String(eligible),
    fingerprint,
    validation: JSON.stringify(validation),
    baseline: JSON.stringify(baseline),
    coverage: JSON.stringify({ stationIds: coverage.stationIds, sourceNames: coverage.sourceNames })
  }
  const saved = saveCheckpoint(network, metadata, outputDir)
  const loaded = loadBPMi({ saveDir, force: true })
  return {
    trained: true,
    model: BPMI_NAME,
    backend: 'cpu',
    device: 'cpu',
    file: saved.file,
    bytes: saved.bytes,
    digest: saved.digest,
    parameters: loaded?.parameters ?? bpmIParameterCount(samples.length),
    shape,
    observations: samples.length,
    tracks: coverage.tracks,
    stations: coverage.stations,
    sources: coverage.sources,
    stationIds: coverage.stationIds,
    sourceNames: coverage.sourceNames,
    uncovered: coverage.uncovered,
    epochs: trainingEpochs,
    allDataEpochs,
    steps,
    validation,
    baseline,
    eligible,
    train: groups.train.length,
    test: groups.test.length,
    trainTracks: groups.trainTracks,
    testTracks: groups.testTracks,
    fullDataFit: allDataEpochs > 0,
    ms: Date.now() - started
  }
}

export default BPMI_NAME
