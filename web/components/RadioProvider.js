'use client'

/**
 * The node, as the console sees it.
 *
 * One poller, one audio element, one owner key. Every page reads from here
 * instead of fetching on its own: a station wall that is three seconds old is
 * the same three seconds everywhere, and switching page does not restart the
 * stream.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { api, clearOwnerKey, owner, ownerKey, setOwnerKey as rememberKey, streamUrl } from '../lib/api.js'

const Radio = createContext(null)

export function useRadio() {
  const value = useContext(Radio)
  if (!value) throw new Error('useRadio outside <RadioProvider>')
  return value
}

/** The station the console is tuned to, if any. */
export function useStation(id) {
  const { stations } = useRadio()
  return stations.find((station) => station.id === id) ?? null
}

const POLL_MS = 4000
const VOLUME_KEY = 'livy-volume'
/** How many times a live stream is re-opened before the player admits defeat. */
const MAX_RETRIES = 5
/** Backoff between reconnects, in milliseconds. */
const RETRY_MS = [800, 1500, 3000, 6000, 10_000]
/**
 * How long a stream may go without progress before it is treated as dead.
 *
 * `stalled` and `waiting` fire for perfectly healthy streams too — a slow
 * network, a browser that paused the decoder — so acting on the event itself
 * would reconnect in a loop. Silence is the signal: no `timeupdate`, no
 * `playing`, no `canplay` for this long.
 */
const STALL_MS = 8000

export default function RadioProvider({ children }) {
  const [info, setInfo] = useState(null)
  const [setup, setSetup] = useState(null)
  const [stations, setStations] = useState([])
  const [ready, setReady] = useState(false)
  const [problem, setProblem] = useState(null)
  const [tuned, setTuned] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(0.8)
  const [key, setKey] = useState(null)
  const [ownerName, setOwnerName] = useState(null)
  // `buffering` is what the listener sees between pressing play and hearing
  // something; `playerError` is what they see when it did not work.
  const [buffering, setBuffering] = useState(false)
  const [playerError, setPlayerError] = useState(null)
  const audio = useRef(null)
  const wanted = useRef(null) // the station the listener asked to hear
  const retries = useRef(0)
  const retryTimer = useRef(null)
  const lastBeat = useRef(0)
  const reconnectRef = useRef(null)

  const refresh = useCallback(async ({ quiet = true } = {}) => {
    try {
      const [node, list] = await Promise.all([api('/api/v1/info'), api('/api/v1/stations')])
      setInfo(node)
      setStations(list.stations ?? [])
      setProblem(null)
      if (!quiet) setReady(true)
      // The setup payload carries the filter schema and the transition list:
      // it changes when a plugin does, so it is fetched, but not every tick.
      setSetup((current) => current ?? null)
      return { node, stations: list.stations ?? [] }
    } catch (error) {
      setProblem(error.message)
      return null
    } finally {
      setReady(true)
    }
  }, [])

  useEffect(() => {
    let stopped = false
    let timer = null
    const tick = async () => {
      if (stopped) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      await refresh()
    }
    refresh({ quiet: false })
    api('/api/v1/setup')
      .then((payload) => !stopped && setSetup(payload))
      .catch(() => {})
    timer = setInterval(tick, POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [refresh])

  // The key lives in sessionStorage; verify it once so a stale one says so.
  useEffect(() => {
    const stored = ownerKey()
    if (!stored) return
    setKey(stored)
    owner('/whoami')
      .then((answer) => setOwnerName(answer.owner ?? 'owner'))
      .catch(() => {
        clearOwnerKey()
        setKey(null)
      })
  }, [])

  const useKey = useCallback(async (value) => {
    rememberKey(value)
    setKey(value)
    try {
      const answer = await owner('/whoami', { key: value })
      setOwnerName(answer.owner ?? 'owner')
      return true
    } catch {
      clearOwnerKey()
      setKey(null)
      setOwnerName(null)
      return false
    }
  }, [])

  const forgetKey = useCallback(() => {
    clearOwnerKey()
    setKey(null)
    setOwnerName(null)
  }, [])

  /**
   * A heartbeat from the element: audio moved, so the stream is alive.
   *
   * The watchdog is a *clock*, not a timer on an event. A stream can die
   * without firing anything — a wifi network that goes away, a proxy that
   * stops writing — and a player waiting for `error` waits forever. Watching
   * the heartbeat catches both the loud failure and the silent one.
   */
  const beat = useCallback(() => {
    lastBeat.current = Date.now()
  }, [])

  /**
   * Open the station's stream.
   *
   * Three things matter here and all three were missing: the URL has to be the
   * *node's*, not the console's origin (in development the console is on a
   * different port, and a relative /stream URL 404s); a re-tune needs a cache
   * buster, because the browser will otherwise serve the connection it already
   * thinks it has; and a failure has to say so instead of silently doing
   * nothing.
   */
  const open = useCallback(async (stationId, { fresh = true } = {}) => {
    const element = audio.current
    if (!element) return false
    try {
      const base = await streamUrl(stationId)
      element.src = fresh ? `${base}?t=${Date.now()}` : base
      element.volume = volume
      await element.play()
      return true
    } catch (problem) {
      setPlaying(false)
      setBuffering(false)
      setPlayerError(problem?.message ?? 'the browser refused to play the stream')
      return false
    }
  }, [volume])

  const play = useCallback(async (stationId) => {
    wanted.current = stationId
    retries.current = 0
    setTuned(stationId)
    setPlayerError(null)
    setBuffering(true)
    const ok = await open(stationId)
    if (!ok) setBuffering(false)
  }, [open])

  /** Re-open the stream the listener asked for, with backoff. */
  const reconnect = useCallback(() => {
    beat()
    const stationId = wanted.current
    if (!stationId) return
    if (retryTimer.current) return
    if (retries.current >= MAX_RETRIES) {
      setBuffering(false)
      setPlayerError('the stream stopped and would not come back — press play to retry')
      return
    }
    const wait = RETRY_MS[Math.min(retries.current, RETRY_MS.length - 1)]
    retries.current += 1
    setBuffering(true)
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null
      if (wanted.current !== stationId) return
      open(stationId).then((ok) => {
        if (ok) setPlayerError(null)
        else reconnect()
      })
    }, wait)
  }, [beat, open])
  reconnectRef.current = reconnect

  const stop = useCallback(() => {
    lastBeat.current = 0
    wanted.current = null
    retries.current = 0
    if (retryTimer.current) {
      clearTimeout(retryTimer.current)
      retryTimer.current = null
    }
    const element = audio.current
    if (element) {
      element.pause()
      element.removeAttribute('src')
      element.load()
    }
    setPlaying(false)
    setBuffering(false)
  }, [])

  const toggle = useCallback(() => {
    const element = audio.current
    if (!element) return
    if (element.paused) {
      // Paused with nothing loaded (or after an error): start it again from
      // scratch rather than resuming a dead socket.
      if (!element.src || playerError) {
        if (!tuned) return
        retries.current = 0
        setPlayerError(null)
        play(tuned)
        return
      }
      setBuffering(true)
      element.play().then(() => setPlaying(true)).catch(() => {
        setBuffering(false)
        reconnect()
      })
    } else {
      element.pause()
      setPlaying(false)
      setBuffering(false)
    }
  }, [play, reconnect, tuned, playerError])

  const changeVolume = useCallback((value) => {
    setVolume(value)
    if (audio.current) audio.current.volume = value
    try {
      window.localStorage.setItem(VOLUME_KEY, String(value))
    } catch {
      /* private mode: the volume simply does not persist */
    }
  }, [])

  /**
   * While sound is supposed to be coming out, check that it is. Two seconds
   * between checks, `STALL_MS` of silence before acting, so a healthy stream
   * is never interrupted for being briefly slow.
   */
  useEffect(() => {
    if (!playing) return
    lastBeat.current = Date.now()
    const timer = setInterval(() => {
      if (!wanted.current) return
      if (Date.now() - lastBeat.current < STALL_MS) return
      lastBeat.current = Date.now()
      reconnectRef.current?.()
    }, 2000)
    return () => clearInterval(timer)
  }, [playing])

  // Remembered volume, so a listener does not reset it on every page load.
  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(VOLUME_KEY))
      if (Number.isFinite(saved) && saved >= 0 && saved <= 1) {
        setVolume(saved)
        if (audio.current) audio.current.volume = saved
      }
    } catch {
      /* nothing stored */
    }
  }, [])

  const value = useMemo(
    () => ({
      info,
      setup,
      stations,
      ready,
      problem,
      refresh,
      tuned,
      playing,
      buffering,
      playerError,
      volume,
      audio,
      play,
      stop,
      toggle,
      reconnect,
      changeVolume,
      key,
      ownerName,
      useKey,
      forgetKey,
      stationActions: {
        start: (id) => owner(`/stations/${id}/start`, { method: 'POST' }),
        stop: (id) => owner(`/stations/${id}/stop`, { method: 'POST' }),
        skip: (id) => owner(`/stations/${id}/skip`, { method: 'POST' }),
        shuffle: (id) => owner(`/stations/${id}/shuffle`, { method: 'POST' }),
        reload: (id) => owner(`/stations/${id}/reload`, { method: 'POST' })
      }
    }),
    [info, setup, stations, ready, problem, refresh, tuned, playing, buffering, playerError, volume, play, stop, toggle, reconnect, changeVolume, key, ownerName, useKey, forgetKey]
  )

  return (
    <Radio.Provider value={value}>
      {/*
        One element for the whole console, rendered here and never unmounted:
        a page change must not interrupt the stream, and a station change swaps
        `src` on the same element. `preload="none"` keeps a console that is not
        playing from opening a connection at all.
      */}
      <audio
        ref={audio}
        preload="none"
        playsInline
        onPlay={() => {
          setPlaying(true)
          setBuffering(false)
          setPlayerError(null)
          retries.current = 0
          beat()
        }}
        onPause={() => {
          setPlaying(false)
          setBuffering(false)
        }}
        // Progress: the stream is alive.
        onTimeUpdate={beat}
        onCanPlay={beat}
        onPlaying={beat}
        onProgress={beat}
        onWaiting={() => {
          setBuffering(true)
          beat()
        }}
        onStalled={() => {
          setBuffering(true)
          beat()
        }}
        onError={() => {
          // `src` is cleared when the listener stops on purpose; that is not an
          // error, and reconnecting to it would fight the user.
          if (!wanted.current) return
          setBuffering(true)
          reconnect()
        }}
        onEnded={() => {
          // A station stream does not end; the connection did. Forever mode
          // makes a song long, not infinite from the socket's point of view.
          if (wanted.current) reconnect()
        }}
        className="hidden"
      />
      {children}
    </Radio.Provider>
  )
}
