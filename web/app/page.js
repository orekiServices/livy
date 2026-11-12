'use client'

/**
 * Home — the YouTube Music shape: a greeting, filter chips, then shelves.
 *
 * A radio node has fewer things than a streaming service, so the shelves
 * are the ones that actually mean something here: what is on air right now
 * (the big one), what each station is playing, and what has been played
 * recently. Everything is one tap from playing.
 */
import { useMemo, useState } from 'react'

import TopBar from '../components/TopBar.js'
import SetupWizard from '../components/SetupWizard.js'
import { useRadio } from '../components/RadioProvider.js'
import { Play, Note, RadioIcon } from '../components/icons.js'

const greeting = () => {
  const hour = new Date().getHours()
  if (hour < 5) return 'Late night'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function Tile({ station, tuned, playing, onPlay }) {
  const track = station.nowPlaying?.track
  const live = station.state === 'playing'
  const cover = track?.artwork ?? station.artwork

  return (
    <button className="tile" onClick={() => onPlay(station.id)}>
      <div className="cover">
        {cover ? <img className="cover" src={cover} alt="" style={{ margin: 0 }} /> : <RadioIcon size={34} color="#717171" />}
        {live ? (
          <span className="badge">
            {tuned === station.id && playing ? (
              <span className="bars">
                <i />
                <i />
                <i />
              </span>
            ) : (
              <span className="dot live" />
            )}
            {station.listeners ?? 0}
          </span>
        ) : null}
      </div>
      <div className="name truncate">{station.name}</div>
      <div className="meta truncate">{track ? `${track.artist} — ${track.title}` : (station.genre ?? 'off air')}</div>
    </button>
  )
}

function Row({ station, tuned, playing, onPlay }) {
  const track = station.nowPlaying?.track
  return (
    <button className="row-item" onClick={() => onPlay(station.id)}>
      {track?.artwork ?? station.artwork ? (
        <img className="art" src={track?.artwork ?? station.artwork} alt="" />
      ) : (
        <div className="art">
          <Note size={20} color="#717171" />
        </div>
      )}
      <div className="body">
        <div className="t truncate">{track?.title ?? station.name}</div>
        <div className="s truncate">
          {track ? `${track.artist} · ${station.name}` : (station.genre ?? station.state)}
        </div>
      </div>
      {tuned === station.id && playing ? (
        <span className="bars">
          <i />
          <i />
          <i />
        </span>
      ) : (
        <Play size={20} color="#717171" />
      )}
    </button>
  )
}

export default function HomePage() {
  const { stations, setup, tuned, playing, play, refreshSetup } = useRadio()
  const [filter, setFilter] = useState('all')

  const onAir = useMemo(() => stations.filter((station) => station.state === 'playing'), [stations])
  const quiet = useMemo(() => stations.filter((station) => station.state !== 'playing'), [stations])
  const relays = useMemo(() => stations.filter((station) => station.relaying), [stations])

  if (setup && !setup.configured && stations.length === 0) {
    return (
      <>
        <TopBar title="Welcome" subtitle="let's put this node on air" />
        <main className="page">
          <SetupWizard onDone={refreshSetup} />
        </main>
      </>
    )
  }

  const shown = filter === 'live' ? onAir : filter === 'relay' ? relays : stations

  return (
    <>
      <TopBar title={greeting()} />
      <main className="page">
        <div className="chips">
          <button className={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>
            All
          </button>
          <button className={`chip ${filter === 'live' ? 'on' : ''}`} onClick={() => setFilter('live')}>
            On air
          </button>
          {relays.length ? (
            <button className={`chip ${filter === 'relay' ? 'on' : ''}`} onClick={() => setFilter('relay')}>
              Relays
            </button>
          ) : null}
        </div>

        {onAir.length > 0 && filter === 'all' ? (
          <>
            <div className="shelf-head">
              <h2>On air now</h2>
              <span className="more">{onAir.length} station{onAir.length === 1 ? '' : 's'}</span>
            </div>
            <div className="shelf">
              {onAir.map((station) => (
                <Tile key={station.id} station={station} tuned={tuned} playing={playing} onPlay={play} />
              ))}
            </div>
          </>
        ) : null}

        <div className="shelf-head">
          <h2>{filter === 'all' ? 'Your stations' : filter === 'live' ? 'On air' : 'Relays'}</h2>
        </div>
        <div className="stack">
          {shown.map((station) => (
            <Row key={station.id} station={station} tuned={tuned} playing={playing} onPlay={play} />
          ))}
          {shown.length === 0 ? <p className="dim">Nothing here yet.</p> : null}
        </div>

        {filter === 'all' && quiet.length > 0 && onAir.length > 0 ? (
          <p className="dim" style={{ marginTop: 18 }}>
            {quiet.length} station{quiet.length === 1 ? '' : 's'} not broadcasting.
          </p>
        ) : null}
      </main>
    </>
  )
}
