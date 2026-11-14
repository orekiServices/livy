/**
 * What actually worked, per transition.
 *
 * `chooseEffect` scores transitions by how well they fit the two songs, and
 * the model adds an opinion learned from the same seam log. Neither of them
 * looks at the simplest evidence a station has: *this transition, on this
 * station, tends to work or not*. A `slam` that sounds exciting on paper and
 * loses the room every third time is not a good transition here, however well
 * it fits the tempo.
 *
 * So the seam log is also read as a scoreboard. Each transition gets a
 * completion rate with two bits of care that matter on a live station:
 *
 *   • **Laplace smoothing.** One bad night is not a verdict: 0/1 is 0.33, not
 *     zero, and an effect needs a real weight of evidence before it is
 *     trusted at all (`MIN_SHOWS`, measured in recency weight, not plays).
 *   • **Recency.** The same half-life idea the trainer uses. A transition that
 *     stopped working after a playlist change should lose its reputation in
 *     weeks, not stay tarred for a year.
 *
 * The output is a *nudge*, deliberately small: at most ±`MAX_NUDGE` on a score
 * where the heuristic's own terms are worth 0.15–0.35. It breaks ties and
 * settles arguments between plausible transitions; it never overrides "there
 * is no beat to roll on". A station with no log gets an empty scoreboard and
 * exactly the behaviour it had before.
 */
export const MIN_SHOWS = 8
export const MAX_NUDGE = 0.06
export const OUTCOME_HALF_LIFE_DAYS = 21

const clamp = (value, lo, hi) => (value < lo ? lo : value > hi ? hi : value)

/** The weight of one logged seam, halving every `halfLifeDays`. */
function weightOf(record, { now, halfLifeDays }) {
  const at = Number(record?.at)
  if (!Number.isFinite(at) || at <= 0) return 1
  const ageDays = Math.max(0, (now - at) / 86_400_000)
  return Math.max(0.05, 0.5 ** (ageDays / halfLifeDays))
}

/**
 * The scoreboard: one row per transition that was ever played at a seam.
 *
 * @param {object[]} records seam log rows (`{effect, outcome, at}`)
 * @returns {{effects: Record<string, object>, trusted: string[], rows: number, halfLifeDays: number}}
 */
export function effectOutcomes(records: any = [], { now = Date.now(), halfLifeDays = OUTCOME_HALF_LIFE_DAYS, minShows = MIN_SHOWS }: any = {}) {
  const play = new Map()
  for (const record of records) {
    const name = record?.effect
    if (typeof name !== 'string' || !name) continue
    // A late skip is not evidence about the transition (see `targetFor`), and
    // neither is a seam nobody watched.
    if (record.outcome !== 'completed' && record.outcome !== 'skipped') continue
    const weight = weightOf(record, { now, halfLifeDays })
    const row = play.get(name) ?? { plays: 0, weight: 0, completed: 0, skipped: 0 }
    row.plays += 1
    row.weight += weight
    if (record.outcome === 'completed') row.completed += weight
    else row.skipped += weight
    play.set(name, row)
  }

  const effects: Record<string, any> = {}
  const trusted = []
  for (const [name, row] of play) {
    const shown = row.completed + row.skipped
    // Laplace: one win is not a pattern, and no row is 100 %.
    const rate = (row.completed + 1) / (shown + 2)
    // How much of the nudge this row has earned: nothing at zero evidence,
    // all of it well past `minShows`.
    const trust = row.weight / (row.weight + minShows)
    effects[name] = {
      plays: row.plays,
      weight: Number(row.weight.toFixed(2)),
      completed: Number(row.completed.toFixed(2)),
      skipped: Number(row.skipped.toFixed(2)),
      rate: Number(rate.toFixed(3)),
      trust: Number(trust.toFixed(3)),
      trusted: row.weight >= minShows
    }
    if (row.weight >= minShows) trusted.push(name)
  }
  return { effects, trusted, rows: records.length, halfLifeDays }
}

/**
 * The score adjustment for one transition, in −MAX_NUDGE…+MAX_NUDGE.
 *
 * Unknown, untrusted, or absent scoreboards answer 0 — the caller's score is
 * left exactly as it was.
 */
export function effectNudge(name, outcomes, { max = MAX_NUDGE }: any = {}) {
  const row = outcomes?.effects?.[name]
  if (!row || !row.trusted) return 0
  // 0.5 is "coin flip"; ±0.5 of rate is worth ±`max`.
  return clamp((row.rate - 0.5) * 2 * row.trust * max, -max, max)
}

/** The rows worth showing an owner: played enough to mean something. */
export function outcomeReport(outcomes, { minPlays = 1 }: any = {}) {
  const rows = Object.entries((outcomes?.effects ?? {}) as Record<string, any>)
    .filter(([, row]) => row.plays >= minPlays)
    .map(([effect, row]) => ({ effect, ...row }))
    .sort((a, b) => b.rate - a.rate || b.plays - a.plays)
  return {
    rows,
    trusted: outcomes?.trusted ?? [],
    seams: outcomes?.rows ?? 0,
    halfLifeDays: outcomes?.halfLifeDays ?? OUTCOME_HALF_LIFE_DAYS,
    minShows: MIN_SHOWS
  }
}

export default effectOutcomes
