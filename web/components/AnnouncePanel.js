'use client'

/**
 * Saying something on air, in one tap.
 *
 * The old console had a text box. At two in the morning, when the point of
 * an announcement is usually "we'll be back soon", a text box is the wrong
 * instrument — so the node ships canned lines (`GET …/say`), this offers
 * them as buttons, and the text box is still there for everything else.
 *
 * Two things stop it being frightening: you can **hear it first** (the
 * preview never touches the transmitter), and you can pick the **language**
 * — the node speaks 21 of them.
 */
import { useEffect, useRef, useState } from 'react'

import { nodeBase, owner, ownerKey } from '../lib/api.js'

export default function AnnouncePanel({ station, say }) {
  const [presets, setPresets] = useState([])
  const [languages, setLanguages] = useState([])
  const [language, setLanguage] = useState('')
  const [text, setText] = useState('')
  const [when, setWhen] = useState('now')
  const [busy, setBusy] = useState(false)
  const audioRef = useRef(null)

  useEffect(() => {
    owner(`/stations/${station}/say`)
      .then((payload) => {
        setPresets(payload.presets ?? [])
        setLanguages(payload.languages ?? [])
        setLanguage(payload.language ?? '')
      })
      .catch(() => {})
  }, [station])

  const send = async (body, label) => {
    setBusy(true)
    try {
      await owner(`/stations/${station}/say`, { method: 'POST', body: { language, when, ...body } })
      say?.(label)
      if (body.text) setText('')
    } catch (error) {
      say?.(error.message)
    } finally {
      setBusy(false)
    }
  }

  /** Hear it before the listeners do. The node returns audio, not JSON. */
  const preview = async () => {
    if (!text.trim()) return
    setBusy(true)
    try {
      const base = await nodeBase()
      const res = await fetch(`${base}/api/v1/owner/stations/${station}/say`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-owner-key': ownerKey() ?? '' },
        body: JSON.stringify({ text, language, preview: true })
      })
      if (!res.ok) throw new Error(`preview failed (${res.status})`)
      const url = URL.createObjectURL(await res.blob())
      if (audioRef.current) {
        audioRef.current.src = url
        await audioRef.current.play()
      }
    } catch (error) {
      say?.(error.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="grid2">
        {presets.map((preset) => (
          <button
            key={preset.id}
            className="btn"
            disabled={busy}
            onClick={() => send({ preset: preset.id }, `On air: ${preset.title}`)}
            style={{ justifyContent: 'flex-start', textAlign: 'left', height: 'auto', padding: '12px 14px' }}
          >
            <span>{preset.title}</span>
          </button>
        ))}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <label className="field" htmlFor="say-text">
          Or say something of your own
        </label>
        <textarea
          id="say-text"
          value={text}
          placeholder="Good evening — you're listening to…"
          maxLength={500}
          onChange={(event) => setText(event.target.value)}
        />

        <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
          <select value={language} onChange={(event) => setLanguage(event.target.value)} style={{ width: 'auto', minWidth: 150 }}>
            {languages.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.native}
              </option>
            ))}
          </select>

          <select value={when} onChange={(event) => setWhen(event.target.value)} style={{ width: 'auto' }}>
            <option value="now">Interrupt now</option>
            <option value="next">After this song</option>
          </select>
        </div>

        <div className="row" style={{ marginTop: 10, gap: 8 }}>
          <button className="btn" onClick={preview} disabled={busy || !text.trim()}>
            Preview
          </button>
          <button className="btn primary grow" onClick={() => send({ text }, 'Announcement queued')} disabled={busy || !text.trim()}>
            {busy ? <span className="spin" /> : when === 'now' ? 'Say it now' : 'Say it after this song'}
          </button>
        </div>

        <audio ref={audioRef} hidden />
      </div>
    </div>
  )
}
