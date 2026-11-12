'use client'

/**
 * Now Playing — the one screen with a background of its own.
 *
 * YouTube Music's layout: big square artwork, title and artist under it, a
 * scrub line with times, a transport row, then tabs for lyrics and what is
 * up next. Behind all of it, Kawarp warps the cover into slow weather (see
 * NowPlayingBackground) — the only decoration in the console, and the
 * reason every other screen is flat black.
 */
import { useMemo, useState } from 'react'

import TopBar from '../../components/TopBar.js'
import Sheet from '../../components/Sheet.js'
import Lyrics from '../../components/Lyrics.js'
import NowPlayingBackground from '../../components/NowPlayingBackground.js'
import { useRadio } from '../../components/RadioProvider.js'
import { api } from '../../lib/api.js'
import { Play, Pause, SkipNext, Note, Volume, Mic, Queue as QueueIcon, Lyrics as LyricsIcon } from '../../components/icons.js'

const asTime = (ms) => {
  if (!ms || ms < 0) return '0:00'
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function RequestSheet({ station, open, onClose, say }) {
  const { search } = useRadio()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [busy, setBusy] = useState(false)

  const run = async (event) => {
    event.preventDefault()
    if (!query.trim()) return
    setBusy(true)
    try {
      setResults(await search(query.trim(), 12))
    } catch (error) {
      say(error.message)
    } finally {
      setBusy(false)
    }
  }

  const request = async (track) => {
    try {
      await api(`/api/v1/stations/${station}/request`, { method: 'POST', body: { track } })
      say(`Requested “${track.title}”`)
      onClose()
    } catch (error) {
      say(error.message)
    }
  }

  return (
    <Sheet open={open} title="Request a song" onClose={onClose}>
      <form onSubmit={run} className="row" style={{ gap: 8 }}>
        <input type="search" placeholder="Song, artist or link" value={query} onChange={(event) => setQuery(event.target.value)} />
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? <span className="spin" /> : 'Find'}
        </button>
      </form>

      <div className="stack" style={{ marginTop: 12 }}>
        {results.map((track) => (
          <button key={`${track.source}:${track.id}`} className="row-item" onClick={() => request(track)}>
            {track.artwork ? <img className="art" src={track.artwork} alt="" /> : <div className="art">🎵</div>}
            <div className="body">
              <div className="t truncate">{track.title}</div>
              <div className="s truncate">
                {track.artist} · {track.source}
              </div>
            </div>
          </button>
        ))}
      </div>
    </Sheet>
  )
}

export default function NowPlayingPage() {
  const { stations, tuned, current, play, playing, loading, command, say, volume, setVolume } = useRadio()
  const [tab, setTab] = useState('lyrics')
  const [requesting, setRequesting] = useState(false)

  const station = current ?? stations.find((entry) => entry.state === 'playing') ?? stations[0] ?? null
  const np = station?.nowPlaying ?? null
  const track = np?.track

  const progress = useMemo(() => {
    if (!np?.durationMs) return 0
    return Math.min(100, ((np.positionMs ?? 0) / np.durationMs) * 100)
  }, [np])

  if (!station) {
    return (
      <>
        <TopBar title="Now playing" subtitle="nothing yet" />
        <main className="page">
          <p className="dim">No stations on this node yet.</p>
        </main>
      </>
    )
  }

  return (
    <>
      <NowPlayingBackground artwork={track?.artwork ?? station.artwork ?? null} />

      <TopBar title={station.name} subtitle={np?.quality === 'hi-res' ? `hi-res · ${np.bitrate}k` : (station.genre ?? 'on air')} />

      <main className="np">
        {track?.artwork ? (
          <img className="np-cover" src={track.artwork} alt="" />
        ) : (
          <div className="np-cover" style={{ display: 'grid', placeItems: 'center' }}>
            <Note size={64} color="#717171" />
          </div>
        )}

        <div className="np-title truncate">{track?.title ?? station.name}</div>
        <div className="np-artist truncate">{track?.artist ?? 'off air'}</div>

        <div className="np-scrub">
          <i style={{ width: `${progress}%` }} />
        </div>
        <div className="np-times">
          <span>{asTime(np?.positionMs)}</span>
          <span>{np?.durationMs ? asTime(np.durationMs) : 'live'}</span>
        </div>

        <div className="np-transport">
          <button className="icon-btn" onClick={() => setRequesting(true)} aria-label="Request">
            <Mic size={24} />
          </button>
          <button className="np-play" onClick={() => play(station.id)} aria-label={playing ? 'Pause' : 'Play'}>
            {loading ? <span className="spin" /> : playing && tuned === station.id ? <Pause size={30} /> : <Play size={30} />}
          </button>
          <button
            className="icon-btn"
            onClick={() => command(station.id, 'voteskip').then(() => say('Vote counted')).catch((error) => say(error.message))}
            aria-label="Skip"
          >
            <SkipNext size={24} />
          </button>
        </div>

        <div className="row" style={{ gap: 10, margin: '6px 0 14px' }}>
          <Volume size={18} color="#aaaaaa" />
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={(event) => setVolume(Number(event.target.value))}
            style={{ flex: 1 }}
          />
        </div>

        <div className="chips">
          <button className={`chip ${tab === 'lyrics' ? 'on' : ''}`} onClick={() => setTab('lyrics')}>
            <LyricsIcon size={15} /> Lyrics
          </button>
          <button className={`chip ${tab === 'next' ? 'on' : ''}`} onClick={() => setTab('next')}>
            <QueueIcon size={15} /> Up next
          </button>
        </div>

        {tab === 'lyrics' ? (
          <Lyrics station={station.id} nowPlaying={np} />
        ) : (
          <div className="stack">
            {(station.upNext ?? []).map((item, index) => (
              <div key={`${item.id ?? item.title}-${index}`} className="row-item">
                <span className="queue-index">{index + 1}</span>
                <div className="body">
                  <div className="t truncate">{item.title}</div>
                  <div className="s truncate">{item.artist}</div>
                </div>
                {item.requestedBy ? <span className="chip quiet">request</span> : null}
              </div>
            ))}
            {(station.upNext ?? []).length === 0 ? <p className="dim">Nothing queued — the rotation takes over.</p> : null}
          </div>
        )}
      </main>

      <RequestSheet station={station.id} open={requesting} onClose={() => setRequesting(false)} say={say} />
    </>
  )
}
