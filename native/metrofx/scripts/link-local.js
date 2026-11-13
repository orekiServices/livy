#!/usr/bin/env node
/** Copy `cargo build --release` output next to this loader, host-named. */
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const lib = process.platform === 'win32' ? 'metrofx.dll' : process.platform === 'darwin' ? 'libmetrofx.dylib' : 'libmetrofx.so'
const source = path.join(root, 'target', 'release', lib)
if (!fs.existsSync(source)) {
  console.error(`✖ ${source} not found — run cargo build --release first`)
  process.exit(1)
}
const cpu = process.arch === 'arm' ? 'arm' : process.arch
const abi = process.platform === 'linux' ? (fs.existsSync('/lib/ld-musl-x86_64.so.1') || fs.existsSync('/lib/ld-musl-aarch64.so.1') ? 'musl' : 'gnu') : ''
const name = process.platform === 'linux' ? `metrofx.linux-${cpu}-${abi}.node` : `metrofx.${process.platform}-${cpu}.node`
const target = path.join(root, name)
fs.copyFileSync(source, target)
console.log(`· ${path.basename(source)} → ${name}`)
