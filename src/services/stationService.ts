import type { DatabaseAdapter } from '../db/adapter.js';
import type {
  CreateStationInput,
  ImportResult,
  Station,
  StationExport,
  UpdateStationInput,
} from '../types/index.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import { newId, slugify } from '../utils/id.js';
import type { Logger } from '../utils/logger.js';
import { createLogger } from '../utils/logger.js';

/** Station lifecycle: CRUD, import/export. Stations are fully isolated. */
export class StationService {
  private readonly logger: Logger;

  constructor(
    private readonly db: DatabaseAdapter,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger(undefined, 'stations');
  }

  async create(input: CreateStationInput): Promise<Station> {
    const slug = input.slug ? slugify(input.slug) : slugify(input.name);
    const existing = await this.db.getStationBySlug(slug);
    if (existing) throw new ConflictError(`Station slug already exists: ${slug}`);
    const now = new Date().toISOString();
    const station: Station = {
      id: newId(),
      name: input.name,
      slug,
      description: input.description,
      streamUrl: input.streamUrl,
      defaultFormat: input.defaultFormat ?? 'mp3',
      metadataTitle: input.metadataTitle,
      categories: input.categories ?? [],
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    const created = await this.db.createStation(station);
    this.logger.info('Station created', { id: created.id, slug: created.slug });
    return created;
  }

  async get(idOrSlug: string): Promise<Station> {
    const byId = await this.db.getStation(idOrSlug);
    if (byId) return byId;
    const bySlug = await this.db.getStationBySlug(idOrSlug);
    if (bySlug) return bySlug;
    throw new NotFoundError('Station', idOrSlug);
  }

  async list(): Promise<Station[]> {
    return this.db.listStations();
  }

  async update(id: string, patch: UpdateStationInput): Promise<Station> {
    const current = await this.db.getStation(id);
    if (!current) throw new NotFoundError('Station', id);
    if (patch.slug) {
      const clash = await this.db.getStationBySlug(slugify(patch.slug));
      if (clash && clash.id !== id) throw new ConflictError(`Station slug already exists: ${patch.slug}`);
    }
    const normalized: UpdateStationInput = { ...patch };
    if (patch.slug) normalized.slug = slugify(patch.slug);
    const updated = await this.db.updateStation(id, normalized);
    if (!updated) throw new NotFoundError('Station', id);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const ok = await this.db.deleteStation(id);
    if (!ok) throw new NotFoundError('Station', id);
    this.logger.info('Station deleted', { id });
  }

  async exportStation(id: string): Promise<StationExport> {
    const station = await this.get(id);
    const [sources, playlists] = await Promise.all([
      this.db.listSources(station.id),
      this.db.listPlaylists(station.id),
    ]);
    return { version: 1, exportedAt: new Date().toISOString(), station, sources, playlists };
  }

  async importStation(data: StationExport): Promise<ImportResult> {
    if (data.version !== 1) throw new ConflictError(`Unsupported export version: ${data.version}`);
    // Make the slug unique when importing into a database that already
    // contains the original station (e.g. re-importing an export).
    let slug = data.station.slug;
    let suffix = 2;
    while (await this.db.getStationBySlug(slug)) {
      slug = `${data.station.slug}-${suffix}`;
      suffix += 1;
    }
    const station = await this.create({
      name: data.station.name,
      slug,
      description: data.station.description,
      streamUrl: data.station.streamUrl,
      defaultFormat: data.station.defaultFormat,
      metadataTitle: data.station.metadataTitle,
      categories: data.station.categories,
      enabled: data.station.enabled,
    });
    let sourcesImported = 0;
    for (const src of data.sources) {
      await this.db.createSource({
        ...src,
        id: newId(),
        stationId: station.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      sourcesImported += 1;
    }
    let playlistsImported = 0;
    for (const pl of data.playlists) {
      await this.db.createPlaylist({
        ...pl,
        id: newId(),
        stationId: station.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      playlistsImported += 1;
    }
    return { stationId: station.id, sourcesImported, playlistsImported };
  }
}
