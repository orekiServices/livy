/**
 * Copy the cargo output to the file name the loader expects for this host.
 *
 * `napi build` does this (and much more) but pulls in the whole CLI; a local
 * `cargo build --release` plus this script is enough to develop against, and
 * it works on a machine with nothing but Rust and Node installed.
 */

const { copyFileSync, existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const { platform, arch, report } = process

function abi() {
  if (platform !== 'linux') return ''
  try {
    return report.getReport().header.glibcVersionRuntime ? '-gnu' : '-musl'
  } catch {
    return readFileSync('/usr/bin/ldd', 'utf8').includes('musl') ? '-musl' : '-gnu'
  }
}

const built =
  platform === 'win32'
    ? join(root, 'target', 'release', 'libmetro.dll')
    : platform === 'darwin'
      ? join(root, 'target', 'release', 'liblibmetro.dylib')
      : join(root, 'target', 'release', 'liblibmetro.so')

if (!existsSync(built)) {
  console.error(`libmetro: nothing built at ${built} — run \`cargo build --release\` first`)
  process.exit(1)
}

const suffix = platform === 'win32' ? `${arch}-msvc` : platform === 'darwin' ? arch : `${arch}${abi()}`
const target = join(root, `libmetro.${platform}-${suffix}.node`)
copyFileSync(built, target)
console.log(`libmetro: ${target.replace(`${root}/`, '')}`)
