'use client'

/**
 * The request line, the play log, and the ban list — the three things an owner
 * actually checks at two in the morning.
 */
import { useCallback, useEffect, useState } from 'react'

import { owner } from '../lib/api.js'

export default function RequestsPanel({ station, say }) {
  const [requests, setRequests] = useState([])
  const [plays, setPlays] = useState([])
  const [bans, setBans] = useState([])
  const [voter, setVoter] = useState('')
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const [line, history, blocked] = await Promise.all([
        owner(`/stations/${station}/requests`),
        owner(`/stations/${station}/plays`),
        owner('/bans')
      ])
      setRequests(line.requests ?? [])
      setPlays(history.plays ?? [])
      setBans(blocked.bans ?? [])
      setError(null)
    } catch (problem) {
      setError(problem.message)
    }
  }, [station])

  useEffect(() => {
    load()
  }, [load])

  const act = async (fn, message) => {
    try {
      await fn()
      say?.(message)
      await load()
    } catch (problem) {
      setError(problem.message)
    }
  }

  return (
    <div className="stack">
      <div className="section-title">Waiting</div>
      <div className="list">
        {requests.length === 0 ? <div className="empty">The line is quiet.</div> : null}
        {requests.map((request) => (
          <div key={request.id} className="list-row">
            <span className="pill">{request.votes}</span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="truncate" style={{ fontWeight: 600 }}>
                {request.track?.title}
              </div>
              <div className="dim truncate">
                {request.track?.artist} · {request.by}
              </div>
            </div>
            <button
              className="btn tiny"
              onClick={() => act(() => owner(`/stations/${station}/requests/${request.id}`, { method: 'DELETE' }), 'Request removed')}
            >
              Drop
            </button>
          </div>
        ))}
      </div>
      {requests.length ? (
        <button className="btn small" onClick={() => act(() => owner(`/stations/${station}/requests`, { method: 'DELETE' }), 'Line cleared')}>
          Clear the line
        </button>
      ) : null}

      <div className="section-title">Recently played</div>
      <div className="list">
        {(plays ?? []).slice(0, 12).map((play, index) => (
          <div key={`${play.id ?? index}`} className="list-row">
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="truncate">{play.title ?? play.track?.title}</div>
              <div className="dim truncate">
                {play.artist ?? play.track?.artist} · {play.source ?? play.track?.source}
              </div>
            </div>
            <span className="dim">{play.started_at ? new Date(play.started_at).toLocaleTimeString() : ''}</span>
          </div>
        ))}
        {!plays.length ? <div className="empty">Nothing played yet.</div> : null}
      </div>

      <div className="section-title">Restricted listeners</div>
      <div className="row" style={{ gap: 8 }}>
        <input className="grow" placeholder="listener id" value={voter} onChange={(event) => setVoter(event.target.value)} />
        <button
          className="btn"
          disabled={!voter.trim()}
          onClick={() =>
            act(async () => {
              await owner('/bans', { method: 'POST', body: { voter: voter.trim() } })
              setVoter('')
            }, 'Listener restricted')
          }
        >
          Ban
        </button>
      </div>
      <div className="list">
        {bans.map((ban) => (
          <div key={ban.voter} className="list-row">
            <div className="grow truncate">{ban.voter}</div>
            <button className="btn tiny" onClick={() => act(() => owner(`/bans/${encodeURIComponent(ban.voter)}`, { method: 'DELETE' }), 'Ban lifted')}>
              Unban
            </button>
          </div>
        ))}
        {!bans.length ? <div className="empty">Nobody restricted.</div> : null}
      </div>

      {error ? <div className="error">{error}</div> : null}
    </div>
  )
}
