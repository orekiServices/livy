/**
 * Delay lines.
 *
 * Two implementations, because two different jobs want different trade-offs:
 *
 *   `DelayLine`      — one float per sample, integer reads. The echo and the
 *                      reverb combs read at fixed offsets; interpolation would
 *                      be wasted work on every sample.
 *   `FractionalDelay` — one float per sample, *interpolated* reads. Vibrato,
 *                      chorus, flanger and the phonograph move the read head
 *                      continuously, so an integer read would quantise the
 *                      modulation into a staircase and turn a smooth wobble
 *                      into a buzz at low polar frequencies.
 *
 * NodeLink backs its delay line with an Int16 `Buffer`. Float32 is used here
 * instead: the chain runs on decoded Float32 PCM and a round-trip through
 * 16-bit would add quantisation noise to a signal that is about to be encoded
 * to MP3 at 128 kbps, where that noise is exactly what the encoder has the
 * least budget for.
 */
export class DelayLine {
  declare buffer: any
  declare size: any
  declare write: any

  constructor(maxSamples) {
    this.size = Math.max(2, Math.ceil(maxSamples) + 2)
    this.buffer = new Float32Array(this.size)
    this.write = 0
  }

  /** Write one sample and advance. Returns the sample, for chaining. */
  push(sample) {
    this.buffer[this.write] = sample
    this.write = (this.write + 1) % this.size
    return sample
  }

  /**
   * The sample pushed `delay` pushes ago. Integer only: the caller knows its
   * offsets. Returns 0 for `delay` 0, because the sample being pushed right now
   * has not been written yet.
   */
  read(delay) {
    const offset = Math.max(0, Math.min(this.size - 1, Math.round(delay)))
    return this.buffer[(this.write - offset + this.size * 2) % this.size]
  }

  clear() {
    this.buffer.fill(0)
    this.write = 0
    return this
  }
}

/**
 * Delay line with Catmull-Rom interpolation.
 *
 * A fractional read is the difference between a vibrato and a ring modulator:
 * at 5 Hz and 3 ms of swing the read head lands between samples on almost
 * every frame, and `Math.floor` would hold it still until the next whole
 * sample, so the pitch would jump in 44.1 kHz steps instead of gliding.
 *
 * The first implementation interpolated linearly, which is fine for a slow
 * chorus but audibly dulls the top end once the delay is modulated: a linear
 * interpolator is a one-zero low-pass, so the moving read head acts like a
 * sweeping filter and the vibrato loses its shimmer. Catmull-Rom uses the two
 * neighbours on each side, costs three extra multiplies, and keeps the
 * modulation transparent. State and delay convention are unchanged, so this
 * is a drop-in replacement for every filter that reads a moving head.
 */
export class FractionalDelay {
  declare buffer: any
  declare size: any
  declare write: any

  constructor(maxSamples) {
    this.size = Math.max(4, Math.ceil(maxSamples) + 4)
    this.buffer = new Float32Array(this.size)
    this.write = 0
  }

  push(sample) {
    this.buffer[this.write] = sample
    this.write = (this.write + 1) % this.size
    return sample
  }

  /**
   * Read `delay` samples back, interpolating between the four neighbours.
   *
   * Same convention as `DelayLine.read`: 1 is the last pushed sample. A
   * fractional delay below 2 is clamped rather than extrapolated — the
   * alternative is reading a sample that has not been written, and the two
   * filters that ask for delay 1 do not move their read head.
   */
  read(delay) {
    const size = this.size
    const clamped = Math.max(2, Math.min(size - 4, delay))
    const whole = Math.floor(clamped)
    const t = clamped - whole
    const at = (offset) => this.buffer[(this.write - whole + offset + size * 2) % size]
    // p1 and p2 straddle the fractional position; p0/p3 are the outer points.
    const p0 = at(1)
    const p1 = at(0)
    const p2 = at(-1)
    const p3 = at(-2)
    // Catmull-Rom, expanded: y(t) = 0.5·(2p1 + (−p0+p2)t
    //   + (2p0−5p1+4p2−p3)t² + (−p0+3p1−3p2+p3)t³)
    const c0 = p1
    const c1 = 0.5 * (p2 - p0)
    const c2 = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3
    const c3 = 0.5 * (p3 - p0) + 1.5 * (p1 - p2)
    return ((c3 * t + c2) * t + c1) * t + c0
  }

  clear() {
    this.buffer.fill(0)
    this.write = 0
    return this
  }
}

export default DelayLine
