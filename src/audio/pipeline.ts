import { Readable } from 'node:stream';
import type { Logger } from '../utils/logger.js';
import { createLogger } from '../utils/logger.js';
import { StreamError } from '../utils/errors.js';
import { formatFromUrl } from './codecs.js';
import { withIcyMetadata } from './icy.js';
import { parseM3u8 } from './m3u8.js';
import type { StreamFormat } from '../types/index.js';

export interface PipelineOptions {
  connectTimeoutMs: number;
  bufferSize: number;
  /** ICY metadata interval in bytes; 0 disables metadata injection. */
  icyMetaInt?: number;
  getMetadataTitle?: () => string;
  logger?: Logger;
}

export interface PipelineResult {
  stream: Readable;
  format: StreamFormat;
  contentType: string;
  /** Cleanup callback — aborts the upstream fetch. */
  close: () => void;
}

/**
 * Fetch an upstream audio source and return a readable stream.
 *
 * - HTTP(S) sources are proxied with timeout + abort support.
 * - HLS sources are resolved: the media playlist is fetched and the
 *   latest segment is streamed (live edge), following the playlist as
 *   it advances.
 * - ICY metadata blocks are injected when requested by the listener.
 */
export async function openStream(url: string, options: PipelineOptions): Promise<PipelineResult> {
  const logger = options.logger ?? createLogger(undefined, 'pipeline');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.connectTimeoutMs);

  try {
    const isHls = url.split('?')[0].toLowerCase().endsWith('.m3u8');
    if (isHls) {
      return await openHlsStream(url, options, controller, logger);
    }

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Icy-MetaData': '1', 'User-Agent': 'Livy/1.0' },
    });
    clearTimeout(timeout);
    if (!res.ok || !res.body) {
      throw new StreamError(`Upstream responded ${res.status} for ${url}`);
    }

    const format = formatFromUrl(url);
    const contentType = res.headers.get('content-type') ?? 'audio/mpeg';
    const nodeStream = Readable.fromWeb(res.body as never, { highWaterMark: options.bufferSize });

    const close = () => controller.abort();
    if (options.icyMetaInt && options.icyMetaInt > 0) {
      const title = options.getMetadataTitle ?? (() => 'Livy Radio');
      const wrapped = Readable.from(withIcyMetadata(asyncChunks(nodeStream), options.icyMetaInt, title));
      return { stream: wrapped, format, contentType, close };
    }
    return { stream: nodeStream, format, contentType, close };
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof StreamError) throw err;
    throw new StreamError(`Failed to open stream ${url}: ${(err as Error).message}`);
  }
}

async function* asyncChunks(stream: Readable): AsyncGenerator<Buffer> {
  for await (const chunk of stream) {
    yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
  }
}

async function openHlsStream(
  url: string,
  options: PipelineOptions,
  controller: AbortController,
  logger: ReturnType<typeof createLogger>,
): Promise<PipelineResult> {
  const playlistRes = await fetch(url, { signal: controller.signal });
  if (!playlistRes.ok) throw new StreamError(`HLS playlist fetch failed: ${playlistRes.status}`);
  let playlistText = await playlistRes.text();
  let parsed = parseM3u8(playlistText, url);

  // Master playlist → follow the first variant.
  if (parsed.isMaster && parsed.variants.length > 0) {
    const variantUrl = parsed.variants[0].uri;
    const vRes = await fetch(variantUrl, { signal: controller.signal });
    if (!vRes.ok) throw new StreamError(`HLS variant fetch failed: ${vRes.status}`);
    playlistText = await vRes.text();
    parsed = parseM3u8(playlistText, variantUrl);
  }

  if (parsed.segments.length === 0) {
    throw new StreamError('HLS playlist contains no segments');
  }

  const segments = [...parsed.segments];
  let index = Math.max(0, segments.length - 1); // start at live edge
  let lastSequence = segments[index].sequence;
  let closed = false;

  const generator = (async function* (): AsyncGenerator<Buffer> {
    try {
      while (!closed && !controller.signal.aborted) {
        const seg = segments[index];
        if (!seg) break;
        const segRes = await fetch(seg.uri, { signal: controller.signal });
        if (!segRes.ok || !segRes.body) {
          logger.warn('HLS segment fetch failed', { uri: seg.uri, status: segRes.status });
          index += 1;
          continue;
        }
        const body = Readable.fromWeb(segRes.body as never, { highWaterMark: options.bufferSize });
        for await (const chunk of body) {
          yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        }
        index += 1;
        // Refresh the playlist when we run out of known segments.
        if (index >= segments.length) {
          const refresh = await fetch(url, { signal: controller.signal }).catch(() => null);
          if (refresh?.ok) {
            const text = await refresh.text();
            const next = parseM3u8(text, url);
            for (const s of next.segments) {
              if (s.sequence > lastSequence) {
                segments.push(s);
                lastSequence = s.sequence;
              }
            }
          }
          if (index >= segments.length) break; // VOD finished
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) throw err;
    }
  })();

  const stream = Readable.from(generator, { highWaterMark: options.bufferSize });
  return {
    stream,
    format: 'hls',
    contentType: 'application/vnd.apple.mpegurl',
    close: () => {
      closed = true;
      controller.abort();
    },
  };
}
