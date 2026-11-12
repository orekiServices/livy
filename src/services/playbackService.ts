import type { DatabaseAdapter } from '../db/adapter.js';
import type { StationStatus } from '../types/index.js';
import { NotFoundError, StreamError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import { createLogger } from '../utils/logger.js';
import { openStream } from '../audio/pipeline.js';
import type { PipelineResult } from '../audio/pipeline.js';
import type { AppConfig } from '../types/index.js';

interface Session {
  stationId: string;
  startedAt: number;
  listeners: number;
  currentSourceId?: string;
  currentSourceUrl?: string;
  lastError?: string;
  close?: () => void;
}

/**
 * Playback sessions: opens the primary source for a station, tracks
 * listeners, and reports status. Each station has an independent
 * session — one station's playback never affects another.
 */
export class PlaybackService {
  private readonly sessions = new Map<string, Session>();
  private readonly logger: Logger;

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly config: AppConfig,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger(undefined, 'playback');
  }

  /** Open (or reuse) the stream for a station and return a live result. */
  async play(stationId: string): Promise<PipelineResult & { stationId: string }> {
    const station = await this.db.getStation(stationId);
    if (!station) throw new NotFoundError('Station', stationId);
    if (!station.enabled) throw new StreamError(`Station is disabled: ${station.slug}`);

    const sources = await this.db.listSources(stationId);
    const primary = sources.find((s) => s.enabled);
    if (!primary) throw new StreamError(`Station has no enabled stream source: ${station.slug}`);

    const session = this.sessionFor(stationId);
    if (session.listeners >= this.config.streamMaxListenersPerStation) {
      throw new StreamError(`Station listener limit reached: ${station.slug}`);
    }

    const result = await openStream(primary.url, {
      connectTimeoutMs: this.config.streamConnectTimeoutMs,
      bufferSize: this.config.streamBufferSize,
      icyMetaInt: 8192,
      getMetadataTitle: () => station.metadataTitle ?? station.name,
      logger: this.logger,
    });

    session.listeners += 1;
    session.currentSourceId = primary.id;
    session.currentSourceUrl = primary.url;
    session.lastError = undefined;
    session.close = result.close;
    this.logger.info('Playback started', { station: station.slug, listeners: session.listeners });

    const originalClose = result.close;
    result.close = () => {
      session.listeners = Math.max(0, session.listeners - 1);
      originalClose();
    };
    return { ...result, stationId };
  }

  status(stationId: string): StationStatus {
    const session = this.sessions.get(stationId);
    return {
      stationId,
      online: !!session?.currentSourceUrl,
      listeners: session?.listeners ?? 0,
      currentSourceId: session?.currentSourceId,
      currentSourceUrl: session?.currentSourceUrl,
      uptimeMs: session ? Date.now() - session.startedAt : 0,
      lastError: session?.lastError,
    };
  }

  async allStatuses(): Promise<StationStatus[]> {
    const stations = await this.db.listStations();
    return stations.map((s) => this.status(s.id));
  }

  /** Graceful shutdown: abort all upstream streams. */
  shutdown(): void {
    for (const session of this.sessions.values()) {
      try {
        session.close?.();
      } catch {
        // ignore — shutting down
      }
    }
    this.sessions.clear();
  }

  private sessionFor(stationId: string): Session {
    let session = this.sessions.get(stationId);
    if (!session) {
      session = { stationId, startedAt: Date.now(), listeners: 0 };
      this.sessions.set(stationId, session);
    }
    return session;
  }
}
