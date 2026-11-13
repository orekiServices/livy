/**
 * libmetro loader — MetroS.
 *
 * Picks the binary for the host triple. Nothing here throws on a miss: the
 * caller (Livy's `src/util/metro.js`) treats "no binary" as "use the
 * JavaScript path", so an unsupported platform is slower, never broken.
 */

const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { platform, arch, report } = require('node:process')

/** glibc or musl? `process.report` knows without shelling out to ldd. */
function linuxAbi() {
  try {
    const header = typeof report?.getReport === 'function' ? report.getReport().header : null
    if (header?.glibcVersionRuntime) return 'gnu'
    // musl builds report no glibc version at all.
    if (header && !header.glibcVersionRuntime) return 'musl'
  } catch {
    /* fall through */
  }
  try {
    return readFileSync('/usr/bin/ldd', 'utf8').includes('musl') ? 'musl' : 'gnu'
  } catch {
    return 'gnu'
  }
}

/** Candidate file names, best match first. */
function candidates() {
  const names = []
  if (platform === 'linux') {
    const abi = linuxAbi()
    const cpu = arch === 'arm' ? 'arm' : arch
    names.push(`libmetro.linux-${cpu}-${abi}`)
    if (cpu === 'arm') names.push('libmetro.linux-arm-gnueabihf')
    names.push(`libmetro.linux-${cpu}-${abi === 'gnu' ? 'musl' : 'gnu'}`)
  } else if (platform === 'darwin') {
    names.push(`libmetro.darwin-${arch}`, 'libmetro.darwin-universal')
  } else if (platform === 'win32') {
    names.push(`libmetro.win32-${arch}-msvc`)
  } else {
    names.push(`libmetro.${platform}-${arch}`)
  }
  return names
}

const failures = []

function load() {
  for (const name of candidates()) {
    // 1. next to this file (napi build --platform output, and our local build)
    const local = join(__dirname, `${name}.node`)
    if (existsSync(local)) {
      try {
        return require(local)
      } catch (error) {
        // A binary that is present but will not load — the wrong libc, an
        // old glibc, a truncated download — must not take the node with it.
        // Remember why, then try the next candidate.
        failures.push(`${name}: ${error.message.split('\n')[0]}`)
      }
    }
    // 2. the published per-platform package, when installed from npm. The
    //    pre-rename scope is still tried: a deployment may have it installed.
    const pkg = name.replace('libmetro.', 'libmetro-')
    for (const scope of ['@livy', '@nodecast']) {
      try {
        return require(`${scope}/${pkg}`)
      } catch {
        /* not installed under this scope — try the next */
      }
    }
  }
  return null
}

const native = load()

module.exports = {
  ...(native ?? {}),
  /** True when a native binary for this platform was found and loaded. */
  available: Boolean(native),
  /** What the loader looked for — handy in a "why am I on the slow path?" log. */
  triedNames: candidates(),
  /** Binaries that were there but refused to load, and why. */
  loadErrors: failures
}
