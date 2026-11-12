import { createRequire } from 'node:module';
import type { Logger } from '../utils/logger.js';
import { createLogger } from '../utils/logger.js';

/**
 * Native (Rust / Node-API) loader with pure-TypeScript fallback.
 *
 * The Rust crate in /native exposes the same functions. If the native
 * addon is not built (e.g. local dev without a Rust toolchain), Livy
 * transparently uses the JS implementations below so behaviour is
 * identical — only slower for hot loops.
 */

export interface HlsSegment {
  uri: string;
  duration: number;
  sequence: number;
}

export interface NativeAudio {
  /** True when the Rust addon is loaded. */
  readonly isNative: boolean;
  parseM3u8(playlist: string, baseUrl: string): HlsSegment[];
  detectFormat(header: Buffer): string;
  applyGainPcm16(samples: Buffer, gain: number): Buffer;
  countMp3Frames(data: Buffer): number;
  resamplePcm16(samples: Buffer, fromRate: number, toRate: number): Buffer;
}

// ---------- Pure TypeScript fallback implementations ----------

function jsParseM3u8(playlist: string, baseUrl: string): HlsSegment[] {
  const segments: HlsSegment[] = [];
  const lines = playlist.split(/\r?\n/);
  let sequence = 0;
  let pendingDuration: number | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      sequence = Number.parseInt(line.split(':')[1] ?? '0', 10) || 0;
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = Number.parseFloat(line.slice('#EXTINF:'.length).split(',')[0] ?? '0') || 0;
    } else if (line && !line.startsWith('#')) {
      segments.push({
        uri: new URL(line, baseUrl).toString(),
        duration: pendingDuration ?? 0,
        sequence,
      });
      sequence += 1;
      pendingDuration = null;
    }
  }
  return segments;
}

function jsDetectFormat(header: Buffer): string {
  if (header.length >= 4 && header.toString('ascii', 0, 4) === 'fLaC') return 'flac';
  if (header.length >= 3 && header.toString('ascii', 0, 3) === 'ID3') return 'mp3';
  if (header.length >= 2 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0) return 'mp3';
  if (header.length >= 4 && header.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  if (header.length >= 4 && header.toString('ascii', 0, 4) === 'RIFF') return 'wav';
  if (header.length >= 12 && header.toString('ascii', 8, 12) === 'ftyp') return 'aac';
  return 'unknown';
}

function jsApplyGainPcm16(samples: Buffer, gain: number): Buffer {
  const out = Buffer.alloc(samples.length);
  for (let i = 0; i + 1 < samples.length; i += 2) {
    const v = samples.readInt16LE(i);
    const g = Math.max(-32768, Math.min(32767, Math.round(v * gain)));
    out.writeInt16LE(g, i);
  }
  return out;
}

function jsCountMp3Frames(data: Buffer): number {
  let count = 0;
  for (let i = 0; i + 1 < data.length; i += 1) {
    if (data[i] === 0xff && (data[i + 1] & 0xe0) === 0xe0) count += 1;
  }
  return count;
}

function jsResamplePcm16(samples: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate || fromRate <= 0 || toRate <= 0) return Buffer.from(samples);
  const frames = Math.floor(samples.length / 2);
  const outFrames = Math.floor((frames * toRate) / fromRate);
  const out = Buffer.alloc(outFrames * 2);
  for (let i = 0; i < outFrames; i += 1) {
    const srcIdx = Math.floor((i * fromRate) / toRate) * 2;
    out.writeInt16LE(samples.readInt16LE(Math.min(srcIdx, samples.length - 2)), i * 2);
  }
  return out;
}

// ---------- Loader ----------

interface NativeModule {
  parseM3u8(playlist: string, baseUrl: string): HlsSegment[];
  detectFormat(header: Buffer): string;
  applyGainPcm16(samples: Buffer, gain: number): Buffer;
  countMp3Frames(data: Buffer): number;
  resamplePcm16(samples: Buffer, fromRate: number, toRate: number): Buffer;
}

let cached: NativeAudio | null = null;

/** Load the native addon if available, otherwise fall back to JS. */
export function loadNativeAudio(logger: Logger = createLogger()): NativeAudio {
  if (cached) return cached;

  let native: NativeModule | null = null;
  try {
    const require = createRequire(import.meta.url);
    // Resolved relative to this file: ../../native (built by napi CLI).
    native = require('../../native/index.js') as NativeModule;
    logger.info('Rust native audio module loaded', { native: true });
  } catch {
    native = null;
  }

  if (native) {
    cached = {
      isNative: true,
      parseM3u8: (p, b) => native!.parseM3u8(p, b),
      detectFormat: (h) => native!.detectFormat(h),
      applyGainPcm16: (s, g) => native!.applyGainPcm16(s, g),
      countMp3Frames: (d) => native!.countMp3Frames(d),
      resamplePcm16: (s, f, t) => native!.resamplePcm16(s, f, t),
    };
  } else {
    logger.info('Rust native module not found — using TypeScript fallback', { native: false });
    cached = {
      isNative: false,
      parseM3u8: jsParseM3u8,
      detectFormat: jsDetectFormat,
      applyGainPcm16: jsApplyGainPcm16,
      countMp3Frames: jsCountMp3Frames,
      resamplePcm16: jsResamplePcm16,
    };
  }
  return cached;
}

/** Reset the cache (tests only). */
export function resetNativeCache(): void {
  cached = null;
}
