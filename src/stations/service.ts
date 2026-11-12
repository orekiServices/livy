import type { DatabaseAdapter } from "../db/adapter.js";
import { NotFoundError } from "../errors.js";
import type {
	CreatePlaylistInput,
	CreateStationInput,
	CreateStreamSourceInput,
	ImportStationInput,
	Playlist,
	Station,
	StationExport,
	StreamSource,
	UpdateStationInput,
	UpdateStreamSourceInput,
} from "../types.js";

/**
 * Station service — business logic for multi-station management.
 * Station state is fully isolated: every operation is scoped by station id.
 */
export class StationService {
	constructor(private readonly db: DatabaseAdapter) {}

	// ── Stations ──────────────────────────────────────────────────────────

	async listStations(opts?: { page?: number; pageSize?: number; search?: string }) {
		return this.db.listStations(opts);
	}

	async getStation(id: string): Promise<Station> {
		const station = await this.db.getStation(id);
		if (!station) throw new NotFoundError("Station", id);
		return station;
	}

	async getStationBySlug(slug: string): Promise<Station> {
		const station = await this.db.getStationBySlug(slug);
		if (!station) throw new NotFoundError("Station", slug);
		return station;
	}

	async createStation(input: CreateStationInput): Promise<Station> {
		const station = await this.db.createStation(input);
		// Mirror the convenience streamUrl into a stream source for failover.
		if (input.streamUrl) {
			await this.db.createStream(station.id, {
				name: "Primary",
				url: input.streamUrl,
				priority: 1,
			});
		}
		for (const [i, url] of (input.fallbackUrls ?? []).entries()) {
			await this.db.createStream(station.id, {
				name: `Fallback ${i + 1}`,
				url,
				priority: 10 + i,
			});
		}
		return station;
	}

	async updateStation(id: string, patch: UpdateStationInput): Promise<Station> {
		const updated = await this.db.updateStation(id, patch);
		if (!updated) throw new NotFoundError("Station", id);
		return updated;
	}

	async deleteStation(id: string): Promise<void> {
		const deleted = await this.db.deleteStation(id);
		if (!deleted) throw new NotFoundError("Station", id);
	}

	// ── Stream sources ────────────────────────────────────────────────────

	async listStreams(stationId: string): Promise<StreamSource[]> {
		await this.getStation(stationId);
		return this.db.listStreams(stationId);
	}

	async createStream(stationId: string, input: CreateStreamSourceInput): Promise<StreamSource> {
		await this.getStation(stationId);
		return this.db.createStream(stationId, input);
	}

	async updateStream(
		stationId: string,
		streamId: string,
		patch: UpdateStreamSourceInput,
	): Promise<StreamSource> {
		await this.getStation(stationId);
		const updated = await this.db.updateStream(stationId, streamId, patch);
		if (!updated) throw new NotFoundError("Stream source", streamId);
		return updated;
	}

	async deleteStream(stationId: string, streamId: string): Promise<void> {
		await this.getStation(stationId);
		const deleted = await this.db.deleteStream(stationId, streamId);
		if (!deleted) throw new NotFoundError("Stream source", streamId);
	}

	// ── Playlists ─────────────────────────────────────────────────────────

	async listPlaylists(stationId: string): Promise<Playlist[]> {
		await this.getStation(stationId);
		return this.db.listPlaylists(stationId);
	}

	async createPlaylist(stationId: string, input: CreatePlaylistInput): Promise<Playlist> {
		await this.getStation(stationId);
		return this.db.createPlaylist(stationId, input);
	}

	async deletePlaylist(stationId: string, playlistId: string): Promise<void> {
		await this.getStation(stationId);
		const deleted = await this.db.deletePlaylist(stationId, playlistId);
		if (!deleted) throw new NotFoundError("Playlist", playlistId);
	}

	// ── Import / export ───────────────────────────────────────────────────

	async exportStation(stationId: string): Promise<StationExport> {
		const station = await this.getStation(stationId);
		const [streams, playlists] = await Promise.all([
			this.db.listStreams(stationId),
			this.db.listPlaylists(stationId),
		]);
		return { version: 1, station, streams, playlists };
	}

	async importStation(data: ImportStationInput): Promise<Station> {
		if (data.version !== 1) {
			throw new Error(`Unsupported export version: ${String(data.version)}`);
		}
		const station = await this.db.createStation({
			name: data.station.name,
			slug: data.station.slug,
			description: data.station.description ?? undefined,
			streamUrl: data.station.streamUrl ?? undefined,
			fallbackUrls: data.station.fallbackUrls,
			coverUrl: data.station.coverUrl ?? undefined,
			tags: data.station.tags,
			isPublic: data.station.isPublic,
		});
		for (const s of data.streams) {
			await this.db.createStream(station.id, {
				name: s.name,
				url: s.url,
				protocol: s.protocol,
				codec: s.codec,
				priority: s.priority,
				enabled: s.enabled,
			});
		}
		for (const p of data.playlists) {
			await this.db.createPlaylist(station.id, { name: p.name, entries: p.entries });
		}
		return station;
	}
}
