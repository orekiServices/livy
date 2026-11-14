'use client'

/**
 * Shared state for the console: node metadata, setup schema, station list,
 * owner credential, Studio/Daylight theme, and the persistent live <audio>
 * transport that survives page navigation.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'

import { api, clearOwnerKey, diagnoseStream, owner, ownerKey, setOwnerKey, streamUrl } from '../lib/api'
import type { NodeInfo, StationSummary, ThemeMode } from '../lib/types'

export interface StationActions {
  start: (id: string) => Promise<unknown>
  stop: (id: string) => Promise<unknown>
  skip: (id: string) => Promise<unknown>
  shuffle: (id: string) => Promise<unknown>
  reload: (id: string) => Promise<unknown>
}

export interface RadioContextValue {
  info: NodeInfo | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setup: Record<string, any> | null
  stations: StationSummary[]
  loading: boolean
  ready: boolean
  nodeError: string | null
  problem: string | null
  refresh: () => Promise<void>
  key: string | null
  ownerName: string | null
  keyChecked: boolean
  unlock: (candidate: string) => Promise<boolean>
  useKey: (candidate: string) => Promise<boolean>
  lock: () => void
  forgetKey: () => void
  theme: ThemeMode
  toggleTheme: () => void
  tunedId: string | null
  tuned: string | null
  tunedStation: StationSummary | null
  audio: RefObject<HTMLAudioElement | null>
  playing: boolean
  buffering: boolean
  volume: number
  muted: boolean
  streamError: string | null
  playerError: string | null
  streamErrorCode: string | null
  retryCount: number
  listen: (stationId: string) => Promise<void>
  play: (stationId: string) => Promise<void>
  stop: () => void
  retryStream: () => void
  reconnect: () => void
  clearStreamError: () => void
  togglePlay: () => void
  toggle: () => void
  setVolume: (next: number | string) => void
  changeVolume: (next: number | string) => void
  toggleMute: () => void
  stationActions: StationActions
}

const RadioContext = createContext<RadioContextValue | null>(null)

const VOLUME_STORE = 'livy-volume'
const THEME_STORE = 'livy-theme'
const POLL_MS = 6000
const MAX_RETRIES = 5
const STALL_MS = 18_000

const readStoredVolume = (): number => {
  if (typeof window === 'undefined') return 0.85
  const raw = Number(window.localStorage.getItem(VOLUME_STORE))
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.85
}

const readStoredTheme = (): ThemeMode => {
  if (typeof window === 'undefined') return 'dark'
  const saved = window.localStorage.getItem(THEME_STORE)
  return saved === 'light' || saved === 'dark' ? saved : 'dark'
}

export default function RadioProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<NodeInfo | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [setup, setSetup] = useState<Record<string, any> | null>(null)
  const [stations, setStations] = useState<StationSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [nodeError, setNodeError] = useState<string | null>(null)

  const [key, setKey] = useState<string | null>(null)
  const [ownerName, setOwnerName] = useState<string | null>(null)
  const [keyChecked, setKeyChecked] = useState(false)

  const [theme, setThemeState] = useState<ThemeMode>('dark')

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const attemptRef = useRef(0)
  const wantedRef = useRef<string | null>(null)
  const openingRef = useRef(false)
  const [tunedId, setTunedId] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [buffering, setBuffering] = useState(false)
  const [volume, setVolumeState] = useState(0.85)
  const [muted, setMuted] = useState(false)
  const [streamError, setStreamError] = useState<string | null>(null)
  const [streamErrorCode, setStreamErrorCode] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)

  const retryRef = useRef<{ count: number; timer: ReturnType<typeof setTimeout> | null }>({ count: 0, timer: null })
  const lastBeatRef = useRef(0)
  const lastTimeRef = useRef(0)

  const applyTheme = useCallback((next: ThemeMode | string) => {
    const mode: ThemeMode = next === 'light' ? 'light' : 'dark'
    setThemeState(mode)
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = mode
    }
    try {
      window.localStorage.setItem(THEME_STORE, mode)
    } catch {
      /* ignore */
    }
  }, [])

  const toggleTheme = useCallback(() => {
    applyTheme(theme === 'dark' ? 'light' : 'dark')
  }, [applyTheme, theme])

  useEffect(() => {
    const id = setTimeout(() => {
      setVolumeState(readStoredVolume())
      applyTheme(readStoredTheme())
    }, 0)
    return () => clearTimeout(id)
  }, [applyTheme])

  const refresh = useCallback(async () => {
    try {
      const [nextInfo, nextStations, nextSetup] = await Promise.all([
        api<NodeInfo>('/api/v1/info'),
        api<{ stations?: StationSummary[] } | StationSummary[]>('/api/v1/stations').then((res) =>
          Array.isArray(res) ? res : (res.stations ?? [])
        ),
        api<Record<string, unknown>>('/api/v1/setup').catch(() => null)
      ])
      setInfo(nextInfo)
      setStations(Array.isArray(nextStations) ? nextStations : [])
      if (nextSetup) setSetup(nextSetup)
      setNodeError(null)
    } catch (error) {
      setNodeError((error as Error)?.message ?? 'Node unreachable')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0)
    const timer = setInterval(() => void refresh(), POLL_MS)
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      clearTimeout(initial)
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  const verifyKey = useCallback(async (candidate: string | null): Promise<boolean> => {
    if (!candidate) {
      setOwnerName(null)
      setKeyChecked(true)
      return false
    }
    try {
      const who = await owner<{ name?: string }>('/whoami', { key: candidate })
      setOwnerName(who.name ?? 'owner')
      setKey(candidate)
      setOwnerKey(candidate)
      setKeyChecked(true)
      return true
    } catch {
      setOwnerName(null)
      setKeyChecked(true)
      return false
    }
  }, [])

  useEffect(() => {
    const saved = ownerKey()
    const initial = setTimeout(() => {
      if (saved) void verifyKey(saved)
      else setKeyChecked(true)
    }, 0)
    return () => clearTimeout(initial)
  }, [verifyKey])

  const unlock = useCallback(
    async (candidate: string): Promise<boolean> => {
      const trimmed = String(candidate ?? '').trim()
      if (!trimmed) return false
      return verifyKey(trimmed)
    },
    [verifyKey]
  )

  const lock = useCallback(() => {
    clearOwnerKey()
    setKey(null)
    setOwnerName(null)
  }, [])

  const clearRetry = useCallback(() => {
    if (retryRef.current.timer) {
      clearTimeout(retryRef.current.timer)
      retryRef.current.timer = null
    }
    retryRef.current.count = 0
    setRetryCount(0)
  }, [])

  const stop = useCallback(() => {
    attemptRef.current += 1
    wantedRef.current = null
    openingRef.current = false
    clearRetry()
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
    setPlaying(false)
    setBuffering(false)
    setStreamError(null)
    setStreamErrorCode(null)
  }, [clearRetry])

  const openRef = useRef<(stationId: string, opts?: { isRetry?: boolean }) => Promise<void>>(async () => {})

  const open = useCallback(
    async (stationId: string, { isRetry = false }: { isRetry?: boolean } = {}) => {
      const audio = audioRef.current
      if (!audio || !stationId) return

      const attempt = ++attemptRef.current
      wantedRef.current = stationId
      openingRef.current = true
      if (!isRetry) clearRetry()
      else if (retryRef.current.timer) {
        clearTimeout(retryRef.current.timer)
        retryRef.current.timer = null
      }

      setTunedId(stationId)
      if (!isRetry) {
        setStreamError(null)
        setStreamErrorCode(null)
      }
      setBuffering(true)
      lastBeatRef.current = Date.now()
      lastTimeRef.current = 0

      try {
        const url = await streamUrl(stationId)
        if (attempt !== attemptRef.current) return

        const sep = url.includes('?') ? '&' : '?'
        audio.src = `${url}${sep}t=${Date.now()}`
        audio.volume = muted ? 0 : volume
        await audio.play()
        if (attempt !== attemptRef.current) return
        openingRef.current = false
        setPlaying(true)
      } catch (error) {
        if (attempt !== attemptRef.current) return
        openingRef.current = false
        const err = error as Error | undefined
        if (err?.name === 'AbortError') return

        if (err?.name === 'NotAllowedError') {
          wantedRef.current = null
          clearRetry()
          setBuffering(false)
          setPlaying(false)
          setStreamError('Browser blocked playback. Click Play to start audio.')
          setStreamErrorCode('autoplay_blocked')
          return
        }

        const diag = await diagnoseStream(stationId)
        if (attempt !== attemptRef.current) return

        if (!diag.terminal && wantedRef.current === stationId && retryRef.current.count < MAX_RETRIES) {
          retryRef.current.count += 1
          const currentRetry = retryRef.current.count
          setRetryCount(currentRetry)
          const wait = Math.min(10_000, 1000 * 2 ** (currentRetry - 1))
          setBuffering(true)
          setPlaying(false)
          setStreamError(`Reconnecting (${currentRetry}/${MAX_RETRIES})`)
          setStreamErrorCode('reconnecting')
          retryRef.current.timer = setTimeout(() => {
            retryRef.current.timer = null
            if (attempt === attemptRef.current && wantedRef.current === stationId) {
              void openRef.current(stationId, { isRetry: true })
            }
          }, wait)
          return
        }

        wantedRef.current = null
        clearRetry()
        setBuffering(false)
        setPlaying(false)
        setStreamError(diag.message || err?.message || 'Could not start stream')
        setStreamErrorCode(diag.code || 'stream_error')
      }
    },
    [clearRetry, muted, volume]
  )

  useEffect(() => {
    openRef.current = open
  }, [open])

  const listen = useCallback((stationId: string) => open(stationId, { isRetry: false }), [open])

  const retryStream = useCallback(() => {
    const target = tunedId ?? wantedRef.current
    if (target) void open(target, { isRetry: false })
  }, [open, tunedId])

  const clearStreamError = useCallback(() => {
    setStreamError(null)
    setStreamErrorCode(null)
  }, [])

  const togglePlay = useCallback(() => {
    if (playing || buffering) return stop()
    const target = tunedId ?? stations[0]?.id
    if (target) void open(target, { isRetry: false })
  }, [buffering, open, playing, stations, stop, tunedId])

  const setVolume = useCallback(
    (next: number | string) => {
      const clamped = Math.min(1, Math.max(0, Number(next)))
      setVolumeState(clamped)
      if (clamped > 0 && muted) setMuted(false)
      if (audioRef.current) audioRef.current.volume = clamped
      try {
        window.localStorage.setItem(VOLUME_STORE, String(clamped))
      } catch {
        /* ignore */
      }
    },
    [muted]
  )

  const toggleMute = useCallback(() => {
    setMuted((was) => {
      const next = !was
      if (audioRef.current) audioRef.current.volume = next ? 0 : volume
      return next
    })
  }, [volume])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const beat = () => {
      lastBeatRef.current = Date.now()
    }

    const onPlaying = () => {
      beat()
      setBuffering(false)
      setPlaying(true)
      setStreamError(null)
      setStreamErrorCode(null)
      clearRetry()
    }

    const onTimeUpdate = () => {
      if (audio.currentTime > lastTimeRef.current) {
        lastTimeRef.current = audio.currentTime
        beat()
      }
    }

    const onWaiting = () => {
      setBuffering(true)
    }

    const onStalled = () => {
      setBuffering(true)
    }

    const handleInterrupt = async () => {
      const stationId = wantedRef.current
      if (!stationId) return
      if (!audio.getAttribute('src')) return
      // Avoid racing with an in-flight `open()` call or an already-scheduled reconnect.
      if (openingRef.current || retryRef.current.timer) return
      const activeAttempt = attemptRef.current

      const diag = await diagnoseStream(stationId)
      if (activeAttempt !== attemptRef.current) return

      if (diag.terminal) {
        wantedRef.current = null
        clearRetry()
        setPlaying(false)
        setBuffering(false)
        setStreamError(diag.message || 'Stream unavailable')
        setStreamErrorCode(diag.code || 'stream_error')
        return
      }

      if (retryRef.current.count >= MAX_RETRIES) {
        wantedRef.current = null
        setPlaying(false)
        setBuffering(false)
        setStreamError(diag.message || 'Stream disconnected after multiple retries')
        setStreamErrorCode(diag.code || 'disconnected')
        return
      }

      retryRef.current.count += 1
      const currentRetry = retryRef.current.count
      setRetryCount(currentRetry)
      const wait = Math.min(10_000, 1000 * 2 ** (currentRetry - 1))
      setBuffering(true)
      setStreamError(`Reconnecting (${currentRetry}/${MAX_RETRIES})`)
      setStreamErrorCode('reconnecting')
      retryRef.current.timer = setTimeout(() => {
        retryRef.current.timer = null
        if (activeAttempt === attemptRef.current && wantedRef.current === stationId) {
          void open(stationId, { isRetry: true })
        }
      }, wait)
    }

    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('waiting', onWaiting)
    audio.addEventListener('stalled', onStalled)
    audio.addEventListener('error', handleInterrupt)
    audio.addEventListener('ended', handleInterrupt)
    return () => {
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('waiting', onWaiting)
      audio.removeEventListener('stalled', onStalled)
      audio.removeEventListener('error', handleInterrupt)
      audio.removeEventListener('ended', handleInterrupt)
    }
  }, [clearRetry, open])

  useEffect(() => {
    if ((!playing && !buffering) || !tunedId) return
    const timer = setInterval(async () => {
      const stationId = wantedRef.current
      if (!stationId || !lastBeatRef.current) return
      if (Date.now() - lastBeatRef.current <= STALL_MS) return

      const activeAttempt = attemptRef.current
      const diag = await diagnoseStream(stationId)
      if (activeAttempt !== attemptRef.current) return

      if (diag.terminal) {
        wantedRef.current = null
        clearRetry()
        setPlaying(false)
        setBuffering(false)
        setStreamError(diag.message || 'Station stopped broadcasting')
        setStreamErrorCode(diag.code || 'stream_error')
        return
      }

      if (retryRef.current.count >= MAX_RETRIES) {
        wantedRef.current = null
        setPlaying(false)
        setBuffering(false)
        setStreamError('Stream stalled and could not recover')
        setStreamErrorCode('stalled')
        return
      }

      retryRef.current.count += 1
      setRetryCount(retryRef.current.count)
      setStreamError(`Stream stalled, reconnecting (${retryRef.current.count}/${MAX_RETRIES})`)
      setStreamErrorCode('reconnecting')
      void open(stationId, { isRetry: true })
    }, 5000)
    return () => clearInterval(timer)
  }, [buffering, clearRetry, open, playing, tunedId])

  const tunedStation = useMemo(
    () => stations.find((station) => station.id === tunedId) ?? null,
    [stations, tunedId]
  )

  const stationActions = useMemo<StationActions>(
    () => ({
      start: (id: string) => owner(`/stations/${encodeURIComponent(id)}/start`, { method: 'POST' }),
      stop: (id: string) => owner(`/stations/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
      skip: (id: string) => owner(`/stations/${encodeURIComponent(id)}/skip`, { method: 'POST' }),
      shuffle: (id: string) => owner(`/stations/${encodeURIComponent(id)}/shuffle`, { method: 'POST' }),
      reload: (id: string) => owner(`/stations/${encodeURIComponent(id)}/reload`, { method: 'POST' })
    }),
    []
  )

  const ready = !loading

  const value = useMemo<RadioContextValue>(
    () => ({
      info,
      setup,
      stations,
      loading,
      ready,
      nodeError,
      problem: nodeError,
      refresh,
      key,
      ownerName,
      keyChecked,
      unlock,
      useKey: unlock,
      lock,
      forgetKey: lock,
      theme,
      toggleTheme,
      tunedId,
      tuned: tunedId,
      tunedStation,
      audio: audioRef,
      playing,
      buffering,
      volume,
      muted,
      streamError,
      playerError: streamError,
      streamErrorCode,
      retryCount,
      listen,
      play: listen,
      stop,
      retryStream,
      reconnect: retryStream,
      clearStreamError,
      togglePlay,
      toggle: togglePlay,
      setVolume,
      changeVolume: setVolume,
      toggleMute,
      stationActions
    }),
    [
      buffering,
      clearStreamError,
      info,
      key,
      keyChecked,
      listen,
      loading,
      lock,
      muted,
      nodeError,
      ownerName,
      playing,
      ready,
      refresh,
      retryCount,
      retryStream,
      setVolume,
      setup,
      stationActions,
      stations,
      stop,
      streamError,
      streamErrorCode,
      theme,
      toggleMute,
      togglePlay,
      toggleTheme,
      tunedId,
      tunedStation,
      unlock,
      volume
    ]
  )

  return (
    <RadioContext.Provider value={value}>
      <audio ref={audioRef} preload="none" playsInline crossOrigin="anonymous" className="hidden" />
      {children}
    </RadioContext.Provider>
  )
}

export function useRadio(): RadioContextValue {
  const ctx = useContext(RadioContext)
  if (!ctx) throw new Error('useRadio() must be used inside <RadioProvider>')
  return ctx
}
