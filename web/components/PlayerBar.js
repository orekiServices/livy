'use client'

import Link from 'next/link'

import { Play, Pause } from './icons.js'
import { useRadio } from './RadioProvider.js'

/**
 * The mini player: a rounded bar floating just above the tabs, showing
 * artwork, what is playing and one button — and a hairline of progress
 * along the bottom. Tapping it opens Now Playing, which is the only
 * gesture anybody looks for.
 */
export default function PlayerBar() {
  const { stations, tuned, playing, loading, toggle, audioRef } = useRadio()
  const station = stations.find((entry) => entry.id === tuned)
  const track = station?.nowPlaying?.track
  const position = station?.nowPlaying?.positionMs ?? 0
  const duration = station?.nowPlaying?.durationMs ?? 0
  const progress = duration > 0 ? Math.min(100, (position / duration) * 100) : 0

  return (
    <div className="player">
      <audio ref={audioRef} preload="none" crossOrigin="anonymous" />

      {track?.artwork ? (
        <img className="art" src={track.artwork} alt="" />
      ) : (
        <div className="art" aria-hidden="true">
          🎵
        </div>
      )}

      <Link href="/station/" className="info" style={{ minWidth: 0 }}>
        {station ? (
          <>
            <div className="t truncate">{track ? track.title : station.name}</div>
            <div className="s truncate">{track?.artist ?? station.name}</div>
          </>
        ) : (
          <>
            <div className="t">Nothing playing</div>
            <div className="s">Pick a station</div>
          </>
        )}
      </Link>

      <button className="icon-btn" onClick={toggle} disabled={!station} aria-label={playing ? 'Pause' : 'Play'}>
        {loading ? <span className="spin" /> : playing ? <Pause size={26} /> : <Play size={26} />}
      </button>

      <div className="bar">
        <i style={{ width: `${progress}%` }} />
      </div>
    </div>
  )
}
