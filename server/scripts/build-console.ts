#!/usr/bin/env bun
/**
 * Build the web console and install it as a plugin of this node.
 *
 *   bun run build:web
 *
 * The Next.js TypeScript app is exported to static files and copied into the
 * console **plugin** (server/plugins/console/public), which serves them on the
 * node's own port. After this there is one process, one port and one URL — and
 * the whole UI can be switched off from the Plugins panel like anything else.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const webDir = path.resolve(root, '..', 'web')
const exportDir = path.join(webDir, 'out')
const target = path.join(root, 'plugins', 'console', 'public')

const run = (cmd: string, args: string[], cwd: string) => {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) {
    console.error(`\n✖ ${cmd} ${args.join(' ')} failed`)
    process.exit(result.status ?? 1)
  }
}

if (!fs.existsSync(webDir)) {
  console.error(`✖ no web/ directory next to the server (looked in ${webDir})`)
  process.exit(1)
}

if (!fs.existsSync(path.join(webDir, 'node_modules'))) {
  console.log('· installing console dependencies…')
  run('bun', ['install'], webDir)
}

console.log('· building the console…')
run('bun', ['run', 'build'], webDir)

if (!fs.existsSync(exportDir)) {
  console.error('✖ the build produced no out/ directory — is output:"export" still set in next.config.ts?')
  process.exit(1)
}

// Replace the previous copy wholesale so removed files never linger.
fs.rmSync(target, { recursive: true, force: true })
fs.cpSync(exportDir, target, { recursive: true })

let files = 0
let bytes = 0
const walk = (dir: string) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else {
      files += 1
      bytes += fs.statSync(full).size
    }
  }
}
walk(target)

console.log(`\n✓ console installed -> server/plugins/console/public (${files} files, ${(bytes / 1024 / 1024).toFixed(2)} MB)`)
console.log(`  console  /  — same origin, one process.`)
