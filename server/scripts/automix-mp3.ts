#!/usr/bin/env bun
/** Render one outgoing-MP3 tail into one incoming-MP3 head. */
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { AUTOMIX_MP3_USAGE, parseAutomixMp3Args, renderAutomixMp3 } from '../src/core/automix/cli.ts'

async function main() {
  try {
    const parsed = parseAutomixMp3Args(process.argv.slice(2))
    if (parsed.help) {
      console.log(AUTOMIX_MP3_USAGE)
      return
    }

    const result = await renderAutomixMp3(parsed.options)
    console.log(`Automix transition: ${result.report.from ?? 'outgoing'} → ${result.report.to ?? 'incoming'}`)
    console.log(`  effect: ${result.report.effect} · ${result.report.curve} · ${result.report.blendMs} ms blend`)
    console.log(`  input windows: ${(result.outgoingWindowMs / 1000).toFixed(2)} s outgoing tail, ${(result.incomingWindowMs / 1000).toFixed(2)} s incoming head`)
    console.log(`  output: ${result.output} · ${(result.durationMs / 1000).toFixed(2)} s · ${(result.bytes / 1024).toFixed(1)} KiB`)
    if (result.report.beat?.source) console.log(`  beatmatch: ${result.report.beat.source}`)
    if (result.report.fallback?.reason) console.warn(`  note: safe crossfade fallback (${result.report.fallback.reason})`)
  } catch (error: any) {
    console.error(`automix:mp3: ${error?.message ?? error}`)
    console.error(`\n${AUTOMIX_MP3_USAGE}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main()
}
