/**
 * First-order all-pass filter — the phaser's building block.
 *
 * An all-pass changes phase without changing magnitude, which is what makes a
 * phaser audible: the dry and the all-passed signal are summed, and the phase
 * difference between them produces notches that move as the coefficient moves.
 * One all-pass is a weak notch; four to eight cascaded are the sound.
 *
 * Same coefficient law as NodeLink's `dsp/allpass`, clamped to ±0.999 so the
 * recursion cannot ring.
 */
export class Allpass {
  declare a: any
  declare x1: any
  declare y1: any

  constructor() {
    this.x1 = 0
    this.y1 = 0
    this.a = 0
  }

  setCoefficient(a) {
    this.a = Math.max(-0.999, Math.min(0.999, a))
    return this
  }

  process(sample) {
    const output = this.a * sample + this.x1 - this.a * this.y1
    this.x1 = sample
    this.y1 = output
    return output
  }

  reset() {
    this.x1 = 0
    this.y1 = 0
    return this
  }
}

export default Allpass
