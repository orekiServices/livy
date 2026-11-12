/**
 * The DJ — voice-tracking scripts for the automix.
 *
 * A real automation system does not play wall-to-wall music: every few songs
 * the jock talks over the transition ("voice tracking"). This module writes
 * that line; `automix.js` mixes it over the crossfade and ducks the music
 * underneath it. Lines are short on purpose — the ramp of the next song is
 * only a few seconds long.
 *
 * Nothing here is provider specific: the text is handed to the station's TTS
 * engine, so the same script works with the bundled voice, Google TTS or an
 * owner-supplied audio file.
 */

const clean = (value, fallback = '') => {
  const text = String(value ?? '').trim()
  if (!text) return fallback
  // Strip the noise that shows up in scraped titles: "(Official Video)", tags…
  return text
    .replace(/\((?:official|lyric|audio|hd|hq|4k)[^)]*\)/gi, '')
    .replace(/\[(?:official|free download|out now)[^\]]*\]/gi, '')
    .replace(/\s*[-–—]\s*(?:official\s+)?(?:music\s+)?video$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || fallback
}

/** "Mai, Tuan and 2 more" — used when several people requested the song. */
const listNames = (names) => {
  const unique = [...new Set(names.filter(Boolean))]
  if (unique.length === 0) return null
  if (unique.length === 1) return unique[0]
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`
  return `${unique[0]}, ${unique[1]} and ${unique.length - 2} more`
}

export function partOfDay(date = new Date()) {
  const hour = date.getHours()
  if (hour < 5) return 'late night'
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  if (hour < 22) return 'evening'
  return 'night'
}

export function greeting(date = new Date()) {
  const part = partOfDay(date)
  if (part === 'late night') return 'Still with us at this hour'
  if (part === 'morning') return 'Good morning'
  if (part === 'afternoon') return 'Good afternoon'
  if (part === 'evening') return 'Good evening'
  return 'Good night'
}

/**
 * Build a voice-track line for the seam between two songs.
 *
 * @param {object} ctx
 * @param {object|null} ctx.from   the song going out
 * @param {object|null} ctx.to     the song coming in
 * @param {string} ctx.station     station name
 * @param {string} ctx.dj          DJ name
 * @param {number} ctx.listeners   current listener count
 * @param {number} ctx.index       how many breaks this DJ has done (varies the script)
 * @param {Date}   ctx.now
 * @returns {{ text: string, kind: string }}
 */
export function djLine({ from = null, to = null, station = 'the station', dj = 'Ava', listeners = 0, index = 0, now = new Date() } = {}) {
  const outTitle = clean(from?.title)
  const outArtist = clean(from?.artist)
  const inTitle = clean(to?.title)
  const inArtist = clean(to?.artist)
  const requester = listNames([to?.requestedBy, from?.requestedBy].filter(Boolean))

  const back = outTitle ? (outArtist ? `${outTitle} by ${outArtist}` : outTitle) : null
  const next = inTitle ? (inArtist ? `${inTitle} by ${inArtist}` : inTitle) : null

  // A request always gets a shout-out: that is the whole point of the line.
  if (requester && next) {
    return {
      kind: 'request',
      text: `That one goes out to ${requester}, thanks for calling it in. Here is ${next}, on ${station}.`
    }
  }

  const both = []
  if (back && next) {
    both.push(
      `That was ${back}. Coming up next, ${next}. You are listening to ${station}.`,
      `${back} there on ${station}. Stay with me, ${next} is next.`,
      `You just heard ${back}. I am ${dj}, and this is ${next}.`,
      `${greeting(now)} — that was ${back}, and we keep it going with ${next}.`
    )
    if (listeners > 0) {
      both.push(`${listeners} ${listeners === 1 ? 'listener' : 'listeners'} with us right now on ${station}. That was ${back}, here comes ${next}.`)
    }
  }

  const forward = []
  if (next) {
    forward.push(
      `Next up on ${station}, ${next}.`,
      `Keeping the ${partOfDay(now)} moving, here is ${next}.`,
      `${greeting(now)}, I am ${dj} on ${station}. This is ${next}.`
    )
  }

  const backOnly = []
  if (back) {
    backOnly.push(`That was ${back}, here on ${station}.`, `${back} — you are with ${dj} on ${station}.`)
  }

  const pool = both.length ? both : forward.length ? forward : backOnly.length ? backOnly : [`You are listening to ${station}, with ${dj}.`]
  const text = pool[Math.abs(index) % pool.length]
  return { kind: both.length ? 'segue' : forward.length ? 'intro' : 'outro', text }
}

export default djLine
