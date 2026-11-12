'use client'

/**
 * One WebSocket, one audio element, one source of truth.
 *
 * Every screen reads from here. The node pushes state changes over `/ws`
 * (tracks, queues, listeners, requests), so the UI never polls, and the
 * `<audio>` element lives in this provider rather than in a screen so that
 * navigating between tabs cannot interrupt playback — the thing a radio app
 * must never do.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { api, socketUrl, streamUrl } from '../lib/api.js'

const RadioContext = createContext(null)

export function useRadio() {
  const value = useContext(RadioContext)
  if (!value) throw new Error('useRadio must be used inside <RadioProvider>')
  return value
}

export default function RadioProvider({ children }) {
  const [stations, setStations] = useState([])
  const [stats, setStats] = useState(null)
  const [setup, setSetup] = useState(null)
  const [connected, setConnected] = useState(false)

  const [tuned, setTuned] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [volume, setVolume] = useState(0.9)
  const [toast, setToast] = useState(null)

  const audioRef = useRef(null)

  /* --------------------------- node state ---------------------------- */

  const refreshSetup = useCallback(async () => {
    try {
      const payload = await api('/api/v1/setup')
      setSetup(payload)
      return payload
    } catch {
      setSetup((current) => current ?? { configured: false, unreachable: true, stations: 0, sources: [], defaults: {} })
      return null
    }
  }, [])

  useEffect(() => {
    refreshSetup()
  }, [refreshSetup])

  useEffect(() => {
    let socket
    let retry
    let closed = false

    const patch = (id, fn) => setStations((list) => list.map((station) => (station.id === id ? fn(station) : station)))

    const connect = async () => {
      if (closed) return
      try {
        socket = new WebSocket(await socketUrl())
      } catch {
        retry = setTimeout(connect, 3000)
        return
      }

      socket.onopen = () => setConnected(true)
      socket.onerror = () => socket.close()
      socket.onclose = () => {
        setConnected(false)
        if (!closed) retry = setTimeout(connect, 3000)
      }

      socket.onmessage = (event) => {
        let message
        try {
          message = JSON.parse(event.data)
        } catch {
          return
        }

        switch (message.op) {
          case 'ready':
            setStations(message.stations)
            setStats(message.stats)
            setConnected(true)
            break
          case 'stats':
            setStats(message.data)
            break
          case 'track':
            patch(message.station, (station) => ({
              ...station,
              nowPlaying: message.data,
              artwork: message.data?.track?.artwork ?? station.artwork
            }))
            break
          case 'progress':
            patch(message.station, (station) =>
              station.nowPlaying ? { ...station, nowPlaying: { ...station.nowPlaying, positionMs: message.data.positionMs } } : station
            )
            break
          case 'state':
            patch(message.station, () => message.data.info)
            break
          case 'queue':
            patch(message.station, (station) => ({ ...station, queueLength: message.data.length, upNext: message.data.upNext }))
            break
          case 'requests':
            patch(message.station, (station) => ({ ...station, requests: message.data.requests, requestCount: message.data.count }))
            break
          case 'voteskip':
            patch(message.station, (station) => ({ ...station, voteSkips: { votes: message.data.votes, needed: message.data.needed } }))
            break
          case 'listeners':
            patch(message.station, (station) => ({ ...station, listeners: message.data.listeners }))
            break
          case 'stationAdded':
          case 'stationUpdated':
            setStations((list) =>
              list.some((station) => station.id === message.station)
                ? list.map((station) => (station.id === message.station ? message.data : station))
                : [...list, message.data]
            )
            setSetup((current) =>
              current ? { ...current, configured: true, stations: (current.stations ?? 0) + (message.op === 'stationAdded' ? 1 : 0) } : current
            )
            break
          case 'stationRemoved':
            setStations((list) => list.filter((station) => station.id !== message.station))
            break
          default:
            break
        }
      }
    }

    connect()
    return () => {
      closed = true
      clearTimeout(retry)
      socket?.close()
    }
  }, [])

  /* ----------------------------- playback ---------------------------- */

  const play = useCallback(
    async (id) => {
      const audio = audioRef.current
      if (!audio) return

      if (tuned === id && !audio.paused) {
        audio.pause()
        setPlaying(false)
        return
      }

      setLoading(true)
      setTuned(id)
      // A live stream must never be resumed from a stale buffer, so each
      // tune-in is a fresh request.
      audio.src = `${await streamUrl(id)}?t=${Date.now()}`
      audio.volume = volume
      try {
        await audio.play()
        setPlaying(true)
      } catch {
        setPlaying(false)
      } finally {
        setLoading(false)
      }
    },
    [tuned, volume]
  )

  const toggle = useCallback(async () => {
    const audio = audioRef.current
    if (!audio || !tuned) return
    if (audio.paused) {
      setLoading(true)
      audio.src = `${await streamUrl(tuned)}?t=${Date.now()}`
      try {
        await audio.play()
        setPlaying(true)
      } catch {
        setPlaying(false)
      } finally {
        setLoading(false)
      }
    } else {
      audio.pause()
      // Drop the connection rather than buffering audio nobody is hearing.
      audio.removeAttribute('src')
      audio.load()
      setPlaying(false)
    }
  }, [tuned])

  const changeVolume = useCallback((value) => {
    setVolume(value)
    if (audioRef.current) audioRef.current.volume = value
  }, [])

  /* ------------------------ listener actions ------------------------- */

  const command = useCallback((id, action, body) => api(`/api/v1/stations/${id}/${action}`, { method: 'POST', body: body ?? {} }), [])

  const search = useCallback(async (query, limit = 20) => {
    const payload = await api(`/api/v1/search?q=${encodeURIComponent(query)}&limit=${limit}`)
    return payload.tracks ?? []
  }, [])

  const say = useCallback((message) => {
    setToast(message)
    setTimeout(() => setToast((current) => (current === message ? null : current)), 2600)
  }, [])

  const current = useMemo(() => stations.find((station) => station.id === tuned) ?? null, [stations, tuned])

  /* ---------------------- OS media controls -------------------------- */

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
    const track = current?.nowPlaying?.track
    if (!track) return

    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: track.title ?? current.name,
      artist: track.artist ?? current.name,
      album: current.name,
      artwork: track.artwork ? [{ src: track.artwork, sizes: '512x512' }] : []
    })
    navigator.mediaSession.setActionHandler('play', () => toggle())
    navigator.mediaSession.setActionHandler('pause', () => toggle())
  }, [current, toggle])

  const value = useMemo(
    () => ({
      stations,
      stats,
      setup,
      connected,
      refreshSetup,
      tuned,
      current,
      playing,
      loading,
      volume,
      audioRef,
      play,
      toggle,
      setVolume: changeVolume,
      command,
      search,
      toast,
      say
    }),
    [stations, stats, setup, connected, refreshSetup, tuned, current, playing, loading, volume, play, toggle, changeVolume, command, search, toast, say]
  )

  return (
    <RadioContext.Provider value={value}>
      {children}
      {toast ? <div className="toast">{toast}</div> : null}
    </RadioContext.Provider>
  )
}
