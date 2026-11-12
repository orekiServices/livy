import type { StreamFormat } from '../types/index.js';
import { loadNativeAudio } from './native.js';

/**
 * Codec registry. Each adapter knows how to detect, validate and
 * describe a format. New codecs register here without touching the
 * streaming pipeline.
 */

export interface CodecAdapter {
  readonly format: StreamFormat;
  readonly mimeType: string;
  readonly fileExtension: string;
  detect(header: Buffer): boolean;
  /** Approximate bitrate in kbps from a header sample, if derivable. */
  estimateBitrateKbps(header: Buffer): number | undefined;
}

const mp3: CodecAdapter = {
  format: 'mp3',
  mimeType: 'audio/mpeg',
  fileExtension: 'mp3',
  detect: (h) => h.length >= 3 && (h.toString('ascii', 0, 3) === 'ID3' || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0)),
  estimateBitrateKbps: () => undefined,
};

const flac: CodecAdapter = {
  format: 'flac',
  mimeType: 'audio/flac',
  fileExtension: 'flac',
  detect: (h) => h.length >= 4 && h.toString('ascii', 0, 4) === 'fLaC',
  estimateBitrateKbps: () => undefined,
};

const ogg: CodecAdapter = {
  format: 'ogg',
  mimeType: 'audio/ogg',
  fileExtension: 'ogg',
  detect: (h) => h.length >= 4 && h.toString('ascii', 0, 4) === 'OggS',
  estimateBitrateKbps: () => undefined,
};

const aac: CodecAdapter = {
  format: 'aac',
  mimeType: 'audio/aac',
  fileExtension: 'aac',
  detect: (h) => h.length >= 12 && h.toString('ascii', 8, 12) === 'ftyp',
  estimateBitrateKbps: () => undefined,
};

const hls: CodecAdapter = {
  format: 'hls',
  mimeType: 'application/vnd.apple.mpegurl',
  fileExtension: 'm3u8',
  detect: (h) => h.toString('utf8', 0, Math.min(h.length, 64)).includes('#EXTM3U'),
  estimateBitrateKbps: () => undefined,
};

const registry = new Map<StreamFormat, CodecAdapter>([
  ['mp3', mp3],
  ['flac', flac],
  ['ogg', ogg],
  ['aac', aac],
  ['hls', hls],
]);

export function getCodec(format: StreamFormat): CodecAdapter | undefined {
  return registry.get(format);
}

export function registerCodec(adapter: CodecAdapter): void {
  registry.set(adapter.format, adapter);
}

export function listCodecs(): CodecAdapter[] {
  return [...registry.values()];
}

/** Detect the format of a byte header using the native module. */
export function detectFormat(header: Buffer): StreamFormat {
  const detected = loadNativeAudio().detectFormat(header);
  return (['mp3', 'flac', 'ogg', 'aac', 'hls', 'unknown'] as const).includes(detected as StreamFormat)
    ? (detected as StreamFormat)
    : 'unknown';
}

/** Infer a format from a URL's extension (fallback when sniffing fails). */
export function formatFromUrl(url: string): StreamFormat {
  const lower = url.split('?')[0].toLowerCase();
  if (lower.endsWith('.mp3')) return 'mp3';
  if (lower.endsWith('.flac')) return 'flac';
  if (lower.endsWith('.ogg') || lower.endsWith('.oga')) return 'ogg';
  if (lower.endsWith('.m3u8')) return 'hls';
  if (lower.endsWith('.aac') || lower.endsWith('.m4a')) return 'aac';
  return 'unknown';
}
