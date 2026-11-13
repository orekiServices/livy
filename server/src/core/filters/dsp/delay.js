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
 * Delay line with linear interpolation.
 *
 * A fractional read is the difference between a vibrato and a ring modulator:
 * at 5 Hz and 3 ms of swing the read head lands between samples on almost
 * every frame, and `Math.floor` would hold it still until the next whole
 * sample, so the pitch would jump in 44.1 kHz steps instead of gliding.
 */
export class FractionalDelay {
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
   * Read `delay` samples back, interpolating between the two neighbours.
   *
   * Same convention as `DelayLine.read`: 1 is the last pushed sample. A
   * fractional delay below 1 is clamped rather than extrapolated — the
   * alternative is reading a sample that has not been written.
   */
  read(delay) {
    const clamped = Math.max(1, Math.min(this.size - 3, delay))
    const whole = Math.floor(clamped)
    const fraction = clamped - whole
    const a = this.buffer[(this.write - whole + this.size * 2) % this.size]
    const b = this.buffer[(this.write - whole - 1 + this.size * 2) % this.size]
    return a + (b - a) * fraction
  }

  clear() {
    this.buffer.fill(0)
    this.write = 0
    return this
  }
}

export default DelayLine
