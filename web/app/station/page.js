'use client'

/**
 * Now Playing — the words, and the record's colour behind them.
 *
 * The lyrics are the screen, not a tab on it: full height, a third of the
 * way down, over Kawarp warping the cover into slow weather (see
 * NowPlayingBackground). The rest of the console is chrome around that —
 * a one-line header, a scrub line, three buttons and the sync nudge. Every
 * other screen stays flat black so the artwork is the only colour here.
 *
 * The queue is still reachable, because a radio station without "what's
 * next" is a radio station you cannot argue with, but it is a sheet now
 * rather than half the screen.
 */
import { useMemo, useState } from 'react'

import Sheet from '../../components/Sheet.js'
import Lyrics from '../../components/Lyrics.js'
import NowPlayingBackground from '../../components/NowPlayingBackground.js'
import { useRadio } from '../../components/RadioProvider.js'
import { api } from '../../lib/api.js'
import { Play, Pause, SkipNext, Mic, Queue as QueueIcon } from '../../components/icons.js'

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
  const { stations, tuned, current, play, playing, loading, command, say } = useRadio()
  const [requesting, setRequesting] = useState(false)
  const [queuing, setQueuing] = useState(false)

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
        <div className="np">
          <p className="np-note">No stations on this node yet.</p>
        </div>
      </>
    )
  }

  return (
    <>
      <NowPlayingBackground artwork={track?.artwork ?? station.artwork ?? null} />

      <div className="np">
        {/* One line of chrome: what is playing, and what it is playing from. */}
        <header className="np-head">
          <div className="np-head-text">
            <span className="np-head-title truncate">{track?.title ?? station.name}</span>
            <span className="np-head-artist truncate">
              {track?.artist ?? 'off air'}
              <em> · {station.name}</em>
            </span>
          </div>
          <button className="np-head-btn" onClick={() => setQueuing(true)} aria-label="Up next">
            <QueueIcon size={20} />
          </button>
        </header>

        {/* The screen: the words, scrolling themselves. */}
        <Lyrics station={station.id} nowPlaying={np} />

        {/* The seat under them: the record's place in the song, then transport. */}
        <footer className="np-foot">
          <div className="np-scrub" aria-hidden="true">
            <i style={{ width: `${progress}%` }} />
          </div>
          <div className="np-times">
            <span>{asTime(np?.positionMs)}</span>
            <span>{np?.durationMs ? asTime(np.durationMs) : 'live'}</span>
          </div>

          <div className="np-transport">
            <button className="np-soft" onClick={() => setRequesting(true)} aria-label="Request a song">
              <Mic size={22} />
            </button>
            <button className="np-play" onClick={() => play(station.id)} aria-label={playing ? 'Pause' : 'Play'}>
              {loading ? <span className="spin" /> : playing && tuned === station.id ? <Pause size={28} /> : <Play size={28} />}
            </button>
            <button
              className="np-soft"
              onClick={() => command(station.id, 'voteskip').then(() => say('Vote counted')).catch((error) => say(error.message))}
              aria-label="Vote to skip"
            >
              <SkipNext size={22} />
            </button>
          </div>
        </footer>
      </div>

      <Sheet open={queuing} title="Up next" onClose={() => setQueuing(false)}>
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
      </Sheet>

      <RequestSheet station={station.id} open={requesting} onClose={() => setRequesting(false)} say={say} />
    </>
  )
}
