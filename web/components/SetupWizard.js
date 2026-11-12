'use client'

/**
 * First run: a node with no stations.
 *
 * Three fields and a button. Anything else — transitions, the DJ, plugins —
 * can be changed later from the studio, and defaults that work are better
 * than a form that asks twelve questions before you have heard anything.
 */
import { useEffect, useState } from 'react'

import KeyGate from './KeyGate.js'
import { api, owner, ownerKey } from '../lib/api.js'

/** One ready-made playlist line per source, so nobody has to read the docs. */
const STARTERS = [
  { id: 'scsearch:lofi hip hop mix', label: 'Lo-fi beats', hint: 'SoundCloud' },
  { id: 'adsearch:electronic', label: 'Electronic', hint: 'Audius, 320 kbps' },
  { id: 'soma:groovesalad', label: 'Groove Salad', hint: 'SomaFM relay' },
  { id: 'rp:mellow', label: 'Radio Paradise', hint: 'lossless FLAC' },
  { id: 'iasearch:jazz 1950s', label: 'Old jazz', hint: 'archive.org' },
  { id: 'ccsearch:ambient', label: 'Ambient', hint: 'ccMixter' }
]

export default function SetupWizard({ onDone }) {
  const [authed, setAuthed] = useState(false)
  const [name, setName] = useState('My Station')
  const [playlist, setPlaylist] = useState(STARTERS[0].id)
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [needsKey, setNeedsKey] = useState(true)

  useEffect(() => {
    api('/api/v1/setup')
      .then((payload) => {
        setNeedsKey(Boolean(payload.protected))
        setAuthed(!payload.protected || Boolean(ownerKey()))
      })
      .catch(() => {})
  }, [])

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const station = await owner('/stations', {
        method: 'POST',
        body: {
          name: name.trim() || 'My Station',
          playlists: [custom.trim() || playlist],
          allowRequests: true,
          // Sensible radio out of the box: the node picks its own
          // transitions and beatmatches where it can.
          automix: { enabled: true, effect: 'auto', crossfadeMs: 6000, beatmatch: true }
        }
      })
      onDone?.(station)
    } catch (problem) {
      setError(problem.message)
    } finally {
      setBusy(false)
    }
  }

  if (needsKey && !authed) return <KeyGate onUnlock={() => setAuthed(true)} />

  return (
    <div className="stack">
      <div className="card">
        <label className="field" htmlFor="station-name">
          Station name
        </label>
        <input id="station-name" type="text" value={name} onChange={(event) => setName(event.target.value)} />
      </div>

      <div className="section-title">What should it play?</div>
      <div className="grid2">
        {STARTERS.map((starter) => (
          <button
            key={starter.id}
            className="card"
            onClick={() => {
              setPlaylist(starter.id)
              setCustom('')
            }}
            style={{ textAlign: 'left', borderColor: !custom && playlist === starter.id ? 'var(--accent)' : 'var(--line)' }}
          >
            <div style={{ fontWeight: 600 }}>{starter.label}</div>
            <div className="dim">{starter.hint}</div>
          </button>
        ))}
      </div>

      <div className="card">
        <label className="field" htmlFor="custom-playlist">
          …or a search, a link, or a folder
        </label>
        <input
          id="custom-playlist"
          type="text"
          placeholder="scsearch:deep house · https://… · local:media"
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
        />
      </div>

      <button className="btn primary block" onClick={create} disabled={busy}>
        {busy ? <span className="spin" /> : 'Put it on air'}
      </button>
      {error ? <p className="error">{error}</p> : null}
    </div>
  )
}
