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

import { api, clearOwnerKey, owner, ownerKey, setOwnerKey as rememberKey } from '../lib/api.js'

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
  const audio = useRef(null)

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

  const play = useCallback(async (stationId) => {
    const element = audio.current
    if (!element) return
    setTuned(stationId)
    // A fresh `?t=` restarts the stream when the same station is retuned
    // after a skip: the node's answer is a live stream, not a file.
    element.src = `/stream/${encodeURIComponent(stationId)}.mp3?t=${Date.now()}`
    element.volume = volume
    try {
      await element.play()
      setPlaying(true)
    } catch {
      setPlaying(false)
    }
  }, [volume])

  const stop = useCallback(() => {
    const element = audio.current
    if (element) {
      element.pause()
      element.removeAttribute('src')
      element.load()
    }
    setPlaying(false)
  }, [])

  const toggle = useCallback(() => {
    const element = audio.current
    if (!element) return
    if (element.paused) {
      if (!element.src && tuned) return play(tuned)
      element.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
    } else {
      element.pause()
      setPlaying(false)
    }
  }, [play, tuned])

  const changeVolume = useCallback((value) => {
    setVolume(value)
    if (audio.current) audio.current.volume = value
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
      volume,
      audio,
      play,
      stop,
      toggle,
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
    [info, setup, stations, ready, problem, refresh, tuned, playing, volume, play, stop, toggle, changeVolume, key, ownerName, useKey, forgetKey]
  )

  return <Radio.Provider value={value}>{children}</Radio.Provider>
}
