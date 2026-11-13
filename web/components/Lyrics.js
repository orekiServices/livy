'use client'

/**
 * Word-synced lyrics, Apple Music style.
 *
 * The renderer is [`<am-lyrics>`](https://github.com/uimaxbai/apple-music-web-components),
 * a Lit web component that does the hard part — the scroll, the per-word
 * sweep, the interpolation between beats. We hand it finished **TTML** that
 * the *node* fetched and built (see `server/src/core/lyrics.js`), so the
 * component never makes a network request of its own: no listener's browser
 * talks to a lyrics API, and a node on a LAN fetches each song once for
 * everybody.
 *
 * The clock is the interesting part. A radio stream is not a file: there is
 * no `currentTime` to read, only "the node says the song is 41.2 s in, as of
 * 300 ms ago". So we take the node's position, add the time that has passed
 * since it said so, and let the listener nudge the result — every player
 * buffers a different amount, and being able to drag lyrics into place beats
 * pretending we know the latency.
 */
import dynamic from 'next/dynamic'
import { useEffect, useMemo, useRef, useState } from 'react'

import { api } from '../lib/api.js'

const AmLyrics = dynamic(
  () => {
    import('@uimaxbai/am-lyrics/am-lyrics.js')
    return import('@uimaxbai/am-lyrics/react').then((mod) => mod.AmLyrics)
  },
  { ssr: false }
)

const OFFSET_KEY = 'livy-lyrics-offset'
/** Where the previous name kept the same number. */
const OFFSET_KEY_LEGACY = 'nodecast-lyrics-offset'

export default function Lyrics({ station, nowPlaying }) {
  const [lyrics, setLyrics] = useState(null)
  const [state, setState] = useState('idle') // idle | loading | ready | none
  const [offsetMs, setOffsetMs] = useState(0)
  const [position, setPosition] = useState(0)

  // Where the node said we were, and when it said it.
  const anchor = useRef({ positionMs: 0, at: 0 })
  const trackId = nowPlaying?.track?.id ?? null

  useEffect(() => {
    // Read through from the pre-rename key and migrate it: someone who had
    // spent time nudging lyrics into sync should not lose that to a rebrand.
    const stored = window.localStorage.getItem(OFFSET_KEY) ?? window.localStorage.getItem(OFFSET_KEY_LEGACY)
    const saved = Number(stored)
    if (stored !== null && Number.isFinite(saved)) {
      setOffsetMs(saved)
      window.localStorage.setItem(OFFSET_KEY, String(saved))
      window.localStorage.removeItem(OFFSET_KEY_LEGACY)
    }
  }, [])

  /* ------------------------- fetch per track ------------------------- */

  useEffect(() => {
    if (!station || !trackId) {
      setLyrics(null)
      setState('idle')
      return undefined
    }

    let cancelled = false
    setState('loading')

    api(`/api/v1/lyrics?station=${encodeURIComponent(station)}`)
      .then((payload) => {
        if (cancelled) return
        anchor.current = { positionMs: payload.positionMs ?? 0, at: Date.now() }
        setLyrics(payload)
        setState(payload.found ? 'ready' : 'none')
      })
      .catch(() => {
        if (!cancelled) setState('none')
      })

    return () => {
      cancelled = true
    }
  }, [station, trackId])

  /* --------------------- keep the clock honest ----------------------- */

  // Every progress tick from the node re-anchors the clock; between ticks we
  // interpolate, so the sweep is smooth rather than stepping once a second.
  useEffect(() => {
    if (nowPlaying?.positionMs == null) return
    anchor.current = { positionMs: nowPlaying.positionMs, at: Date.now() }
  }, [nowPlaying?.positionMs])

  useEffect(() => {
    if (state !== 'ready') return undefined
    let frame
    const tick = () => {
      const { positionMs, at } = anchor.current
      setPosition(positionMs + (Date.now() - at) + offsetMs)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [state, offsetMs])

  const nudge = (delta) => {
    const next = Math.max(-8000, Math.min(8000, offsetMs + delta))
    setOffsetMs(next)
    window.localStorage.setItem(OFFSET_KEY, String(next))
  }

  /* ------------------------------ render ----------------------------- */

  const plainLines = useMemo(() => (lyrics?.plain ? lyrics.plain.split('\n') : []), [lyrics])

  if (!trackId) return <p className="dim">Nothing on air yet.</p>

  if (state === 'loading') {
    return (
      <div className="lyrics-wrap" style={{ display: 'grid', placeItems: 'center', minHeight: '32vh' }}>
        <span className="spin" />
      </div>
    )
  }

  if (state === 'none' || !lyrics?.found) {
    return (
      <div className="lyrics-wrap" style={{ display: 'grid', placeItems: 'center', minHeight: '32vh', padding: 24 }}>
        <p className="dim" style={{ textAlign: 'center', margin: 0 }}>
          {lyrics?.instrumental ? 'Instrumental — no words to follow.' : 'No lyrics found for this one.'}
        </p>
      </div>
    )
  }

  return (
    <div>
      <div className="lyrics-wrap">
        {lyrics.ttml ? (
          <AmLyrics
            ttml={lyrics.ttml}
            currentTime={Math.max(0, position)}
            autoscroll
            interpolate
            hideSourceFooter
            highlightColor="#ffffff"
          />
        ) : (
          /* Unsynced words still beat no words. */
          <div className="lyrics-fallback">{plainLines.join('\n')}</div>
        )}
      </div>

      <div className="row" style={{ marginTop: 10, gap: 8 }}>
        <span className="dim">Sync</span>
        <button className="btn small" onClick={() => nudge(-250)} aria-label="lyrics earlier">
          −0.25s
        </button>
        <button className="btn small" onClick={() => nudge(250)} aria-label="lyrics later">
          +0.25s
        </button>
        {offsetMs !== 0 ? (
          <button className="btn small ghost" onClick={() => nudge(-offsetMs)}>
            {(offsetMs / 1000).toFixed(2)}s · reset
          </button>
        ) : null}
        <div className="grow" />
        <span className="dim">{lyrics.synced ? 'synced' : 'plain'}</span>
      </div>
    </div>
  )
}
