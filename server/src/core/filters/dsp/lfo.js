/**
 * Low-frequency oscillator.
 *
 * The modulation source behind tremolo, vibrato, rotation, chorus, flanger,
 * phaser, spatial, tesseract and the phonograph's wow. It is deliberately a
 * *stateful* object rather than a pure function of time: the phase has to
 * persist across audio blocks, or every block would restart the wobble and a
 * 4 Hz tremolo would become a 40 Hz stutter at 26 ms block boundaries.
 *
 * NodeLink's LFO exposes both `getValue()` (the raw waveform, −1…1) and
 * `process()` (a gain factor, 0…1, already flipped so that `1 - depth ×
 * normalised` is the tremolo law). Both are here, because the two families of
 * filter want different shapes: tremolo and rotation multiply by `process()`,
 * while vibrato and flanger offset a delay line by `getValue()`.
 */
export class Lfo {
  #shape
  #frequency
  #depth

  constructor(waveformName = 'sine', frequency = 0, depth = 0) {
    this.phase = 0
    this.setWaveform(waveformName)
    this.#frequency = frequency
    this.#depth = depth
  }

  get frequency() {
    return this.#frequency
  }

  get depth() {
    return this.#depth
  }

  setWaveform(name) {
    // Imported lazily through the module-level table; see waves.js.
    this.#shape = waveformTable[name] ?? waveformTable.sine
    return this
  }

  update(frequency, depth) {
    this.#frequency = frequency
    this.#depth = depth
    return this
  }

  /**
   * Advance one sample and return the waveform value (−1…1).
   *
   * The rate is an argument, not just instance state: a filter's automation
   * can change the rate between blocks, and re-`update()`ing the LFO every
   * frame to move one number would allocate a closure per block. Passing it
   * wins on both counts.
   */
  getValue(frequency = this.#frequency, sampleRate = 44_100) {
    if (frequency === 0) return 0
    const value = this.#shape(this.phase)
    this.phase += (2 * Math.PI * frequency) / sampleRate
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI
    return value
  }

  /** Advance one sample and return a multiplication factor (0…1). */
  process(frequency = this.#frequency, sampleRate = 44_100) {
    if (this.#depth === 0 || frequency === 0) return 1
    const normalised = (this.getValue(frequency, sampleRate) + 1) / 2
    return 1 - this.#depth * normalised
  }

  reset() {
    this.phase = 0
    return this
  }
}

// Imported after the class so the field above can reference it.
import { Waveforms as waveformTable } from './waves.js'

export default Lfo
