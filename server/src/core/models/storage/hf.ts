/**
 * Hugging Face Hub as private model storage.
 *
 * A model is a few kilobytes, so HF is not here for size — it is here so a
 * fleet of nodes can share one learned policy without a bucket or a database
 * server. The repository is created **private** and every request refuses to
 * treat a public repo as acceptable: a DJ policy is derived from what a
 * station's listeners skipped, which is not something to publish by accident.
 *
 * Token: `HF_TOKEN` (or `LIVY_HF_TOKEN`), never logged, never persisted by
 * this module. All network calls accept an injected `fetchImpl` so tests do
 * not reach the internet.
 */
import createLogger from '../../../util/logger.ts'
import { modelSettings } from '../settings.ts'

const log = createLogger('dj-hub')
const API = 'https://huggingface.co'

export function hfConfig(overrides: any = {}) {
  const hf = { ...modelSettings().hf, ...overrides }
  return {
    repo: String(hf.repo ?? '').trim(),
    revision: hf.revision || 'main',
    private: true,
    token: hf.token || process.env.LIVY_HF_TOKEN || process.env.HF_TOKEN || '',
    enabled: hf.enabled !== false
  }
}

export function hfReady(cfg = hfConfig()) {
  return Boolean(cfg.enabled && cfg.repo && cfg.token)
}

const auth = (cfg) => ({ authorization: `Bearer ${cfg.token}` })
const encodePath = (name) => name.split('/').map(encodeURIComponent).join('/')

async function json(response, what) {
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text.slice(0, 400) }
  }
  if (!response.ok) {
    throw Object.assign(new Error(`HF ${what} failed (${response.status}): ${body?.error ?? body?.message ?? 'no detail'}`), {
      status: response.status,
      body
    })
  }
  return body
}

/** Is the configured repo private? A public repo is refused, not used. */
export async function repoInfo(cfg = hfConfig(), { fetchImpl = fetch }: any = {}) {
  if (!cfg.repo) return null
  const response = await fetchImpl(`${API}/api/models/${cfg.repo}`, {
    headers: { ...auth(cfg), accept: 'application/json' }
  })
  if (response.status === 404) return null
  const info = await json(response, 'repo lookup')
  return { ...info, private: info?.private !== false }
}

async function assertPrivate(cfg, { fetchImpl }) {
  const info = await repoInfo(cfg, { fetchImpl })
  if (info && info.private === false) {
    throw new Error(`HF repo ${cfg.repo} is public; Livy models must be stored in a private repo`)
  }
  return info
}

/** Create the repo if it does not exist. Always private. */
export async function ensureRepo(cfg = hfConfig(), { fetchImpl = fetch }: any = {}) {
  if (!hfReady(cfg)) throw new Error('HF storage needs a repo and a token (HF_TOKEN)')
  const existing = await repoInfo(cfg, { fetchImpl })
  if (existing) {
    if (!existing.private) throw new Error(`HF repo ${cfg.repo} is public; create a private one instead`)
    return { created: false, repo: cfg.repo, url: `${API}/${cfg.repo}` }
  }
  const response = await fetchImpl(`${API}/api/repos/create`, {
    method: 'POST',
    headers: { ...auth(cfg), 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'model', name: cfg.repo, private: true })
  })
  // A concurrent create is not an error.
  if (response.status !== 409) await json(response, 'repo create')
  log.info(`HF repo ready: ${cfg.repo} (private)`)
  return { created: response.status !== 409, repo: cfg.repo, url: `${API}/${cfg.repo}` }
}

/** Upload one file. Returns the path inside the repo. */
export async function uploadFile(buffer, name, cfg = hfConfig(), { fetchImpl = fetch }: any = {}) {
  if (!hfReady(cfg)) throw new Error('HF storage needs a repo and a token (HF_TOKEN)')
  await assertPrivate(cfg, { fetchImpl })
  const path = name.split('/').map(encodeURIComponent).join('/')
  const response = await fetchImpl(`${API}/api/models/${cfg.repo}/upload/${cfg.revision}/${path}`, {
    method: 'PUT',
    headers: { ...auth(cfg), 'content-type': 'application/octet-stream' },
    body: buffer
  })
  await json(response, `upload ${name}`)
  return { repo: cfg.repo, path: name, revision: cfg.revision, url: `${API}/${cfg.repo}/blob/${cfg.revision}/${path}` }
}

export async function downloadFile(name, cfg = hfConfig(), { fetchImpl = fetch }: any = {}) {
  if (!hfReady(cfg)) throw new Error('HF storage needs a repo and a token (HF_TOKEN)')
  const path = name.split('/').map(encodeURIComponent).join('/')
  const response = await fetchImpl(`${API}/${cfg.repo}/resolve/${cfg.revision}/${path}`, {
    headers: auth(cfg)
  })
  if (!response.ok) throw new Error(`HF download ${name} failed (${response.status})`)
  return Buffer.from(await response.arrayBuffer())
}

/** Every `.bin` in the repo, newest last. */
export async function listRemote(cfg = hfConfig(), { fetchImpl = fetch }: any = {}) {
  if (!hfReady(cfg)) return []
  const response = await fetchImpl(`${API}/api/models/${cfg.repo}/tree/${cfg.revision}?recursive=true`, {
    headers: { ...auth(cfg), accept: 'application/json' }
  })
  if (response.status === 404) return []
  const entries = await json(response, 'tree')
  return (entries ?? [])
    .filter((entry) => entry.type === 'file' && entry.path?.endsWith('.bin'))
    .map((entry) => ({ name: entry.path.split('/').pop(), path: entry.path, bytes: entry.size ?? null }))
}

export async function hubStatus(cfg = hfConfig(), { fetchImpl = fetch }: any = {}): Promise<Record<string, any>> {
  const base = {
    enabled: cfg.enabled,
    configured: Boolean(cfg.repo),
    token: Boolean(cfg.token),
    repo: cfg.repo || null,
    revision: cfg.revision,
    ready: hfReady(cfg)
  }
  if (!base.ready) return { ...base, remote: [], private: null }
  try {
    const info = await repoInfo(cfg, { fetchImpl })
    return {
      ...base,
      exists: Boolean(info),
      private: info ? info.private : null,
      remote: info ? await listRemote(cfg, { fetchImpl }) : []
    }
  } catch (error) {
    return { ...base, error: error.message }
  }
}
