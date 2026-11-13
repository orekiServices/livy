'use client'

/**
 * Lyrics, and nothing else — the Now Playing screen.
 *
 * The renderer is [`<am-lyrics>`](https://github.com/uimaxbai/apple-music-web-components),
 * a Lit web component that does the hard part: the scroll, the per-word
 * sweep, the interpolation between beats. We hand it finished **TTML** that
 * the *node* fetched and built (see `server/src/core/lyrics.js`), so the
 * component never makes a network request of its own: no listener's browser
 * talks to a lyrics API, and a node on a LAN fetches each song once for
 * everybody.
 *
 * Two details are borrowed from BitChord's web player because they are the
 * difference between working and subtly broken:
 *
 *  - the element is **built by hand** with `ttml` already set, then attached.
 *    am-lyrics loads on `connectedCallback`; mounted through JSX the
 *    properties arrive a beat later, so its first fetch goes out to its own
 *    providers with no title and lands *after* ours, wiping our lyrics.
 *  - its footer is hidden with `visibility: hidden`, never `display: none`:
 *    am-lyrics measures its scroll range down to the footer, and hiding the
 *    footer from layout collapsed that range to zero, so nothing scrolled.
 *
 * The clock is the interesting part. A radio stream is not a file: there is
 * no `currentTime` to read, only "the node says the song is 41.2 s in, as of
 * 300 ms ago". So we take the node's position, add the time that has passed
 * since it said so, and let the listener nudge the result — every player
 * buffers a different amount, and being able to drag lyrics into place beats
 * pretending we know the latency.
 *
 * The time is written **straight onto the element** every frame. am-lyrics
 * handles `currentTime` imperatively for exactly this reason; routing it
 * through React state would re-render this component sixty times a second.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { api } from '../lib/api.js'

const OFFSET_KEY = 'livy-lyrics-offset'
/** Where the previous name kept the same number. */
const OFFSET_KEY_LEGACY = 'nodecast-lyrics-offset'

/** The lyric typeface, then the console's own. */
const LYRIC_FONT = "'Roboto', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif"

/**
 * am-lyrics' own chrome, hidden two different ways for two different reasons.
 *
 * The footer offers to fetch from the component's providers, and ours is the
 * only provider. It stays in the layout and merely disappears from sight:
 * am-lyrics measures its scroll range down to the footer's 50vh of bottom
 * padding, and taking it out of layout collapsed that range to zero, so the
 * lyrics stopped scrolling.
 *
 * The toolbar (romanize, translate, download) is absolutely positioned, so it
 * costs the layout nothing and can simply go — on a screen that is nothing
 * but lyrics, it was the first thing over the words.
 */
const HIDE_CHROME =
  '.lyrics-footer { visibility: hidden !important; pointer-events: none !important; }' +
  '.lyrics-header { display: none !important; }'

/**
 * am-lyrics fades the four lines either side of the current one and leaves
 * every line past them at its base opacity, so the fifth line on came back
 * brighter. Those stay at the farthest step. The library's `!important` rules
 * (scrolling by hand, unsynced lyrics) still win.
 */
const FAR_LINES =
  '.lyrics-line:not(.active):not(.pre-active):not(.lyrics-activest):not(.post-active-line):not(.next-active-line)' +
  ':not(.prev-2):not(.prev-3):not(.next-2):not(.next-3):not(.lyrics-gap) { opacity: 0.46; }'

/**
 * Full-screen sizing: the type is larger than the library's container tiers
 * allow, and the current line sits a third of the way down — more to look
 * forward to than to look back on, as Apple's does. Scoped to `data-full` so
 * the same element in a smaller panel keeps the library's own sizes.
 */
const FULL_SIZE =
  ':host([data-full]) .lyrics-container {' +
  ' --lyplus-font-size-base: clamp(24px, 4.2vw, 46px);' +
  ' --am-lyrics-line-height: 1.22;' +
  ' --am-lyrics-line-spacing: clamp(14px, 2.4vw, 26px);' +
  ' --lyrics-scroll-padding-top: 30%;' +
  ' --am-lyrics-inline-padding: 0px; }'

const injectStyles = (root) => {
  if (!root) return
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(HIDE_CHROME + FAR_LINES + FULL_SIZE)
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]
}

export default function Lyrics({ station, nowPlaying }) {
  const [lyrics, setLyrics] = useState(null)
  const [state, setState] = useState('idle') // idle | loading | ready | plain | none
  const [offsetMs, setOffsetMs] = useState(0)

  const host = useRef(null)
  const element = useRef(null)
  const trackId = nowPlaying?.track?.id ?? null

  // Where the node said we were, and when it said it. The stamp is in
  // `performance.now()` milliseconds: `Date.now()` is a wall clock that jumps
  // when the machine's time is corrected, and lyrics should not.
  const anchor = useRef({ positionMs: 0, at: 0 })

  /* ----------------------- remembered sync nudge ---------------------- */

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

  /* -------------------------- fetch per track ------------------------- */

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
        // The node told us where it was, and when. Stamp it on our own clock,
        // backing out however long the answer spent in transit.
        const lag = Math.min(5000, Math.max(0, Date.now() - (payload.serverTime ?? Date.now())))
        anchor.current = { positionMs: payload.positionMs ?? 0, at: performance.now() - lag }
        setLyrics(payload)
        setState(payload.found ? (payload.ttml ? 'ready' : 'plain') : 'none')
      })
      .catch(() => {
        if (!cancelled) setState('none')
      })

    return () => {
      cancelled = true
    }
  }, [station, trackId])

  /* ---------------------- build the element by hand -------------------- */

  // am-lyrics starts loading the moment it connects, so it is created with
  // its TTML already in place and only then attached to the page.
  useLayoutEffect(() => {
    const ttml = lyrics?.ttml
    if (state !== 'ready' || !ttml) return undefined

    const el = document.createElement('am-lyrics')
    el.ttml = ttml
    el.interpolate = true
    el.autoScroll = true
    el.highlightColor = '#ffffff'
    el.fontFamily = LYRIC_FONT
    el.lineMotion = 'staggered'
    // Our node is the only provider: no Google generation, no third parties.
    el.noAutoAlternates = true
    el.toggleAttribute('data-full', true)
    el.className = 'np-lyrics'
    host.current?.append(el)
    element.current = el

    void Promise.resolve(el.updateComplete).then(() => injectStyles(el.shadowRoot))

    return () => {
      el.remove()
      element.current = null
    }
  }, [state, lyrics?.ttml])

  // A new provider's TTML arrives on the same element.
  useEffect(() => {
    const el = element.current
    if (el && lyrics?.ttml && el.ttml !== lyrics.ttml) el.ttml = lyrics.ttml
  }, [lyrics?.ttml])

  // Nothing is playing: freeze the words where they are rather than letting
  // the clock run on into a song that is not on air.
  useEffect(() => {
    const el = element.current
    if (el) el.paused = !nowPlaying?.playing
  }, [nowPlaying?.playing, state])

  /* --------------------- keep the clock honest ------------------------ */

  // Every progress tick from the node re-anchors the clock. Between ticks we
  // interpolate ourselves, so the sweep is smooth rather than stepping once
  // a second.
  useEffect(() => {
    if (nowPlaying?.positionMs == null) return
    anchor.current = { positionMs: nowPlaying.positionMs, at: performance.now() }
  }, [nowPlaying?.positionMs])

  useEffect(() => {
    if (state !== 'ready') return undefined
    let frame
    const tick = () => {
      const el = element.current
      if (el) {
        const { positionMs, at } = anchor.current
        el.currentTime = Math.max(0, positionMs + (performance.now() - at) + offsetMs)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [state, offsetMs])

  /* ------------------------------ helpers ----------------------------- */

  const nudge = (delta) => {
    const next = Math.max(-8000, Math.min(8000, offsetMs + delta))
    setOffsetMs(next)
    window.localStorage.setItem(OFFSET_KEY, String(next))
  }

  /* ------------------------------ render ------------------------------ */

  if (!trackId) {
    return (
      <div className="np-stage">
        <p className="np-note">Nothing on air yet.</p>
      </div>
    )
  }

  if (state === 'loading') {
    return (
      <div className="np-stage">
        <span className="spin" />
      </div>
    )
  }

  if (state === 'none' || !lyrics?.found) {
    return (
      <div className="np-stage">
        <p className="np-note">{lyrics?.instrumental ? 'Instrumental — no words to follow.' : 'No lyrics found for this one.'}</p>
      </div>
    )
  }

  if (state === 'plain') {
    // Unsynced words still beat no words.
    return (
      <div className="np-stage">
        <div className="np-plain">{(lyrics.plain ?? '').trim()}</div>
      </div>
    )
  }

  return (
    <>
      <div className="np-stage">
        <div ref={host} className="np-lyrics-host" />
      </div>

      <div className="np-sync">
        <button className="np-sync-btn" onClick={() => nudge(-250)} aria-label="Lyrics 0.25 seconds earlier">
          −0.25s
        </button>
        {offsetMs !== 0 ? (
          <button className="np-sync-btn on" onClick={() => nudge(-offsetMs)} aria-label="Reset lyric sync">
            {(offsetMs / 1000).toFixed(2)}s · reset
          </button>
        ) : (
          <span className="np-sync-tag">{lyrics.synced ? 'synced' : 'words'}</span>
        )}
        <button className="np-sync-btn" onClick={() => nudge(250)} aria-label="Lyrics 0.25 seconds later">
          +0.25s
        </button>
      </div>
    </>
  )
}
