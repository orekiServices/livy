/**
 * Backspin — a transition plugin in one file.
 *
 * The oldest trick in the book: on the last beats of the outgoing song the
 * record is dragged backwards, accelerating and dropping in level, and the
 * new song lands on the downbeat underneath it.
 *
 * It exists to show that `ctx.registerEffect()` gets exactly the same mix
 * context the built-in transitions use — including `beatSamples`, the beat
 * period *after* beatmatching, so the spin is always a whole number of beats.
 *
 * Use it with:  POST /api/v1/owner/stations/<id>/automix { "effect": "backspin" }
 */
export const manifest = {
  name: 'Backspin transition',
  version: '1.0.0',
  description: 'adds the "backspin" automix effect'
}

/** Linear-interpolated read, so the spin is smooth at any rate. */
const sample = (buffer, position) => {
  if (position <= 0 || position >= buffer.length - 1) return 0
  const i = Math.floor(position)
  const frac = position - i
  return buffer[i] * (1 - frac) + buffer[i + 1] * frac
}

export default function setup(ctx) {
  const beats = Number(ctx.settings.beats ?? 2) // how long the spin lasts
  const accel = Number(ctx.settings.acceleration ?? 3.2) // how hard it is pulled

  ctx.registerEffect('backspin', ({ a, b, left, right, fade, total, gainFor, sampleRate, beatSamples }) => {
    const period = beatSamples > 0 ? beatSamples : Math.round(sampleRate * 0.5)
    const spin = Math.min(total, Math.max(Math.round(period), Math.round(period * beats)))
    const spinStart = Math.max(0, total - spin)

    // Before the spin: the outgoing song runs alone, the new one creeps in
    // underneath at the level the fade law asks for.
    for (let i = 0; i < spinStart; i += 1) {
      const [, gb] = gainFor(i / fade)
      left[i] = (a.left[i] ?? 0) + (b.left[i] ?? 0) * gb * 0.25
      right[i] = (a.right[i] ?? 0) + (b.right[i] ?? 0) * gb * 0.25
    }

    // The spin itself: read A backwards from the hand-over point at a rising
    // rate, fade it out, and bring B up so it is at full level on the last
    // sample — which is the beat the blend was quantised to.
    let read = spinStart
    for (let i = spinStart; i < total; i += 1) {
      const t = (i - spinStart) / Math.max(1, spin - 1)
      const rate = 1 + accel * t * t
      read -= rate

      const decay = (1 - t) ** 1.6
      const aL = sample(a.left, read) * decay
      const aR = sample(a.right, read) * decay

      const gb = Math.min(1, (t / 0.7) ** 0.6) // B is home before the spin ends
      left[i] = aL + (b.left[i] ?? 0) * gb
      right[i] = aR + (b.right[i] ?? 0) * gb
    }
  })

  ctx.log.info(`"backspin" transition available (${beats} beats)`)
}
