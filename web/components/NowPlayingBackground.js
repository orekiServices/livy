'use client'

/**
 * The warped artwork behind Now Playing — and nowhere else.
 *
 * [Kawarp](https://github.com/better-lyrics/kawarp) blurs the cover with a
 * Kawase pyramid and then pushes it around with simplex-noise domain
 * warping, on the GPU. It is the Apple Music album-art effect, and it is
 * the one piece of decoration in this console: every other screen is flat
 * black so artwork is the only colour on it. Turning it loose everywhere
 * would be a battery bill for no information.
 *
 * It is dialled **hard** on purpose: heavy blur, strong warp, saturated.
 * The point is a moving field of the record's own colour, not a recognisable
 * picture of the sleeve — the sleeve is already on screen above it.
 *
 * Everything degrades: no WebGL, no artwork, a browser that refuses the
 * canvas — the screen falls back to the flat background it would have had.
 */
import { useEffect, useRef, useState } from 'react'

/** Hard settings: this is a background, and it should look like weather. */
const HARD = {
  warpIntensity: 0.95,
  blurPasses: 16,
  animationSpeed: 0.55,
  transitionDuration: 1600,
  saturation: 1.9,
  tintColor: [0.05, 0.05, 0.08],
  tintIntensity: 0.22,
  dithering: 0.01,
  scale: 1.25
}

export default function NowPlayingBackground({ artwork }) {
  const canvasRef = useRef(null)
  const engineRef = useRef(null)
  const [ready, setReady] = useState(false)

  // Build the renderer once, in the browser, and only if there is a canvas.
  useEffect(() => {
    let cancelled = false

    const start = async () => {
      if (!canvasRef.current || engineRef.current) return
      try {
        const { Kawarp } = await import('@kawarp/core')
        if (cancelled || !canvasRef.current) return
        engineRef.current = new Kawarp(canvasRef.current, HARD)
        setReady(true)
      } catch {
        // No WebGL, or the library would not load: the scrim alone is fine.
        setReady(false)
      }
    }

    start()
    return () => {
      cancelled = true
      try {
        engineRef.current?.stop?.()
        engineRef.current?.destroy?.()
      } catch {
        /* already gone */
      }
      engineRef.current = null
    }
  }, [])

  // Every new cover crossfades into the field.
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || !ready) return

    let cancelled = false
    const load = async () => {
      try {
        if (artwork) {
          await engine.loadImage(artwork)
          if (!cancelled) engine.start()
        } else {
          engine.stop?.()
        }
      } catch {
        // Artwork from a provider that forbids cross-origin reads: stop
        // rather than leave a half-loaded texture spinning.
        engine.stop?.()
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [artwork, ready])

  // Pause when the screen is not visible: a WebGL loop in a background tab
  // is a battery leak with nothing to show for it.
  useEffect(() => {
    const onVisibility = () => {
      const engine = engineRef.current
      if (!engine) return
      if (document.hidden) engine.stop?.()
      else if (artwork) engine.start?.()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [artwork])

  return (
    <>
      <div className="np-bg" aria-hidden="true">
        <canvas ref={canvasRef} crossOrigin="anonymous" />
      </div>
      <div className="np-scrim" aria-hidden="true" />
    </>
  )
}
