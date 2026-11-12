import type { DatabaseAdapter } from '../db/adapter.js';
import type { CreateStreamSourceInput, StreamSource, UpdateStreamSourceInput } from '../types/index.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { newId } from '../utils/id.js';
import { formatFromUrl } from '../audio/codecs.js';

/** Stream source management, scoped to a station. */
export class StreamService {
  constructor(private readonly db: DatabaseAdapter) {}

  async create(stationId: string, input: CreateStreamSourceInput): Promise<StreamSource> {
    const station = await this.db.getStation(stationId);
    if (!station) throw new NotFoundError('Station', stationId);
    try {
      new URL(input.url);
    } catch {
      throw new ValidationError(`Invalid stream URL: ${input.url}`);
    }
    const now = new Date().toISOString();
    const source: StreamSource = {
      id: newId(),
      stationId,
      name: input.name,
      url: input.url,
      type: input.type ?? (input.url.split('?')[0].toLowerCase().endsWith('.m3u8') ? 'hls' : 'http'),
      format: input.format ?? formatFromUrl(input.url),
      priority: input.priority ?? 100,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    return this.db.createSource(source);
  }

  async list(stationId: string): Promise<StreamSource[]> {
    const station = await this.db.getStation(stationId);
    if (!station) throw new NotFoundError('Station', stationId);
    return this.db.listSources(stationId);
  }

  async get(id: string): Promise<StreamSource> {
    const source = await this.db.getSource(id);
    if (!source) throw new NotFoundError('Stream source', id);
    return source;
  }

  async update(id: string, patch: UpdateStreamSourceInput): Promise<StreamSource> {
    if (patch.url) {
      try {
        new URL(patch.url);
      } catch {
        throw new ValidationError(`Invalid stream URL: ${patch.url}`);
      }
    }
    const updated = await this.db.updateSource(id, patch);
    if (!updated) throw new NotFoundError('Stream source', id);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const ok = await this.db.deleteSource(id);
    if (!ok) throw new NotFoundError('Stream source', id);
  }

  /** Highest-priority enabled source for a station, or null. */
  async primarySource(stationId: string): Promise<StreamSource | null> {
    const sources = await this.db.listSources(stationId);
    return sources.find((s) => s.enabled) ?? null;
  }
}
