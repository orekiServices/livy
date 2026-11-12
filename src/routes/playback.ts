import type { FastifyInstance } from 'fastify';
import type { PlaybackService } from '../services/playbackService.js';
import type { StationService } from '../services/stationService.js';

/**
 * Listener-facing playback endpoints.
 *  GET /stream/:stationId          — live audio stream (MP3/FLAC/…)
 *  GET /stream/:stationId/status   — JSON status
 *  GET /hls/:stationId/playlist.m3u8 — HLS media playlist (when source is HLS)
 */
export async function registerPlaybackRoutes(
  app: FastifyInstance,
  playback: PlaybackService,
  stations: StationService,
): Promise<void> {
  app.get('/stream/:stationId', async (req, reply) => {
    const station = await stations.get((req.params as { stationId: string }).stationId);
    const result = await playback.play(station.id);

    reply.raw.writeHead(200, {
      'Content-Type': result.contentType,
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    });

    const cleanup = () => result.close();
    req.raw.on('close', cleanup);
    result.stream.on('error', (err) => {
      req.log.error(err, 'Stream error');
      cleanup();
    });
    result.stream.pipe(reply.raw);
  });

  app.get('/stream/:stationId/status', async (req) => {
    const station = await stations.get((req.params as { stationId: string }).stationId);
    return playback.status(station.id);
  });

  app.get('/hls/:stationId/playlist.m3u8', async (req, reply) => {
    const station = await stations.get((req.params as { stationId: string }).stationId);
    const result = await playback.play(station.id);
    // For HLS sources the upstream playlist is proxied; for progressive
    // sources we serve the live stream URL as the single segment.
    if (result.format === 'hls') {
      result.close();
      return reply.redirect(`/stream/${station.id}`);
    }
    result.close();
    const playlist = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:6.0,',
      `/stream/${station.id}`,
      '',
    ].join('\n');
    return reply.type('application/vnd.apple.mpegurl').send(playlist);
  });
}
