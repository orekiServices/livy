'use client'

/**
 * Creating, programming and deleting stations. Everything here is the same
 * PATCH the API takes; the form exists so nobody has to remember the shape.
 */
import { useEffect, useState } from 'react'

import { owner } from '../lib/api.js'

const STARTERS = [
  { id: 'scsearch:lofi hip hop mix', label: 'Lo-fi', hint: 'SoundCloud' },
  { id: 'adsearch:electronic', label: 'Electronic', hint: 'Audius 320k' },
  { id: 'soma:groovesalad', label: 'Groove Salad', hint: 'SomaFM' },
  { id: 'rp:mellow', label: 'Mellow', hint: 'Radio Paradise' },
  { id: 'iasearch:jazz 1950s', label: 'Jazz', hint: 'archive.org' },
  { id: 'ccsearch:ambient', label: 'Ambient', hint: 'ccMixter' }
]

export default function StationAdminPanel({ station, stations = [], onChanged, say }) {
  const [form, setForm] = useState(null)
  const [creating, setCreating] = useState({ name: '', playlist: STARTERS[0].id, custom: '' })
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [confirm, setConfirm] = useState(false)

  useEffect(() => {
    if (!station) {
      setForm(null)
      return
    }
    owner(`/stations/${station}`)
      .then((info) =>
        setForm({
          name: info.name ?? '',
          genre: info.genre ?? '',
          description: info.description ?? '',
          allowRequests: info.allowRequests === true,
          allowPlayNow: info.allowPlayNow !== false,
          playlists: (info.playlists ?? []).join('\n')
        })
      )
      .catch((problem) => setError(problem.message))
  }, [station])

  const save = async () => {
    setBusy('save')
    setError(null)
    try {
      await owner(`/stations/${station}`, {
        method: 'PATCH',
        body: {
          name: form.name,
          genre: form.genre || null,
          description: form.description || null,
          allowRequests: form.allowRequests,
          allowPlayNow: form.allowPlayNow,
          playlists: form.playlists.split('\n').map((line) => line.trim()).filter(Boolean)
        }
      })
      say?.('Station saved')
      await onChanged?.()
    } catch (problem) {
      setError(problem.message)
    } finally {
      setBusy(null)
    }
  }

  const create = async () => {
    setBusy('create')
    setError(null)
    try {
      const created = await owner('/stations', {
        method: 'POST',
        body: {
          name: creating.name.trim() || 'New station',
          playlists: [creating.custom.trim() || creating.playlist],
          allowRequests: true,
          automix: { enabled: true, effect: 'auto', crossfadeMs: 6000, beatmatch: true, model: true }
        }
      })
      say?.(`${created.name ?? 'Station'} is on air`)
      setCreating({ name: '', playlist: STARTERS[0].id, custom: '' })
      await onChanged?.(created.id)
    } catch (problem) {
      setError(problem.message)
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    setBusy('remove')
    try {
      await owner(`/stations/${station}`, { method: 'DELETE' })
      say?.('Station deleted')
      setConfirm(false)
      await onChanged?.()
    } catch (problem) {
      setError(problem.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="stack">
      {form ? (
        <>
          <div className="section-title">Programme</div>
          <div className="card stack">
            <label className="field" htmlFor="station-name">
              Name
            </label>
            <input id="station-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />

            <label className="field" htmlFor="station-genre">
              Genre
            </label>
            <input id="station-genre" value={form.genre} onChange={(event) => setForm({ ...form, genre: event.target.value })} />

            <label className="field" htmlFor="station-description">
              Description
            </label>
            <textarea
              id="station-description"
              rows={2}
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />

            <label className="field" htmlFor="station-playlists">
              Sources — one per line
            </label>
            <textarea
              id="station-playlists"
              rows={4}
              value={form.playlists}
              onChange={(event) => setForm({ ...form, playlists: event.target.value })}
            />
            <div className="dim">scsearch:… · adsearch:… · local:media · https://… — resolved when the rotation needs more.</div>

            <label className="check">
              <input
                type="checkbox"
                checked={form.allowRequests}
                onChange={(event) => setForm({ ...form, allowRequests: event.target.checked })}
              />
              Take listener requests
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={form.allowPlayNow}
                onChange={(event) => setForm({ ...form, allowPlayNow: event.target.checked })}
              />
              Let listeners play a song now (the /listen client)
            </label>

            <button className="btn primary block" disabled={Boolean(busy)} onClick={save}>
              {busy === 'save' ? <span className="spin" /> : 'Save station'}
            </button>
          </div>

          <div className="section-title">Danger zone</div>
          <div className="card stack danger">
            <div className="dim">
              Deleting “{form.name}” stops it immediately and removes it from the store. Models and the seam log stay.
            </div>
            {confirm ? (
              <div className="row" style={{ gap: 8 }}>
                <button className="btn small danger grow" onClick={remove} disabled={Boolean(busy)}>
                  {busy === 'remove' ? <span className="spin" /> : 'Yes, delete it'}
                </button>
                <button className="btn small ghost grow" onClick={() => setConfirm(false)}>
                  Keep it
                </button>
              </div>
            ) : (
              <button className="btn small danger" onClick={() => setConfirm(true)}>
                Delete station
              </button>
            )}
          </div>
        </>
      ) : null}

      <div className="section-title">New station</div>
      <div className="card stack">
        <input
          placeholder="Station name"
          value={creating.name}
          onChange={(event) => setCreating({ ...creating, name: event.target.value })}
        />
        <div className="chips">
          {STARTERS.map((starter) => (
            <button
              key={starter.id}
              className={`chip ${!creating.custom && creating.playlist === starter.id ? 'on' : ''}`}
              onClick={() => setCreating({ ...creating, playlist: starter.id, custom: '' })}
            >
              {starter.label}
              <span className="chip-hint">{starter.hint}</span>
            </button>
          ))}
        </div>
        <input
          placeholder="…or a search, link or folder"
          value={creating.custom}
          onChange={(event) => setCreating({ ...creating, custom: event.target.value })}
        />
        <button className="btn primary block" disabled={Boolean(busy)} onClick={create}>
          {busy === 'create' ? <span className="spin" /> : 'Put it on air'}
        </button>
        <div className="dim">{stations.length} station{stations.length === 1 ? '' : 's'} on this node.</div>
      </div>

      {error ? <div className="error">{error}</div> : null}
    </div>
  )
}
