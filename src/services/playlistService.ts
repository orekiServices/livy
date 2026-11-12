import type { DatabaseAdapter } from '../db/adapter.js';
import type { CreatePlaylistInput, Playlist } from '../types/index.js';
import { NotFoundError } from '../utils/errors.js';
import { newId } from '../utils/id.js';
import { buildM3u, parseM3u } from '../audio/m3u8.js';

/** Playlist management, scoped to a station. */
export class PlaylistService {
  constructor(private readonly db: DatabaseAdapter) {}

  async create(stationId: string, input: CreatePlaylistInput): Promise<Playlist> {
    const station = await this.db.getStation(stationId);
    if (!station) throw new NotFoundError('Station', stationId);
    const now = new Date().toISOString();
    const playlist: Playlist = {
      id: newId(),
      stationId,
      name: input.name,
      entries: (input.entries ?? []).map((e) => ({
        id: newId(),
        title: e.title,
        url: e.url,
        duration: e.duration,
        artist: e.artist,
      })),
      createdAt: now,
      updatedAt: now,
    };
    return this.db.createPlaylist(playlist);
  }

  async list(stationId: string): Promise<Playlist[]> {
    const station = await this.db.getStation(stationId);
    if (!station) throw new NotFoundError('Station', stationId);
    return this.db.listPlaylists(stationId);
  }

  async get(id: string): Promise<Playlist> {
    const playlist = await this.db.getPlaylist(id);
    if (!playlist) throw new NotFoundError('Playlist', id);
    return playlist;
  }

  async update(id: string, patch: Partial<CreatePlaylistInput>): Promise<Playlist> {
    const updated = await this.db.updatePlaylist(id, {
      name: patch.name,
      entries: patch.entries?.map((e) => ({
        id: newId(),
        title: e.title,
        url: e.url,
        duration: e.duration,
        artist: e.artist,
      })),
    });
    if (!updated) throw new NotFoundError('Playlist', id);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const ok = await this.db.deletePlaylist(id);
    if (!ok) throw new NotFoundError('Playlist', id);
  }

  /** Import an M3U/M3U8 document as a new playlist. */
  async importM3u(stationId: string, name: string, content: string, baseUrl: string): Promise<Playlist> {
    const entries = parseM3u(content, baseUrl);
    return this.create(stationId, { name, entries });
  }

  /** Export a playlist as an extended M3U document. */
  async exportM3u(id: string): Promise<string> {
    const playlist = await this.get(id);
    return buildM3u(playlist.entries);
  }
}
