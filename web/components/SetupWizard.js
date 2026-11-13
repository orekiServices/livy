'use client'

/**
 * First run: a node with no stations.
 *
 * Three fields and a button. Anything else — transitions, the DJ, plugins —
 * can be changed later from the studio, and defaults that work are better
 * than a form that asks twelve questions before you have heard anything.
 *
 * On a fresh node the first step is the owner password, not the key printed
 * in the log: a browser visitor can claim the node before it has a station,
 * and from then on the password is the credential. An explicit `OWNER_KEY`,
 * or a node that already has stations, still falls back to the key prompt.
 */
import { useEffect, useState } from 'react'

import KeyGate from './KeyGate.js'
import { api, owner, ownerKey, setOwnerKey } from '../lib/api.js'

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
  const [passwordState, setPasswordState] = useState({ configured: false, canSet: false, minLength: 8 })
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [passwordError, setPasswordError] = useState(null)

  useEffect(() => {
    api('/api/v1/setup', { key: ownerKey() })
      .then((payload) => {
        setPasswordState(payload.password ?? { configured: false, canSet: false, minLength: 8 })
        setNeedsKey(Boolean(payload.protected))
        setAuthed(Boolean(payload.owner) || !payload.protected)
      })
      .catch(() => {})
  }, [])

  const claim = async () => {
    setPasswordError(null)
    if (password.length < (passwordState.minLength ?? 8)) {
      setPasswordError(`Use at least ${passwordState.minLength ?? 8} characters.`)
      return
    }
    if (password !== confirmation) {
      setPasswordError('The two passwords do not match.')
      return
    }
    setBusy(true)
    try {
      await api('/api/v1/setup/password', { method: 'POST', body: { password } })
      setOwnerKey(password)
      setPasswordState((current) => ({ ...current, configured: true, canSet: false }))
      setNeedsKey(true)
      setAuthed(true)
    } catch (problem) {
      setPasswordError(problem.message)
    } finally {
      setBusy(false)
    }
  }

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

  if (passwordState.canSet && !passwordState.configured && !authed) {
    return (
      <div className="stack">
        <div className="card">
          <h3 style={{ margin: '0 0 6px' }}>Choose an owner password</h3>
          <p className="dim" style={{ marginTop: 0 }}>
            This is how you will sign in to this node. It replaces the setup key in the server log and is stored only as a
            hash.
          </p>
          <label className="field" htmlFor="owner-password">
            Password
          </label>
          <input
            id="owner-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            autoFocus
          />
          <label className="field" htmlFor="owner-password-confirm" style={{ marginTop: 10 }}>
            Confirm password
          </label>
          <input
            id="owner-password-confirm"
            type="password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && claim()}
            autoComplete="new-password"
          />
          <button className="btn primary block" style={{ marginTop: 12 }} onClick={claim} disabled={busy}>
            {busy ? <span className="spin" /> : 'Save password'}
          </button>
          {passwordError ? <p className="error">{passwordError}</p> : null}
        </div>
        <p className="dim small">
          Already have an owner key or password? <a href="/owner/">Open the control room</a>.
        </p>
      </div>
    )
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
