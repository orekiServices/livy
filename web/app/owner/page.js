'use client'

/**
 * The studio.
 *
 * Everything an owner does from a phone: pick a station, drive it, program
 * the queue, say something on air, change how it mixes. Each job is a sheet
 * rather than a page so the audio never stops and nothing is more than two
 * taps away.
 */
import { useEffect, useState } from 'react'

import TopBar from '../../components/TopBar.js'
import Sheet from '../../components/Sheet.js'
import QueuePanel from '../../components/QueuePanel.js'
import AnnouncePanel from '../../components/AnnouncePanel.js'
import DJPanel from '../../components/DJPanel.js'
import PluginsPanel from '../../components/PluginsPanel.js'
import VoicePanel from '../../components/VoicePanel.js'
import KeyGate from '../../components/KeyGate.js'
import { useRadio } from '../../components/RadioProvider.js'
import { owner, ownerKey } from '../../lib/api.js'

function Tile({ glyph, label, hint, onClick }) {
  return (
    <button className="card" onClick={onClick} style={{ textAlign: 'left' }}>
      <div style={{ fontSize: 22 }} aria-hidden="true">
        {glyph}
      </div>
      <div style={{ fontWeight: 600, marginTop: 6 }}>{label}</div>
      <div className="dim">{hint}</div>
    </button>
  )
}

export default function StudioPage() {
  const { stations, say } = useRadio()
  const [authed, setAuthed] = useState(false)
  const [stationId, setStationId] = useState(null)
  const [panel, setPanel] = useState(null)
  const [info, setInfo] = useState(null)

  useEffect(() => setAuthed(Boolean(ownerKey())), [])
  useEffect(() => {
    if (!stationId && stations.length) setStationId(stations[0].id)
  }, [stations, stationId])

  useEffect(() => {
    if (!authed || !stationId) return
    owner(`/stations/${stationId}`)
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [authed, stationId, panel])

  if (!authed) {
    return (
      <>
        <TopBar title="Studio" subtitle="owner key required" />
        <main className="page">
          <KeyGate onUnlock={() => setAuthed(true)} />
        </main>
      </>
    )
  }

  const station = stations.find((entry) => entry.id === stationId) ?? null

  const control = async (action, label) => {
    try {
      await owner(`/stations/${stationId}/${action}`, { method: 'POST' })
      say(label)
    } catch (error) {
      say(error.message)
    }
  }

  return (
    <>
      <TopBar title="Studio" subtitle={station ? station.name : 'no stations yet'} />
      <main className="page">
        {stations.length > 1 ? (
          <div className="row" style={{ gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
            {stations.map((entry) => (
              <button
                key={entry.id}
                className={`chip ${entry.id === stationId ? 'on' : ''}`}
                onClick={() => setStationId(entry.id)}
                style={{ minHeight: 34 }}
              >
                <span className={`dot ${entry.state === 'playing' ? 'live' : ''}`} />
                {entry.name}
              </button>
            ))}
          </div>
        ) : null}

        {station ? (
          <>
            <div className="card" style={{ marginTop: 12 }}>
              <div className="row">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="truncate" style={{ fontWeight: 600 }}>
                    {station.nowPlaying?.track?.title ?? 'off air'}
                  </div>
                  <div className="dim truncate">{station.nowPlaying?.track?.artist ?? station.name}</div>
                </div>
                <span className="chip">{station.listeners ?? 0} 🎧</span>
              </div>

              <div className="row" style={{ gap: 8, marginTop: 12 }}>
                <button className="btn small grow" onClick={() => control('skip', 'Skipped')}>
                  ⏭ Skip
                </button>
                <button
                  className="btn small grow"
                  onClick={() => control(station.state === 'playing' ? 'stop' : 'start', station.state === 'playing' ? 'Stopped' : 'On air')}
                >
                  {station.state === 'playing' ? '⏹ Stop' : '▶ Start'}
                </button>
                <button className="btn small grow" onClick={() => control('reload', 'Playlist reloaded')}>
                  ⟳ Reload
                </button>
              </div>
            </div>

            <div className="section-title">Run the station</div>
            <div className="grid2">
              <Tile glyph="🗂" label="Queue" hint={`${station.queueLength ?? 0} queued · drag to reorder`} onClick={() => setPanel('queue')} />
              <Tile glyph="🎙" label="Announce" hint="canned lines or your own" onClick={() => setPanel('say')} />
              <Tile
                glyph="🎛"
                label="DJ booth"
                hint={info?.automix?.effect ? `${info.automix.effect} · ${(info.automix.crossfadeMs / 1000).toFixed(1)}s · hear it` : 'transitions you can audition'}
                onClick={() => setPanel('mix')}
              />
              <Tile glyph="🔌" label="Plugins" hint="switches and settings" onClick={() => setPanel('plugins')} />
              <Tile glyph="🗣" label="Voice" hint="service, language, pace" onClick={() => setPanel('voice')} />
              <Tile glyph="📻" label="Listen" hint="open the stream" onClick={() => setPanel('listen')} />
            </div>
          </>
        ) : (
          <p className="dim">No stations on this node yet — create one from the Radio tab.</p>
        )}
      </main>

      <Sheet open={panel === 'queue'} title="Queue" onClose={() => setPanel(null)}>
        {stationId ? <QueuePanel station={stationId} say={say} /> : null}
      </Sheet>

      <Sheet open={panel === 'say'} title="Say it on air" onClose={() => setPanel(null)}>
        {stationId ? <AnnouncePanel station={stationId} say={say} /> : null}
      </Sheet>

      <Sheet open={panel === 'mix'} title="DJ booth" onClose={() => setPanel(null)}>
        {stationId ? <DJPanel station={stationId} say={say} /> : null}
      </Sheet>

      <Sheet open={panel === 'plugins'} title="Plugins" onClose={() => setPanel(null)}>
        {/* Per station: the same list, but the switches and settings apply
            to this station only. */}
        <PluginsPanel station={stationId} say={say} />
      </Sheet>

      <Sheet open={panel === 'voice'} title="Voice" onClose={() => setPanel(null)}>
        <VoicePanel say={say} />
      </Sheet>

      <Sheet open={panel === 'listen'} title="Listen" onClose={() => setPanel(null)}>
        <p className="dim">One address, and it ends in .mp3 — paste it into any player.</p>
        <code
          style={{
            display: 'block',
            padding: 12,
            borderRadius: 12,
            background: 'var(--bg-soft)',
            border: '1px solid var(--line)',
            wordBreak: 'break-all',
            fontSize: 13
          }}
        >
          {typeof window !== 'undefined' ? `${window.location.origin}/stream/${stationId}.mp3` : ''}
        </code>
        <button
          className="btn block primary"
          style={{ marginTop: 12 }}
          onClick={() => {
            navigator.clipboard?.writeText(`${window.location.origin}/stream/${stationId}.mp3`)
            say('Stream URL copied')
          }}
        >
          Copy
        </button>
      </Sheet>
    </>
  )
}
