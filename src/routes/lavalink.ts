import type { FastifyInstance } from 'fastify';
import type { DatabaseAdapter } from '../db/adapter.js';
import type { LavalinkTrack, LoadResult } from '../types/index.js';
import { lavalinkAuth } from '../middleware/auth.js';
import { formatFromUrl } from '../audio/codecs.js';

/**
 * Lavalink v4 compatibility layer (NodeLink-inspired).
 *
 * Lets existing Lavalink clients resolve Livy stations as "tracks":
 * each station becomes a stream track whose `encoded` payload is
 * base64url(JSON { stationId, url }). This is intentionally a subset
 * of the full Lavalink protocol — Livy's native API is /api/v1/*.
 */

const VERSION = '1.0.0';

function encodeTrack(stationId: string, url: string, title: string, author: string): LavalinkTrack {
  const payload = Buffer.from(JSON.stringify({ stationId, url })).toString('base64url');
  return {
    encoded: payload,
    info: {
      identifier: stationId,
      isSeekable: false,
      author,
      length: 0,
      isStream: true,
      position: 0,
      title,
      uri: url,
      sourceName: 'livy',
    },
    pluginInfo: {},
    userData: {},
  };
}

export function decodeTrack(encoded: string): { stationId: string; url: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      stationId?: string;
      url?: string;
    };
    if (parsed.stationId && parsed.url) return { stationId: parsed.stationId, url: parsed.url };
    return null;
  } catch {
    return null;
  }
}

export async function registerLavalinkRoutes(
  app: FastifyInstance,
  db: DatabaseAdapter,
  password: string,
): Promise<void> {
  const auth = { preHandler: lavalinkAuth(password) };

  app.get('/v4/version', async () => ({ major: 4, minor: 0, patch: 0, preRelease: null, build: 0, semver: VERSION }));

  app.get('/v4/info', async () => ({
    version: { major: 4, minor: 0, patch: 0, preRelease: null, build: 0, semver: VERSION },
    buildTime: new Date().toISOString(),
    git: { branch: 'main', commit: 'livy-1.0.0', commitTime: new Date().toISOString() },
    jvm: 'Node.js',
    lavaplayer: 'livy-native',
    sourceManagers: ['livy'],
    plugins: [],
    filters: [],
    voiceRegions: [],
    isNodelink: false,
    isLivy: true,
  }));

  app.get('/v4/stats', async () => {
    const stations = await db.listStations();
    return {
      players: stations.length,
      playingPlayers: stations.filter((s) => s.enabled).length,
      uptime: Math.floor(process.uptime()),
      memory: {
        free: Math.max(0, process.memoryUsage().heapTotal - process.memoryUsage().heapUsed),
        used: process.memoryUsage().heapUsed,
        total: process.memoryUsage().heapTotal,
        reserved: process.memoryUsage().heapTotal,
      },
      cpu: { cores: 1, systemLoad: 0, lavalinkLoad: 0 },
      frameStats: { sent: 0, deficit: 0, nulled: 0, stuck: 0 },
    };
  });

  app.get('/v4/loadtracks', auth, async (req) => {
    const { identifier } = req.query as { identifier: string };
    const result: LoadResult = await resolveIdentifier(db, identifier);
    return result;
  });

  app.get('/v4/decodetrack', auth, async (req) => {
    const { encodedTrack } = req.query as { encodedTrack: string };
    const decoded = decodeTrack(encodedTrack);
    if (!decoded) return { error: 'INVALID_TRACK', message: 'Could not decode track' };
    const station = await db.getStation(decoded.stationId);
    return encodeTrack(decoded.stationId, decoded.url, station?.name ?? 'Livy Station', 'Livy');
  });

  app.post('/v4/decodetracks', auth, async (req) => {
    const { tracks } = req.body as { tracks: string[] };
    const out = [];
    for (const t of tracks) {
      const decoded = decodeTrack(t);
      if (!decoded) continue;
      const station = await db.getStation(decoded.stationId);
      out.push(encodeTrack(decoded.stationId, decoded.url, station?.name ?? 'Livy Station', 'Livy'));
    }
    return out;
  });
}

async function resolveIdentifier(db: DatabaseAdapter, identifier: string): Promise<LoadResult> {
  // Direct station id / slug lookup.
  const station = (await db.getStation(identifier)) ?? (await db.getStationBySlug(identifier));
  if (station) {
    const sources = await db.listSources(station.id);
    const primary = sources.find((s) => s.enabled);
    if (!primary) return { loadType: 'empty', data: [] };
    return {
      loadType: 'track',
      data: encodeTrack(station.id, primary.url, station.name, station.metadataTitle ?? station.name),
    };
  }

  // "livysearch:<query>" — search stations by name.
  const searchPrefix = 'livysearch:';
  if (identifier.startsWith(searchPrefix)) {
    const query = identifier.slice(searchPrefix.length).toLowerCase();
    const stations = await db.listStations();
    const matches = stations.filter((s) => s.name.toLowerCase().includes(query) || s.slug.includes(query));
    const tracks: LavalinkTrack[] = [];
    for (const s of matches) {
      const sources = await db.listSources(s.id);
      const primary = sources.find((src) => src.enabled);
      if (primary) tracks.push(encodeTrack(s.id, primary.url, s.name, s.metadataTitle ?? s.name));
    }
    return tracks.length > 0 ? { loadType: 'search', data: tracks } : { loadType: 'empty', data: [] };
  }

  // Direct URL → ephemeral track.
  try {
    const url = new URL(identifier);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return {
        loadType: 'track',
        data: encodeTrack('url', identifier, url.pathname.split('/').pop() || identifier, formatFromUrl(identifier)),
      };
    }
  } catch {
    // not a URL — fall through
  }

  return { loadType: 'empty', data: [] };
}
