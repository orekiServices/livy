/**
 * Micro-benchmarks for performance-critical native operations.
 * Run: npx tsx benchmarks/native.bench.ts
 * Compares the Rust addon (when built) against the TS fallback.
 */
import { performance } from 'node:perf_hooks';
import { loadNativeAudio } from '../src/audio/native.js';
import { parseM3u8 } from '../src/audio/m3u8.js';

const PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:1000
${Array.from({ length: 100 }, (_, i) => `#EXTINF:6.000,\nseg-${1000 + i}.ts`).join('\n')}
#EXT-X-ENDLIST
`;

const PCM = Buffer.alloc(48000 * 2); // 1s of 48kHz mono PCM16
for (let i = 0; i < PCM.length; i += 2) PCM.writeInt16LE((i * 7) % 30000 - 15000, i);

function bench(name: string, iterations: number, fn: () => void): void {
  // warmup
  for (let i = 0; i < Math.min(100, iterations); i += 1) fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) fn();
  const elapsed = performance.now() - start;
  console.log(`${name.padEnd(28)} ${iterations.toString().padStart(7)} iters  ${(elapsed / iterations).toFixed(3)} ms/op  (${(iterations / (elapsed / 1000)).toFixed(0)} ops/s)`);
}

const native = loadNativeAudio();
console.log(`Native module: ${native.isNative ? 'Rust addon' : 'TypeScript fallback'}\n`);

bench('parseM3u8 (100 segments)', 5000, () => parseM3u8(PLAYLIST, 'https://cdn.example.com/live/playlist.m3u8'));
bench('detectFormat', 100000, () => native.detectFormat(Buffer.from('fLaC....')));
bench('applyGainPcm16 (1s PCM)', 2000, () => native.applyGainPcm16(PCM, 1.5));
bench('resamplePcm16 48k→44.1k', 2000, () => native.resamplePcm16(PCM, 48000, 44100));
bench('countMp3Frames (96KB)', 2000, () => native.countMp3Frames(Buffer.alloc(96 * 1024, 0xff)));
