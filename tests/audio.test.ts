import { describe, expect, it } from 'vitest';
import { buildIcyBlock, withIcyMetadata } from '../src/audio/icy.js';
import { detectFormat, formatFromUrl, getCodec } from '../src/audio/codecs.js';
import { buildM3u, parseM3u, parseM3u8 } from '../src/audio/m3u8.js';
import { loadNativeAudio } from '../src/audio/native.js';

const MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:42
#EXTINF:6.000,
seg-42.ts
#EXTINF:5.500,
seg-43.ts
#EXT-X-ENDLIST
`;

describe('parseM3u8', () => {
  it('parses media playlist segments', () => {
    const parsed = parseM3u8(MEDIA_PLAYLIST, 'https://cdn.example.com/live/playlist.m3u8');
    expect(parsed.isMaster).toBe(false);
    expect(parsed.isLive).toBe(false);
    expect(parsed.targetDuration).toBe(6);
    expect(parsed.mediaSequence).toBe(42);
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0].uri).toBe('https://cdn.example.com/live/seg-42.ts');
    expect(parsed.segments[0].duration).toBeCloseTo(6);
    expect(parsed.segments[0].sequence).toBe(42);
    expect(parsed.segments[1].sequence).toBe(43);
  });

  it('parses master playlist variants', () => {
    const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000
high.m3u8
`;
    const parsed = parseM3u8(master, 'https://cdn.example.com/master.m3u8');
    expect(parsed.isMaster).toBe(true);
    expect(parsed.variants).toHaveLength(2);
    expect(parsed.variants[0].bandwidth).toBe(800000);
    expect(parsed.variants[0].resolution).toBe('640x360');
  });
});

describe('parseM3u / buildM3u', () => {
  it('round-trips extended M3U', () => {
    const content = `#EXTM3U
#EXTINF:180,Artist - Title
https://example.com/a.mp3
#EXTINF:-1,Plain
https://example.com/b.mp3
`;
    const entries = parseM3u(content, 'https://example.com/');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ title: 'Title', artist: 'Artist', duration: 180 });
    const rebuilt = buildM3u(entries);
    expect(rebuilt).toContain('#EXTM3U');
    expect(rebuilt).toContain('Artist - Title');
  });
});

describe('codecs', () => {
  it('detects formats from magic bytes', () => {
    expect(detectFormat(Buffer.from('fLaC....'))).toBe('flac');
    expect(detectFormat(Buffer.from('ID3....'))).toBe('mp3');
    expect(detectFormat(Buffer.from('OggS....'))).toBe('ogg');
    expect(detectFormat(Buffer.from('........ftyp....'))).toBe('aac');
    expect(detectFormat(Buffer.from('xxxx'))).toBe('unknown');
  });

  it('infers format from URL', () => {
    expect(formatFromUrl('https://x.com/stream.mp3?token=1')).toBe('mp3');
    expect(formatFromUrl('https://x.com/live.m3u8')).toBe('hls');
    expect(formatFromUrl('https://x.com/stream')).toBe('unknown');
  });

  it('exposes codec registry', () => {
    expect(getCodec('mp3')?.mimeType).toBe('audio/mpeg');
    expect(getCodec('hls')?.mimeType).toBe('application/vnd.apple.mpegurl');
  });
});

describe('icy metadata', () => {
  it('builds a valid ICY block', () => {
    const block = buildIcyBlock('Test Title');
    expect(block[0]).toBe(block.length - 1 >> 4);
    expect(block.subarray(1).toString('utf8')).toContain("StreamTitle='Test Title';");
  });

  it('injects metadata at the configured interval', async () => {
    async function* source(): AsyncGenerator<Buffer> {
      yield Buffer.alloc(100, 0x41);
    }
    const chunks: Buffer[] = [];
    for await (const c of withIcyMetadata(source(), 50, () => 'Now Playing')) {
      chunks.push(c);
    }
    const joined = Buffer.concat(chunks);
    expect(joined.toString('utf8')).toContain("StreamTitle='Now Playing';");
  });
});

describe('native fallback parity', () => {
  it('gain + resample + frame count behave sanely', () => {
    const native = loadNativeAudio();
    const samples = Buffer.alloc(8);
    samples.writeInt16LE(1000, 0);
    samples.writeInt16LE(-1000, 2);
    const gained = native.applyGainPcm16(samples, 2);
    expect(gained.readInt16LE(0)).toBe(2000);
    expect(gained.readInt16LE(2)).toBe(-2000);

    const resampled = native.resamplePcm16(samples, 48000, 24000);
    expect(resampled.length).toBe(4);

    expect(native.countMp3Frames(Buffer.from([0xff, 0xe3, 0x00, 0xff, 0xfb]))).toBe(2);
  });
});
