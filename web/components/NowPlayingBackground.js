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
 * The engine comes from `@kawarp/react` rather than `@kawarp/core` directly:
 * the wrapper owns the canvas, the `ResizeObserver` and — the part that is
 * easy to get wrong — `dispose()` on unmount. Constructing the core engine by
 * hand and calling `destroy()` leaked a WebGL context on every navigation;
 * the core has no `destroy`, only `dispose`.
 *
 * Everything degrades: no WebGL, no artwork, a browser that refuses the
 * canvas — the screen falls back to the flat background it would have had.
 */
import { Kawarp } from '@kawarp/react'

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

/**
 * The wrapper merges `{ position: 'relative', ...style }` into its container,
 * so the fixed, full-bleed placement has to be stated here rather than in CSS.
 */
const FILL = { position: 'fixed', inset: 0, width: '100%', height: '100%' }

/**
 * Keep the field dark enough for white type to sit on without a second,
 * muddying scrim: a gentle top-to-bottom vignette, nothing more.
 */
const SCRIM = 'linear-gradient(180deg, rgba(0,0,0,0.32) 0%, rgba(0,0,0,0.46) 45%, rgba(0,0,0,0.78) 100%)'

export default function NowPlayingBackground({ artwork = null }) {
  return (
    <>
      {artwork ? (
        <div className="np-bg" aria-hidden="true">
          {/* No artwork: this renders nothing at all, and the scrim alone is fine. */}
          <Kawarp src={artwork} autoPlay style={FILL} {...HARD} />
        </div>
      ) : null}
      <div className="np-scrim" style={{ background: SCRIM }} aria-hidden="true" />
    </>
  )
}
