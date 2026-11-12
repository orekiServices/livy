'use client'

/**
 * The node's voice.
 *
 * Two services, and the split between them is the whole point of this
 * screen: **language and pace are shared** — the station should sound like
 * itself whichever service is answering — while the voice itself belongs to
 * the service that issued it.
 */
import { useEffect, useRef, useState } from 'react'

import { nodeBase, owner, ownerKey } from '../lib/api.js'

export default function VoicePanel({ say }) {
  const [state, setState] = useState(null)
  const [provider, setProvider] = useState('google')
  const [language, setLanguage] = useState('en')
  const [speed, setSpeed] = useState(1)
  const [voice, setVoice] = useState('')
  const [voices, setVoices] = useState([])
  const [busy, setBusy] = useState(false)
  const audioRef = useRef(null)

  const load = async (withProvider, withLanguage) => {
    const query = new URLSearchParams()
    if (withProvider) query.set('provider', withProvider)
    if (withLanguage) query.set('language', withLanguage)
    const payload = await owner(`/tts?${query}`)
    setState(payload)
    setVoices(payload.voices ?? [])
    return payload
  }

  useEffect(() => {
    load()
      .then((payload) => {
        setProvider(payload.provider === 'off' ? 'google' : payload.provider)
        setLanguage(payload.shared?.language ?? 'en')
        setSpeed(payload.shared?.speed ?? 1)
        const active = (payload.providers ?? []).find((entry) => entry.id === payload.provider)
        setVoice(active?.settings?.voice ?? '')
      })
      .catch((error) => say?.(error.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The voice list belongs to a (service, language) pair.
  useEffect(() => {
    if (!state) return
    load(provider, language).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, language])

  if (!state) return <span className="spin" />

  const current = (state.providers ?? []).find((entry) => entry.id === provider)

  const save = async () => {
    setBusy(true)
    try {
      await owner('/tts', {
        method: 'PATCH',
        body: { provider, language, speed, providers: current?.voices ? { [provider]: { voice: voice || null } } : {} }
      })
      say?.('Voice saved')
    } catch (error) {
      say?.(error.message)
    } finally {
      setBusy(false)
    }
  }

  const preview = async () => {
    setBusy(true)
    try {
      const base = await nodeBase()
      const res = await fetch(`${base}/api/v1/owner/tts/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-owner-key': ownerKey() ?? '' },
        body: JSON.stringify({ provider, language, speed, voice: voice || undefined })
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
      <div className="section-title">Service</div>
      <div className="grid2">
        {(state.providers ?? []).map((entry) => (
          <button
            key={entry.id}
            className="card"
            onClick={() => setProvider(entry.id)}
            style={{ textAlign: 'left', borderColor: provider === entry.id ? 'var(--accent)' : 'var(--line)' }}
          >
            <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>{entry.name ?? entry.id}</div>
            <div className="dim" style={{ fontSize: 12 }}>
              {entry.voices ? 'thousands of voices' : 'one voice per language'}
              {entry.nonCommercial ? ' · non-commercial' : ''}
            </div>
          </button>
        ))}
      </div>

      <div className="section-title">Shared by both</div>
      <div className="card">
        <label className="field" htmlFor="voice-language">
          Language
        </label>
        <select id="voice-language" value={language} onChange={(event) => setLanguage(event.target.value)}>
          {(state.languages ?? []).map((entry) => (
            <option key={entry.code} value={entry.code}>
              {entry.native} ({entry.code})
            </option>
          ))}
        </select>

        <label className="field" style={{ marginTop: 12 }}>
          Pace — ×{Number(speed).toFixed(2)}
        </label>
        <input
          type="range"
          min={current?.speedRange?.[0] ?? 0.5}
          max={current?.speedRange?.[1] ?? 1}
          step="0.05"
          value={speed}
          onChange={(event) => setSpeed(Number(event.target.value))}
          style={{ width: '100%' }}
        />
        <p className="dim" style={{ fontSize: 12, margin: '6px 0 0' }}>
          Language and pace stay put when you switch service — a station should not change character because of an API.
        </p>
      </div>

      {current?.voices ? (
        <>
          <div className="section-title">{current.name} voices for {language}</div>
          <div className="card">
            {voices.length === 0 ? (
              <p className="dim" style={{ margin: 0 }}>
                No voices for this language — it will use the service default.
              </p>
            ) : (
              <select value={voice} onChange={(event) => setVoice(event.target.value)}>
                <option value="">Best available</option>
                {voices.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} · {entry.gender ?? '—'} · {entry.engine}
                  </option>
                ))}
              </select>
            )}
          </div>
        </>
      ) : null}

      <div className="row" style={{ gap: 8, marginTop: 14 }}>
        <button className="btn" onClick={preview} disabled={busy}>
          Preview
        </button>
        <button className="btn primary grow" onClick={save} disabled={busy}>
          {busy ? <span className="spin" /> : 'Save'}
        </button>
      </div>
      <audio ref={audioRef} hidden />
    </div>
  )
}
