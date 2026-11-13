/**
 * Seam features — the numbers the DJ policy sees, and the numbers it learns
 * from.
 *
 * The list is ordered and fixed. A `.bin` model records these names; the
 * loader refuses a model whose names do not match, because a model fed the
 * columns in the wrong order still produces a confident answer and there is no
 * way to notice from the outside.
 *
 * Everything is normalised to roughly −1…1 here rather than in the network:
 * the trainer sees raw-ish values in its logs, and a feature that needs a new
 * normalisation can change it without retraining from a different shape.
 */
/**
 * The output vector: one score per *built-in* transition type.
 *
 * Deliberately not `EFFECTS`. That array is the live registry and plugins push
 * and splice it, so a column of the model's output would change meaning the
 * first time someone unloaded a plugin — every score after the removed index
 * would shift by one and the network would be ranking the wrong effects. A
 * model file is a long-lived artifact; its output columns have to be fixed.
 *
 * Plugin effects are still offered at a seam: `chooseEffectWithModel` ranks
 * whatever the pool allows, and an effect the model has no column for simply
 * falls back to the heuristic's choice.
 */
export const ACTIONS = Object.freeze([
  'crossfade',
  'bass-swap',
  'filter',
  'echo',
  'sweep',
  'spindown',
  'slam',
  'wash',
  'roll',
  'drop'
])

/**
 * Input columns, in order.
 *
 * Tempo is represented three ways on purpose: the ratio (what a beatmatch has
 * to stretch by), its log (because 128/127 and 64/63 are nowhere near the same
 * musical distance in linear terms), and each side's distance from 100 BPM
 * (where real songs live, and the thing `selectTempoPair` already penalises).
 */
export const FEATURES = [
  'tempoRatio', // outgoing / incoming, clamped
  'tempoRatioLog', // log2 of the ratio
  'bpmOut', // outgoing BPM / 200
  'bpmIn', // incoming BPM / 200
  'tempoDelta', // |ratio − 1| × 10, i.e. percent / 10
  'matched', // did the pair beatmatch? 0/1
  'correlation', // waveform correlation at the seam, −1…1
  'loudnessGap', // outgoing − incoming LUFS, / 12
  'energyOut', // outgoing RMS energy, 0…1
  'energyIn', // incoming RMS energy, 0…1
  'vocalOut', // outgoing vocal-band activity, 0…1
  'vocalIn', // incoming vocal-band activity, 0…1
  'fadeSeconds', // blend length / 12
  'phraseAligned', // both sides on a phrase boundary? 0/1
  'talkover', // a DJ voice is due? 0/1
  'hour' // time of day / 24, because a 3 a.m. set is a different station
]

/** The feature vector for a seam description. */
export function featuresFor(seam = {}) {
  const bpmOut = Number(seam.bpmOut ?? seam.beat?.bpm ?? 0) || 0
  const bpmIn = Number(seam.bpmIn ?? 0) || 0
  const ratio = bpmOut > 0 && bpmIn > 0 ? bpmOut / bpmIn : 1
  const clamp = (value, lo = -1, hi = 1) => (value < lo ? lo : value > hi ? hi : value)

  return [
    clamp(ratio, 0.5, 2),
    clamp(Math.log2(ratio), -1, 1),
    clamp(bpmOut / 200, 0, 1),
    clamp(bpmIn / 200, 0, 1),
    clamp(Math.abs(ratio - 1) * 10, 0, 1),
    seam.matched ? 1 : 0,
    clamp(Number(seam.correlation) || 0),
    clamp((Number(seam.loudnessGap) || 0) / 12),
    clamp(Number(seam.energy ?? 0.5), 0, 1),
    clamp(Number(seam.energyIn ?? seam.energy ?? 0.5), 0, 1),
    clamp(Number(seam.vocalOut ?? 0), 0, 1),
    clamp(Number(seam.vocalIn ?? 0), 0, 1),
    clamp((Number(seam.fadeMs) || 6000) / 12_000, 0, 1),
    seam.phraseAligned ? 1 : 0,
    seam.talkover ? 1 : 0,
    clamp((Number(seam.hour ?? new Date().getHours()) || 0) / 24, 0, 1)
  ]
}

/**
 * Turn a logged outcome into a training target.
 *
 * The label is not "what the heuristic chose" — that would teach the network
 * to imitate a function we already have. It is what happened next:
 *
 *   `completed`  the track played out and the listener stayed: a good seam.
 *   `skipped`    somebody pressed skip during or right after it: a bad one.
 *   `neutral`    nothing was observed: used only as a weak prior.
 *
 * A skip is attributed to the transition only if it happened within
 * `attributionMs` of it, which is the difference between learning from the
 * data and learning from people who skip the songs they dislike.
 */
export const ATTRIBUTION_MS = 45_000

export function targetFor(record) {
  const chosen = ACTIONS.indexOf(record.effect)
  if (chosen < 0) return null
  // A preference vector, not a one-hot: the effect that played is worth
  // `outcome`, everything else zero — so the network is pushed to *rank* it
  // first and is free to put anything second. Adding a floor to the other
  // columns (0.35 was the first attempt) makes the loss mostly about how
  // confident the row is, which is noise: 0.7 accuracy was all it could reach.
  const y = new Array(ACTIONS.length).fill(0)
  let outcome = 0.5
  if (record.outcome === 'completed') outcome = 1
  else if (record.outcome === 'skipped') {
    const since = Number(record.skippedAfterMs)
    const close = Number.isFinite(since) ? since < ATTRIBUTION_MS : true
    outcome = close ? 0 : 0.5
  }
  y[chosen] = outcome
  return y
}

export default FEATURES
