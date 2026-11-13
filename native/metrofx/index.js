/**
 * metrofx loader.
 *
 * Same convention as libmetro and metrodb: pick the binary for this host,
 * never throw when there is none. `server/src/util/fx.js` treats a miss as
 * "run the JavaScript filters", so a platform without a build is slower, not
 * broken.
 */

const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { platform, arch, report } = require('node:process')

/** glibc or musl, without shelling out. */
function linuxAbi() {
  try {
    const header = typeof report?.getReport === 'function' ? report.getReport().header : null
    if (header?.glibcVersionRuntime) return 'gnu'
    if (header) return 'musl'
  } catch {
    /* fall through */
  }
  return 'gnu'
}

function candidates() {
  const names = []
  if (platform === 'linux') {
    const abi = linuxAbi()
    const cpu = arch === 'arm' ? 'arm' : arch
    names.push(`metrofx.linux-${cpu}-${abi}`)
    if (cpu === 'arm') names.push('metrofx.linux-arm-gnueabihf')
    names.push(`metrofx.linux-${cpu}-${abi === 'gnu' ? 'musl' : 'gnu'}`)
  } else if (platform === 'darwin') {
    names.push(`metrofx.darwin-${arch}`, 'metrofx.darwin-universal')
  } else if (platform === 'win32') {
    names.push(`metrofx.win32-${arch}-msvc`)
  } else {
    names.push(`metrofx.${platform}-${arch}`)
  }
  return names
}

const failures = []

function load() {
  for (const name of candidates()) {
    const local = join(__dirname, `${name}.node`)
    if (existsSync(local)) {
      try {
        return require(local)
      } catch (error) {
        failures.push(`${name}: ${error.message.split('\n')[0]}`)
      }
    }
    const pkg = name.replace('metrofx.', 'metrofx-')
    for (const scope of ['@livy', '@nodecast']) {
      try {
        return require(`${scope}/${pkg}`)
      } catch {
        /* not installed under this scope */
      }
    }
  }
  return null
}

const native = load()

module.exports = {
  ...(native ?? {}),
  available: Boolean(native),
  triedNames: candidates(),
  loadErrors: failures
}
