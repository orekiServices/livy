/** Shared TypeScript models for the Livy web console. */

export interface Track {
  id?: string
  title?: string
  artist?: string
  album?: string
  artwork?: string | null
  duration?: number | null
  bitrate?: number | null
  source?: string
  url?: string
  stream?: string
  cached?: boolean
  requester?: string | null
  meta?: Record<string, unknown>
  [key: string]: unknown
}

export interface NowPlaying {
  track?: Track | null
  startedAt?: number | null
  position?: number | null
  elapsed?: number | null
  cached?: boolean
  [key: string]: unknown
}

export interface StationStats {
  plays?: number
  skips?: number
  seams?: number
  cacheHits?: number
  errors?: number
  [key: string]: unknown
}

export interface StationSummary {
  id: string
  name: string
  description?: string
  genre?: string
  state?: string
  status?: string
  running?: boolean
  artwork?: string | null
  stream?: string
  listeners?: number
  queueLength?: number
  bufferedMs?: number
  allowRequests?: boolean
  upNext?: Track[]
  nowPlaying?: NowPlaying | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  automix?: Record<string, any> | null
  filters?: { active?: string[]; config?: Record<string, unknown> } | null
  dj?: { enabled?: boolean; mode?: string; [key: string]: unknown } | null
  seams?: Record<string, unknown> | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  forever?: Record<string, any> | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  foreverInfo?: Record<string, any> | null
  stats?: StationStats | null
  playlists?: string[]
  [key: string]: unknown
}

export interface MemoryBucketStats {
  name?: string
  enabled?: boolean
  entries?: number
  maxEntries?: number
  ttlMs?: number
  inflight?: number
  hits?: number
  misses?: number
  coalesced?: number
  sets?: number
  evictions?: number
  expired?: number
  hitRate?: number
}

export interface AudioDiskCacheStats {
  enabled?: boolean
  writable?: boolean
  entries?: number
  maxEntries?: number
  bytes?: number
  maxBytes?: number
  maxEntryBytes?: number
  ttlMs?: number
  hits?: number
  misses?: number
  writes?: number
  evictions?: number
  skipped?: number
  errors?: number
  hitRate?: number
}

export interface CacheStats {
  enabled?: boolean
  totalHits?: number
  totalMisses?: number
  hitRate?: number
  memory?: {
    resolve?: MemoryBucketStats
    search?: MemoryBucketStats
    trackUrl?: MemoryBucketStats
    [key: string]: MemoryBucketStats | undefined
  }
  audio?: AudioDiskCacheStats
  items?: CacheItem[]
}

export interface CacheItem {
  hash: string
  key?: string
  bytes?: number
  size?: number
  title?: string
  artist?: string
  source?: string
  hits?: number
  mtime?: number
  updatedAt?: number
  accessedAt?: number
  [key: string]: unknown
}

export interface NodeInfo {
  name?: string
  legacyNames?: string[]
  version?: string
  uptime?: number
  stations?: number
  listeners?: number
  language?: string
  sources?: string[]
  transitions?: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  models?: { model?: any; [key: string]: any }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  automixModel?: Record<string, any> | null
  device?: { profile?: string; cpus?: number; [key: string]: unknown }
  setup?: {
    needed?: boolean
    protected?: boolean
    [key: string]: unknown
  }
  fx?: {
    engine?: string
    version?: string
    native?: boolean
    [key: string]: unknown
  }
  engine?: {
    name?: string
    version?: string
    native?: boolean
    [key: string]: unknown
  }
  deployment?: {
    serverless?: boolean
    provider?: string
    storage?: string
    ephemeral?: boolean
    writable?: boolean
    limits?: { streaming?: boolean; [key: string]: unknown }
    [key: string]: unknown
  }
  cache?: CacheStats
  [key: string]: unknown
}

export interface StreamDiagnosis {
  ok: boolean
  status: number
  code: string | null
  reason: string | null
  message: string | null
  terminal: boolean
}

export type ThemeMode = 'dark' | 'light'

export interface ApiError extends Error {
  status?: number
  payload?: Record<string, unknown>
}
