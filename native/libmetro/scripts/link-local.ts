import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { platform, arch, report } = process

function abi(): string {
  if (platform !== 'linux') return ''
  try {
    const header = (report.getReport() as { header?: { glibcVersionRuntime?: string } }).header
    return header?.glibcVersionRuntime ? '-gnu' : '-musl'
  } catch {
    return readFileSync('/usr/bin/ldd', 'utf8').includes('musl') ? '-musl' : '-gnu'
  }
}

const built =
  platform === 'win32'
    ? path.join(root, 'target', 'release', 'libmetro.dll')
    : platform === 'darwin'
      ? path.join(root, 'target', 'release', 'liblibmetro.dylib')
      : path.join(root, 'target', 'release', 'liblibmetro.so')

if (!existsSync(built)) {
  console.error(`libmetro: nothing built at ${built} — run \`cargo build --release\` first`)
  process.exit(1)
}

const suffix = platform === 'win32' ? `${arch}-msvc` : platform === 'darwin' ? arch : `${arch}${abi()}`
const target = path.join(root, `libmetro.${platform}-${suffix}.node`)
copyFileSync(built, target)
console.log(`libmetro: ${target.replace(`${root}/`, '')}`)
