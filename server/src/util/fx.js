/**
 * MetroFX — the native filter kernels, and the honest answer about whether
 * they are loaded.
 *
 * The chain calls `process(left, right, length)` per block either way. A filter
 * that has a native kernel constructs it here and calls it; the JavaScript
 * class is the fallback and the reference. This module never throws: a missing
 * binary, a wrong libc or a corrupt build all mean "use JavaScript".
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))

const CANDIDATES = [
  // bundled with the node (the layout this repo ships)
  path.join(here, '..', '..', '..', 'native', 'metrofx', 'index.js'),
  // installed as a dependency
  'metrofx'
]

function load() {
  if (process.env.LIVY_DISABLE_FX === '1' || process.env.NODECAST_DISABLE_FX === '1') return null
  for (const candidate of CANDIDATES) {
    try {
      const mod = require(candidate)
      // All four classes, or it is not the addon this build expects. A partial
      // module would silently take one filter down a different code path.
      if (mod?.available && mod.Biquad && mod.Compressor && mod.Reverb && mod.Distortion) return mod
    } catch {
      /* try the next location */
    }
  }
  return null
}

const native = load()

/** The native module, or `null` when the JavaScript filters are in use. */
export const fx = native

/** True when MetroFX is loaded. */
export const fxAvailable = Boolean(native)

/** `'native' | 'javascript'` — what the filters are actually using. */
export const fxEngine = native ? 'native' : 'javascript'

/** A small object for `/api/v1/info` and the boot log. */
export function fxInfo() {
  return {
    available: Boolean(native),
    engine: fxEngine,
    version: native?.version?.() ?? null,
    describe: native?.describe?.() ?? null
  }
}

export default native
