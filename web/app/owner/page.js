'use client'

/**
 * The control room.
 *
 * One page, every owner action, no dead ends: start/stop/skip, the queue,
 * announcements, the DJ booth, the learned policy, requests and bans, plugins,
 * voice and the engine room. Phone first — the views are a horizontal dock
 * rather than routes so the audio element is never remounted.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import TopBar from '../../components/TopBar.js'
import QueuePanel from '../../components/QueuePanel.js'
import AnnouncePanel from '../../components/AnnouncePanel.js'
import DJPanel from '../../components/DJPanel.js'
import PluginsPanel from '../../components/PluginsPanel.js'
import VoicePanel from '../../components/VoicePanel.js'
import KeyGate from '../../components/KeyGate.js'
import ModelsPanel from '../../components/ModelsPanel.js'
import RequestsPanel from '../../components/RequestsPanel.js'
import OpsPanel from '../../components/OpsPanel.js'
import StationAdminPanel from '../../components/StationAdminPanel.js'
import { useRadio } from '../../components/RadioProvider.js'
import { owner, ownerKey } from '../../lib/api.js'

const VIEWS = [
  { id: 'desk', label: 'Desk', glyph: '◉' },
  { id: 'queue', label: 'Queue', glyph: '≡' },
  { id: 'say', label: 'Say', glyph: '◍' },
  { id: 'mix', label: 'Mix', glyph: '≈' },
  { id: 'models', label: 'Models', glyph: '◆' },
  { id: 'requests', label: 'Line', glyph: '✉' },
  { id: 'plugins', label: 'Plugins', glyph: '⌁' },
  { id: 'voice', label: 'Voice', glyph: '◎' },
  { id: 'station', label: 'Station', glyph: '▤' },
  { id: 'ops', label: 'Ops', glyph: '⌘' }
]

const clock = (ms) => {
  if (!ms) return '—'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h) return `${h}h ${m}m`
  return `${m}m ${total % 60}s`
}

function QuickAction({ glyph, label, hint, onClick, tone = '' }) {
  return (
    <button className={`action ${tone}`} onClick={onClick}>
      <span className="action-glyph">{glyph}</span>
      <span className="action-label">{label}</span>
      {hint ? <span className="action-hint">{hint}</span> : null}
    </button>
  )
}

function Vitals({ station, info, stream }) {
  const listeners = station.listeners ?? 0
  const queued = station.queueLength ?? 0
  const state = station.state ?? 'idle'
  return (
    <div className="vitals">
      <div className="vital">
        <span className="vital-label">state</span>
        <strong className={`vital-value ${state === 'playing' ? 'live' : ''}`}>{state}</strong>
      </div>
      <div className="vital">
        <span className="vital-label">listeners</span>
        <strong className="vital-value">{listeners}</strong>
      </div>
      <div className="vital">
        <span className="vital-label">queued</span>
        <strong className="vital-value">{queued}</strong>
      </div>
      <div className="vital">
        <span className="vital-label">uptime</span>
        <strong className="vital-value">{clock(info?.uptime)}</strong>
      </div>
      <div className="vital">
        <span className="vital-label">engine</span>
        <strong className="vital-value small">{info?.engine ?? '—'}</strong>
      </div>
      <div className="vital">
        <span className="vital-label">stream</span>
        <button
          className="vital-value small link"
          onClick={() => {
            navigator.clipboard?.writeText(stream)
          }}
          title="Copy the listen URL"
        >
          .mp3 ⧉
        </button>
      </div>
    </div>
  )
}

export default function StudioPage() {
  const { stations, say, refreshSetup, setup } = useRadio()
  const [authed, setAuthed] = useState(false)
  const [stationId, setStationId] = useState(null)
  const [view, setView] = useState('desk')
  const [info, setInfo] = useState(null)
  const [model, setModel] = useState(null)
  const [busy, setBusy] = useState(null)
  const [notice, setNotice] = useState(null)

  useEffect(() => setAuthed(Boolean(ownerKey())), [])

  // An open node (no key, no password) needs no prompt. The setup payload is
  // the only place that knows, so apply it once it arrives.
  useEffect(() => {
    if (setup && !setup.protected) setAuthed(true)
  }, [setup])

  useEffect(() => {
    if (!stationId && stations.length) setStationId(stations[0].id)
    if (stationId && !stations.some((entry) => entry.id === stationId)) {
      setStationId(stations[0]?.id ?? null)
    }
  }, [stations, stationId])

  const loadInfo = useCallback(async () => {
    if (!authed || !stationId) return
    try {
      const payload = await owner(`/stations/${stationId}?queue=1`)
      setInfo(payload)
    } catch (problem) {
      setNotice(problem.message)
    }
  }, [authed, stationId])

  useEffect(() => {
    loadInfo()
    const timer = setInterval(loadInfo, 10_000)
    return () => clearInterval(timer)
  }, [loadInfo])

  useEffect(() => {
    if (!authed || !stationId) return
    owner(`/stations/${stationId}/dj-model`)
      .then(setModel)
      .catch(() => setModel(null))
  }, [authed, stationId, view])

  const station = useMemo(() => stations.find((entry) => entry.id === stationId) ?? null, [stations, stationId])
  const stream = typeof window !== 'undefined' && stationId ? `${window.location.origin}/stream/${stationId}.mp3` : ''

  if (!authed) {
    return (
      <>
        <TopBar title="Control room" subtitle={setup?.password?.configured ? 'owner password required' : 'owner key required'} />
        <main className="page">
          <KeyGate
            onUnlock={() => {
              setAuthed(true)
              say(setup?.password?.configured ? 'Owner password accepted' : 'Owner key accepted')
            }}
          />
        </main>
      </>
    )
  }

  const control = async (action, label) => {
    if (!stationId) return
    setBusy(action)
    try {
      await owner(`/stations/${stationId}/${action}`, { method: 'POST' })
      say(label)
      await loadInfo()
      await refreshSetup?.()
    } catch (problem) {
      setNotice(problem.message)
      say(problem.message)
    } finally {
      setBusy(null)
    }
  }

  const onAir = station?.state === 'playing'

  return (
    <>
      <TopBar title="Control room" subtitle={station ? `${station.name} · ${station.listeners ?? 0} listening` : 'no station selected'} />
      <main className="page studio">
        <div className="chips station-chips">
          {stations.map((entry) => (
            <button
              key={entry.id}
              className={`chip ${entry.id === stationId ? 'on' : ''}`}
              onClick={() => setStationId(entry.id)}
            >
              <span className={`dot ${entry.state === 'playing' ? 'live' : ''}`} />
              {entry.name}
            </button>
          ))}
          <button className={`chip ghost ${view === 'station' ? 'on' : ''}`} onClick={() => setView('station')}>
            + station
          </button>
        </div>

        {station ? (
          <>
            <section className="onair-card">
              <div className="onair-glow" />
              <div className="row" style={{ position: 'relative', gap: 14 }}>
                <div className={`live-orb ${onAir ? 'on' : ''}`}>
                  <span className="live-ring" />
                  <span className="live-core" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="eyebrow">{onAir ? 'On air' : 'Off air'} · {station.genre ?? 'unformatted'}</div>
                  <div className="onair-title truncate">{station.nowPlaying?.track?.title ?? station.name}</div>
                  <div className="onair-sub truncate">
                    {station.nowPlaying?.track?.artist ?? station.description ?? 'nothing playing'}
                  </div>
                </div>
                <div className="onair-model">
                  <span className="model-chip">{model?.model?.name ? 'AI mix' : 'heuristic mix'}</span>
                  <span className="dim small">{model?.last?.source ?? 'ready'}</span>
                </div>
              </div>
              <Vitals station={station} info={info} stream={stream} />
            </section>

            <div className="action-grid">
              <QuickAction
                glyph={onAir ? '⏹' : '▶'}
                label={onAir ? 'Stop' : 'Start'}
                hint={onAir ? 'take it off air' : 'put it on air'}
                onClick={() =>
                  control(onAir ? 'stop' : 'start', onAir ? 'Station stopped' : 'Station on air')
                }
              />
              <QuickAction glyph="⏭" label="Skip" hint="next track now" onClick={() => control('skip', 'Skipped')} />
              <QuickAction glyph="⇄" label="Shuffle" hint="reorder the queue" onClick={() => control('shuffle', 'Queue shuffled')} />
              <QuickAction glyph="⟳" label="Reload" hint="re-resolve sources" onClick={() => control('reload', 'Sources reloaded')} />
              <QuickAction glyph="✕" label="Clear queue" hint="start the rotation again" onClick={() => control('clear', 'Queue cleared')} />
              <QuickAction glyph="✎" label="Announce" hint="say it on air" onClick={() => setView('say')} />
            </div>

            {view === 'desk' ? (
              <div className="desk-grid">
                <div className="card stack">
                  <div className="section-head">
                    <div>
                      <div className="eyebrow">Automix</div>
                      <strong>{model?.model?.name ?? 'heuristic'}</strong>
                    </div>
                    <button className="btn tiny" onClick={() => setView('models')}>
                      Models
                    </button>
                  </div>
                  <div className="kv">
                    <span>auto-train</span>
                    <strong>{model?.auto?.enabled ? 'on' : 'off'}</strong>
                  </div>
                  <div className="kv">
                    <span>seams learned</span>
                    <strong>{model?.auto?.seams ?? 0}</strong>
                  </div>
                  <div className="kv">
                    <span>last run</span>
                    <strong>{model?.auto?.last?.ms ? `${model.auto.last.ms} ms` : 'never'}</strong>
                  </div>
                  <div className="kv">
                    <span>policy</span>
                    <strong>{model?.enabled === false ? 'pinned heuristic' : 'model ranks, heuristic gates'}</strong>
                  </div>
                  <button className="btn small" onClick={() => setView('mix')}>
                    Audition a transition
                  </button>
                </div>

                <div className="card stack">
                  <div className="section-head">
                    <div>
                      <div className="eyebrow">Line</div>
                      <strong>{info?.requestCount ?? 0} waiting</strong>
                    </div>
                    <button className="btn tiny" onClick={() => setView('requests')}>
                      Open
                    </button>
                  </div>
                  {(info?.requests ?? []).slice(0, 4).map((request) => (
                    <div key={request.id} className="mini-row">
                      <span className="pill">{request.votes}</span>
                      <span className="truncate grow">{request.track?.title}</span>
                    </div>
                  ))}
                  {!info?.requests?.length ? <div className="empty compact">The line is quiet.</div> : null}
                </div>

                <div className="card stack">
                  <div className="section-head">
                    <div>
                      <div className="eyebrow">Up next</div>
                      <strong>{info?.queueLength ?? 0} queued</strong>
                    </div>
                    <button className="btn tiny" onClick={() => setView('queue')}>
                      Edit
                    </button>
                  </div>
                  {(info?.queue ?? []).slice(0, 4).map((track, index) => (
                    <div key={track.id ?? index} className="mini-row">
                      <span className="queue-index">{index + 1}</span>
                      <span className="truncate grow">
                        {track.artist} — {track.title}
                      </span>
                    </div>
                  ))}
                  {!info?.queue?.length ? <div className="empty compact">Nothing programmed; the rotation will fill it.</div> : null}
                </div>

                <div className="card stack">
                  <div className="section-head">
                    <div>
                      <div className="eyebrow">Quick lines</div>
                      <strong>Announcements</strong>
                    </div>
                  </div>
                  {[
                    ['station-id', 'Station ident'],
                    ['back-soon', 'Back soon'],
                    ['goodnight', 'Goodnight']
                  ].map(([preset, label]) => (
                    <button
                      key={preset}
                      className="btn small ghost"
                      onClick={async () => {
                        try {
                          await owner(`/stations/${stationId}/say`, { method: 'POST', body: { preset } })
                          say(`${label} queued`)
                          await loadInfo()
                        } catch (problem) {
                          setNotice(problem.message)
                        }
                      }}
                    >
                      {label}
                    </button>
                  ))}
                  <button className="btn small" onClick={() => setView('say')}>
                    Write something
                  </button>
                </div>
              </div>
            ) : null}

            {view !== 'desk' ? (
              <div className="panel-wrap">
                {view === 'queue' ? <QueuePanel station={stationId} say={say} /> : null}
                {view === 'say' ? <AnnouncePanel station={stationId} say={say} /> : null}
                {view === 'mix' ? <DJPanel station={stationId} say={say} /> : null}
                {view === 'models' ? <ModelsPanel station={stationId} say={say} /> : null}
                {view === 'requests' ? <RequestsPanel station={stationId} say={say} /> : null}
                {view === 'plugins' ? <PluginsPanel station={stationId} say={say} /> : null}
                {view === 'voice' ? <VoicePanel say={say} /> : null}
                {view === 'station' ? (
                  <StationAdminPanel
                    station={stationId}
                    stations={stations}
                    say={say}
                    onChanged={async (created) => {
                      await refreshSetup?.()
                      if (created) setStationId(created)
                      setView('desk')
                    }}
                  />
                ) : null}
                {view === 'ops' ? <OpsPanel say={say} /> : null}
              </div>
            ) : null}
          </>
        ) : (
          <div className="card stack">
            <div className="empty">This node has no stations yet.</div>
            <button className="btn primary" onClick={() => setView('station')}>
              Create the first one
            </button>
          </div>
        )}

        <div className="dock">
          {VIEWS.map((entry) => (
            <button
              key={entry.id}
              className={`dock-item ${view === entry.id ? 'on' : ''}`}
              onClick={() => setView(entry.id)}
            >
              <span className="dock-glyph">{entry.glyph}</span>
              {entry.label}
            </button>
          ))}
        </div>

        {view === 'ops' && !station ? <OpsPanel say={say} /> : null}
        {notice ? (
          <button className="toast error" onClick={() => setNotice(null)}>
            {notice}
          </button>
        ) : null}
        {busy ? <div className="working" aria-hidden="true" /> : null}
      </main>
    </>
  )
}
