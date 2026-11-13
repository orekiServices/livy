'use client'

/**
 * The listener app: one station, one screen, one song.
 *
 * Deliberately the opposite of the owner console. There is no queue, no
 * settings, no table of numbers — the record that is playing, a station
 * switcher, and a search field that plays any song in the catalogue.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const STORE_KEY = 'livy.listen.station'

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) }
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `Request failed (${res.status})`
    throw new Error(message)
  }
  return body
}

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value))

function time(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00'
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

const initials = (text = '') =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase() || 'LV'

function Icon({ name, size = 20 }) {
  const paths = {
    play: <path d="M8 5.5v13l11-6.5z" fill="currentColor" />,
    pause: <path d="M7 5h4v14H7zm6 0h4v14h-4z" fill="currentColor" />,
    search: (
      <>
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4.5 4.5" />
      </>
    ),
    close: <path d="m6 6 12 12M18 6 6 18" />,
    chevron: <path d="m7 10 5 5 5-5" />,
    volume: (
      <>
        <path d="M5 10v4h3l4 4V6L8 10z" fill="currentColor" />
        <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
      </>
    ),
    radio: (
      <>
        <rect x="3" y="8" width="18" height="12" rx="3" />
        <path d="m7 8 10-4M7 13h3M7 16h6" />
        <circle cx="17" cy="14" r="2" />
      </>
    ),
    external: <path d="M14 4h6v6M20 4l-8 8M18 14v6H4V6h6" />,
    check: <path d="m5 12 5 5L20 7" />,
    spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
  }
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}

export default function ListenPage() {
  const [stations, setStations] = useState([])
  const [stationId, setStationId] = useState(null)
  const [station, setStation] = useState(null)
  const [mode, setMode] = useState('radio')
  const [song, setSong] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(0.85)
  const [now, setNow] = useState(Date.now())
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [error, setError] = useState(null)
  const [menu, setMenu] = useState(false)
  const [resolving, setResolving] = useState(null)
  const audio = useRef(null)
  const abort = useRef(null)
  const searchInput = useRef(null)

  const toast = useCallback((message) => {
    setError(message)
    window.clearTimeout(toast.timer)
    toast.timer = window.setTimeout(() => setError(null), 4200)
  }, [])

  useEffect(() => {
    api('/api/v1/stations')
      .then(({ stations: list }) => {
        setStations(list)
        const saved = window.localStorage.getItem(STORE_KEY)
        const chosen = list.find((entry) => entry.id === saved) ?? list[0]
        if (chosen) setStationId(chosen.id)
      })
      .catch((problem) => toast(problem.message))
  }, [toast])

  useEffect(() => {
    if (!stationId) return
    window.localStorage.setItem(STORE_KEY, stationId)
    let alive = true
    const load = () =>
      api(`/api/v1/stations/${encodeURIComponent(stationId)}`)
        .then((payload) => {
          if (!alive) return
          setStation(payload)
          setStations((list) => list.map((entry) => (entry.id === payload.id ? { ...entry, ...payload } : entry)))
        })
        .catch(() => {})
    load()
    const timer = window.setInterval(load, 6000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [stationId])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const element = audio.current
    if (!element) return
    element.volume = volume
  }, [volume])

  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }
    const controller = new AbortController()
    abort.current?.abort()
    abort.current = controller
    const timer = window.setTimeout(async () => {
      setSearching(true)
      try {
        const found = await api(`/api/v1/search?q=${encodeURIComponent(query.trim())}&limit=24`, { signal: controller.signal })
        setResults(found.tracks ?? [])
      } catch (problem) {
        if (problem.name !== 'AbortError') toast(problem.message)
      } finally {
        setSearching(false)
      }
    }, 280)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query, toast])

  const streamUrl = stationId ? `/stream/${encodeURIComponent(stationId)}.mp3` : null
  const radioNow = station?.nowPlaying ?? null

  const startRadio = useCallback(async () => {
    if (!streamUrl) return
    const element = audio.current
    setMode('radio')
    setSong(null)
    if (element.src !== new URL(streamUrl, window.location.href).href) element.src = streamUrl
    try {
      await element.play()
      setPlaying(true)
    } catch (problem) {
      toast(problem.message)
    }
  }, [streamUrl, toast])

  const playOnStation = useCallback(
    async (track, message) => {
      await api(`/api/v1/stations/${encodeURIComponent(stationId)}/play`, {
        method: 'POST',
        body: JSON.stringify({ track })
      })
      setSearchOpen(false)
      setQuery('')
      await startRadio()
      toast(message ?? `“${track.title}” is on air next`)
    },
    [stationId, startRadio, toast]
  )

  const playTrack = useCallback(
    async (track) => {
      setResolving(track.id)
      try {
        const { url } = await api('/api/v1/track-url', { method: 'POST', body: JSON.stringify({ track }) })
        if (!url) {
          // No direct file: ask the station to put it on air instead.
          await playOnStation(track)
          return
        }
        const element = audio.current
        setMode('song')
        element.src = url
        element.load()
        await element.play()
        setSong({ ...track, url })
        setPlaying(true)
        setSearchOpen(false)
        setQuery('')
      } catch (problem) {
        toast(problem.message)
      } finally {
        setResolving(null)
      }
    },
    [playOnStation, startRadio, toast]
  )

  const toggle = useCallback(async () => {
    const element = audio.current
    if (!element.src) return startRadio()
    if (element.paused) {
      try {
        await element.play()
        setPlaying(true)
      } catch (problem) {
        toast(problem.message)
      }
    } else {
      element.pause()
      setPlaying(false)
    }
  }, [startRadio, toast])

  const active = mode === 'song' && song ? { title: song.title, artist: song.artist, artwork: song.artwork, source: song.source } : {
    title: radioNow?.track?.title ?? station?.name ?? 'Off air',
    artist: radioNow?.track?.artist ?? (station ? `${station.name} · ${station.state}` : 'Pick a station'),
    artwork: radioNow?.track?.artwork ?? station?.artwork,
    source: radioNow?.sourceName ?? 'radio'
  }

  const duration = mode === 'song' ? (song?.duration ?? 0) : (radioNow?.durationMs ?? 0)
  const position = useMemo(() => {
    if (mode === 'song') return (audio.current?.currentTime ?? 0) * 1000
    if (!radioNow?.startedAt) return 0
    const live = now - radioNow.startedAt
    return clamp(live, 0, duration || live)
  }, [mode, now, radioNow?.startedAt, duration])

  const progress = duration ? clamp(position / duration, 0, 1) : 0
  const onAir = mode === 'radio' && ['playing', 'buffering', 'loading'].includes(station?.state)

  return (
    <div className={`app ${active.artwork ? 'has-art' : ''}`}>
      <div className="atmosphere" style={active.artwork ? { backgroundImage: `url("${active.artwork}")` } : undefined} />
      <div className="veil" />

      <header className="top">
        <div className="brand">
          <span className="mark">L</span>
          <span className="word">Livy</span>
          <span className="tag">listen</span>
        </div>

        <label className={`search ${searchOpen ? 'open' : ''}`}>
          <Icon name="search" />
          <input
            ref={searchInput}
            type="search"
            placeholder="Songs, artists, anything"
            value={query}
            onFocus={() => setSearchOpen(true)}
            onChange={(event) => {
              setQuery(event.target.value)
              setSearchOpen(true)
            }}
            aria-label="Search songs"
          />
          {query ? (
            <button className="icon" onClick={() => { setQuery(''); setResults([]) }} aria-label="Clear search">
              <Icon name="close" size={16} />
            </button>
          ) : null}
        </label>

        <div className="station-wrap">
          <button className="station-btn" onClick={() => setMenu((open) => !open)} aria-expanded={menu}>
            <span className={`dot ${onAir ? 'live' : ''}`} />
            <span className="truncate">{station?.name ?? 'Choose a station'}</span>
            <Icon name="chevron" size={16} />
          </button>
          {menu ? (
            <div className="menu" role="menu">
              {stations.map((entry) => (
                <button
                  key={entry.id}
                  className={`menu-row ${entry.id === stationId ? 'on' : ''}`}
                  onClick={() => {
                    setStationId(entry.id)
                    setMenu(false)
                    setMode('radio')
                    setSong(null)
                    if (audio.current) {
                      audio.current.pause()
                      audio.current.removeAttribute('src')
                    }
                    setPlaying(false)
                  }}
                >
                  <span className={`dot ${entry.state === 'playing' ? 'live' : ''}`} />
                  <span className="grow truncate">
                    <strong>{entry.name}</strong>
                    <small>{entry.nowPlaying?.track?.title ?? entry.genre ?? entry.state}</small>
                  </span>
                  <small className="count">{entry.listeners ?? 0}</small>
                  {entry.id === stationId ? <Icon name="check" size={16} /> : null}
                </button>
              ))}
              <a className="menu-link" href="/owner/">
                <Icon name="external" size={15} /> Manage stations
              </a>
            </div>
          ) : null}
        </div>
      </header>

      {searchOpen && query ? (
        <>
          <button className="scrim" onClick={() => setSearchOpen(false)} aria-label="Close search" />
          <section className="results" aria-label="Search results">
            <div className="results-head">
              <span>Top results</span>
              {searching ? <span className="spin" /> : <span className="count">{results.length}</span>}
            </div>
            {!searching && !results.length ? <div className="empty">Nothing found for “{query}”.</div> : null}
            {results.map((track) => (
              <button key={`${track.source}:${track.id}`} className="result" onClick={() => playTrack(track)} disabled={resolving === track.id}>
                {track.artwork ? <img src={track.artwork} alt="" loading="lazy" /> : <span className="fallback">{initials(track.title)}</span>}
                <span className="meta">
                  <strong className="truncate">{track.title}</strong>
                  <small className="truncate">{track.artist}{track.source ? ` · ${track.source}` : ''}</small>
                </span>
                <span className="action">
                  {resolving === track.id ? <span className="spin" /> : <Icon name="play" size={18} />}
                </span>
              </button>
            ))}
          </section>
        </>
      ) : null}

      <main className="stage">
        <div className="art-wrap">
          {active.artwork ? <img className="art" src={active.artwork} alt="" /> : <div className="art fallback-art">{initials(active.title)}</div>}
          <div className="art-glow" style={active.artwork ? { backgroundImage: `url("${active.artwork}")` } : undefined} />
          <span className={`badge ${onAir ? 'on' : ''}`}>
            <span className="dot" />
            {mode === 'song' ? 'your song' : onAir ? 'on air' : station?.state ?? 'offline'}
          </span>
        </div>

        <div className="info">
          <div className="eyebrow">{mode === 'song' ? 'Playing now' : station?.genre ?? 'Live radio'}</div>
          <h1 className={active.title?.length > 38 ? 'long' : ''}>{active.title}</h1>
          <p className="artist">{active.artist}</p>

          <div className="live-line">
            <span className={`pulse ${playing ? 'on' : ''}`} />
            <span>{playing ? (mode === 'song' ? 'playing from source' : 'streaming live') : 'paused'}</span>
            {mode === 'radio' && station ? <span className="sep">·</span> : null}
            {mode === 'radio' && station ? <span>{station.listeners ?? 0} listening</span> : null}
          </div>

          <div className="controls">
            <button className="play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
              <Icon name={playing ? 'pause' : 'play'} size={26} />
            </button>
            <button className={`mode ${mode === 'radio' ? 'on' : ''}`} onClick={startRadio} aria-pressed={mode === 'radio'}>
              <Icon name="radio" size={17} /> Live radio
            </button>
            <button
              className="mode"
              onClick={() => {
                setSearchOpen(true)
                window.requestAnimationFrame(() => searchInput.current?.focus())
              }}
            >
              <Icon name="search" size={17} /> Play a song
            </button>
          </div>

          <div className="progress">
            <span>{time(position)}</span>
            <div className="track" aria-hidden="true">
              <div className="fill" style={{ width: `${progress * 100}%` }} />
              {mode === 'radio' ? <div className="live-mark" /> : null}
            </div>
            <span>{duration ? time(duration) : mode === 'radio' ? 'live' : '0:00'}</span>
          </div>

          <div className="station-line">
            {station ? (
              <>
                <span className="eyebrow">Station</span>
                <button className="station-name" onClick={() => setMenu((open) => !open)}>{station.name}</button>
                <span className="dim">{station.description ?? station.genre ?? 'Continuous mix'}</span>
              </>
            ) : (
              <a className="station-name" href="/owner/">Create a station in the console →</a>
            )}
          </div>
        </div>
      </main>

      <div className="player">
        <div className="now">
          {active.artwork ? <img src={active.artwork} alt="" /> : <span className="fallback small">{initials(active.title)}</span>}
          <span className="meta">
            <strong className="truncate">{active.title}</strong>
            <small className="truncate">{active.artist}</small>
          </span>
        </div>
        <button className="play small-play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
          <Icon name={playing ? 'pause' : 'play'} size={20} />
        </button>
        <div className="mini-progress" aria-hidden="true">
          <div className="fill" style={{ width: `${progress * 100}%` }} />
        </div>
        <label className="volume">
          <Icon name="volume" size={16} />
          <input type="range" min="0" max="1" step="0.01" value={volume} onChange={(event) => setVolume(Number(event.target.value))} aria-label="Volume" />
        </label>
        <span className="engine">MetroS · Rust</span>
      </div>

      <audio
        ref={audio}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={() => {
          setPlaying(false)
          if (mode === 'song' && song) {
            // The provider's file is not playable in this browser (expired,
            // referer-locked, DRM). The node can still stream it, so put it
            // on air instead of losing the pick.
            playOnStation(song, `“${song.title}” could not open here — playing it on the station instead`).catch((problem) =>
              toast(problem.message)
            )
          }
        }}
      />

      {error ? <div className="toast" role="status">{error}</div> : null}
    </div>
  )
}
