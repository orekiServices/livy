/**
 * Hourly ident — "It's nine o'clock, you're listening to Night Drive FM."
 *
 * Ships **disabled** (`"enabled": false` in plugin.json — a plugin can only
 * ship switched off from a manifest file, since that is read before the code
 * is imported). Turn it on from the Plugins panel or with
 * `POST /api/v1/owner/plugins/hourly-ident/enable`.
 *
 * Demonstrates `ctx.every()`, reading settings, and driving a station — and
 * it only ever speaks on the stations it is switched on for, because
 * `ctx.stations.all()` is already scoped by the host.
 */
export const manifest = {
  name: 'Hourly ident',
  version: '1.1.0',
  description: 'speaks the time and the station name on the hour',
  // Per station — most owners want the ident on one or two channels, not on
  // the ambient stream someone is trying to sleep to.
  scope: 'stations'
}

const WORDS = ['twelve', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven']

const spokenHour = (date) => {
  const hour = date.getHours()
  const name = WORDS[hour % 12]
  if (hour === 0) return 'midnight'
  if (hour === 12) return 'midday'
  return `${name} ${hour < 12 ? 'in the morning' : hour < 18 ? 'in the afternoon' : 'in the evening'}`
}

export default function setup(ctx) {
  const onlyWhenPlaying = ctx.settings.onlyWhenPlaying !== false
  let lastHour = new Date().getHours()

  ctx.every(30_000, () => {
    const now = new Date()
    if (now.getHours() === lastHour) return
    lastHour = now.getHours()

    for (const station of ctx.stations.all()) {
      if (onlyWhenPlaying && station.state !== 'playing') continue
      const text = `It's ${spokenHour(now)}. You're listening to ${station.name}.`
      try {
        station.say(text, { artist: station.name })
        ctx.log.info(`ident on ${station.id}`, { text })
      } catch (error) {
        ctx.log.warn(`could not speak on ${station.id}: ${error.message}`)
      }
    }
  })

  ctx.log.info('waiting for the top of the hour')
}
