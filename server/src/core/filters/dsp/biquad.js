/**
 * Biquad filters — the equaliser, the low/high-pass and the tesseract shaper.
 *
 * Transposed direct form II: two state variables per channel per band instead
 * of four, and better numerical behaviour at low frequencies (a 25 Hz band on
 * a 44.1 kHz stream has coefficients within 10⁻⁵ of each other, which is
 * exactly where direct form I loses the signal to rounding).
 *
 * The coefficient functions are the Audio EQ Cookbook's, which is also what
 * NodeLink uses, so a preset saved in one sounds like the other.
 */
export class Biquad {
  b0 = 1
  b1 = 0
  b2 = 0
  a1 = 0
  a2 = 0
  z1 = 0
  z2 = 0

  /** Copy the coefficients (not the state) of another biquad. */
  copyCoefficients(other) {
    this.b0 = other.b0
    this.b1 = other.b1
    this.b2 = other.b2
    this.a1 = other.a1
    this.a2 = other.a2
    return this
  }

  /** Peaking band, `gainDb` of boost or cut at `frequency`. */
  peaking(frequency, gainDb, sampleRate, q = 1.41) {
    const A = Math.pow(10, gainDb / 40)
    const w0 = (2 * Math.PI * frequency) / sampleRate
    const cos = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * q)
    const a0 = 1 + alpha / A
    this.b0 = (1 + alpha * A) / a0
    this.b1 = (-2 * cos) / a0
    this.b2 = (1 - alpha * A) / a0
    this.a1 = (-2 * cos) / a0
    this.a2 = (1 - alpha / A) / a0
    return this
  }

  /**
   * Second-order Butterworth low/high-pass.
   *
   * `Q = 1/√2` is the only value that is flat: anything higher bumps the
   * corner, anything lower sags it. NodeLink pins it, and so does this —
   * a filter advertised as a low-pass that colours the passband is a bug.
   */
  lowpass(frequency, sampleRate, q = Math.SQRT1_2) {
    const w0 = (2 * Math.PI * frequency) / sampleRate
    const cos = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * q)
    const a0 = 1 + alpha
    this.b0 = ((1 - cos) / 2) / a0
    this.b1 = (1 - cos) / a0
    this.b2 = ((1 - cos) / 2) / a0
    this.a1 = (-2 * cos) / a0
    this.a2 = (1 - alpha) / a0
    return this
  }

  highpass(frequency, sampleRate, q = Math.SQRT1_2) {
    const w0 = (2 * Math.PI * frequency) / sampleRate
    const cos = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * q)
    const a0 = 1 + alpha
    this.b0 = ((1 + cos) / 2) / a0
    this.b1 = (-(1 + cos)) / a0
    this.b2 = ((1 + cos) / 2) / a0
    this.a1 = (-2 * cos) / a0
    this.a2 = (1 - alpha) / a0
    return this
  }

  /** One sample in, one sample out. */
  run(sample) {
    const out = this.b0 * sample + this.z1
    this.z1 = this.b1 * sample - this.a1 * out + this.z2
    this.z2 = this.b2 * sample - this.a2 * out
    return out
  }

  reset() {
    this.z1 = 0
    this.z2 = 0
    return this
  }
}

export default Biquad
