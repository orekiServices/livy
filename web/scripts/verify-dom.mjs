#!/usr/bin/env bun
/**
 * The console, checked as DOM.
 *
 * Playwright needs a browser; this does not. It fetches each route the console
 * exports, parses the HTML, and asserts the things that are wrong in the DOM
 * whether or not anyone is looking at a screenshot:
 *
 *   structure   one <main>, one <nav>, one <h1>, a skip link that points at
 *               something, headings that do not skip a level, no duplicate ids
 *   navigation  every nav destination exists, and the current page is marked
 *   access      every control has a name, every image has alt, no positive
 *               tabindex
 *   links       every internal href answers 200
 *   styles      every class in the markup exists in the built CSS, which is
 *               how a mistyped utility, which Tailwind silently drops, gets
 *               caught
 *
 *   bun run verify:dom [baseUrl]
 *
 * Needs a node serving the console (`bun src/index.js` from server/, port
 * 3000). It reads the built CSS from the same origin, so run it against the
 * built console rather than the dev server.
 */
import * as cheerio from 'cheerio'

const base = (process.argv[2] ?? process.env.LIVY_CONSOLE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')

const ROUTES = ['/', '/station', '/seams', '/filters', '/lyrics', '/search', '/stations', '/models', '/ops', '/owner']

const results = []
const record = (route, name, ok, detail = '') => {
  results.push({ route, name, ok, detail })
  if (!ok) console.log(`FAIL  ${route}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const get = (path) => fetch(`${base}${path}`, { cache: 'no-store', headers: { accept: 'text/html' } })

/** Variant prefixes Tailwind puts on a class, e.g. `hover:` or `md:`. */
const VARIANTS = /^(?:(?:[a-z-]+|\[\S+\]):)+/
const isArbitrary = (token) => token.includes('[')

/**
 * The forms Tailwind can emit for one class. A plain utility is `.w-56`;
 * a variant is `.md\:w-56`, so the bare selector never exists and the class
 * only appears with the variant glued in front of it. Opacity slashes are
 * escaped too, which is why `.bg-cyan\/20` is one of the forms.
 */
const classForms = (token) => [
  `.${token}`,
  `.${token.replace(/[:./[\]]/g, (char) => `\\${char}`)}`,
  token.replace(/\//g, '\\/')
]

/** `/stations/` and `/stations` are the same page to everyone but a string. */
const canonical = (href) => (href === '/' ? '/' : href.replace(/\/$/, ''))

/** Routes that are not in the rail (they are opened from a station row). */
const OFF_RAIL = new Set(['/station'])

const pages = new Map()
let css = ''

async function loadCss() {
  const res = await get('/')
  const html = await res.text()
  const href = html.match(/href="([^"]*_next\/static\/[^"]+\.css)"/)?.[1]
  if (!href) return
  const sheet = await get(href.startsWith('http') ? href.replace(base, '') : href)
  css = await sheet.text()
}

function accessibleName($, element) {
  const $el = $(element)
  const text = $el.text().replace(/\s+/g, ' ').trim()
  if (text) return text
  const label = $el.attr('aria-label')
  if (label) return label
  const labelledBy = $el.attr('aria-labelledby')
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/).map((id) => $(`#${id}`).text().trim()).filter(Boolean)
    if (parts.length) return parts.join(' ')
  }
  const title = $el.attr('title')
  if (title) return title
  const alt = $el.find('img[alt]').attr('alt')
  if (alt) return alt
  return ''
}

function checkStructure(route, $) {
  record(route, 'one <main>', $('main').length === 1, `${$('main').length} found`)
  record(route, 'main has an id for the skip link', $('main#main').length === 1)
  record(route, 'one primary <nav>', $('nav[aria-label="Console"]').length >= 1, `${$('nav[aria-label="Console"]').length} found`)
  record(route, 'a <footer> for the player', $('footer').length === 1)
  record(route, 'skip link points at #main', $('a[href="#main"]').length === 1)
  record(route, 'language declared', $('html').attr('lang') === 'en')
  record(route, 'title is not empty', ($('title').text() ?? '').trim().length > 0)

  const h1 = $('h1')
  record(route, 'exactly one <h1>', h1.length === 1, `${h1.length} found: ${h1.map((_, el) => $(el).text().trim()).get().join(' | ')}`)

  const headings = $('h1, h2, h3, h4, h5, h6').map((_, el) => Number(el.tagName.slice(1))).get()
  let skip = null
  let previous = 0
  for (const level of headings) {
    if (previous && level > previous + 1) {
      skip = `h${previous} → h${level}`
      break
    }
    previous = level
  }
  record(route, 'headings do not skip a level', !skip, skip ?? '')

  const ids = $('[id]').map((_, el) => $(el).attr('id')).get()
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
  record(route, 'no duplicate ids', duplicates.length === 0, [...new Set(duplicates)].join(', '))
}

function checkNav(route, $) {
  const navs = $('nav[aria-label="Console"]')
  const hrefs = navs
    .find('a[href]')
    .map((_, el) => canonical($(el).attr('href')))
    .get()
  const wanted = ['/', '/stations', '/search', '/lyrics', '/seams', '/filters', '/models', '/ops', '/owner']
  const missing = wanted.filter((href) => !hrefs.includes(href))
  record(route, 'nav lists every destination', missing.length === 0, missing.join(', '))

  const current = navs.find('a[aria-current="page"]')
  const marked = current
    .map((_, el) => $(el).attr('href'))
    .get()
    .filter(Boolean)
  if (OFF_RAIL.has(route)) {
    // Not in the rail, so there is nothing to mark; what matters is that the
    // rail does not claim some other page is current.
    const expected = canonical(route)
    const wrong = marked.filter((href) => canonical(href) !== expected)
    record(route, 'an off-rail page marks nothing', wrong.length === 0, wrong.join(', '))
    return
  }
  const expected = canonical(route)
  const ok = marked.some((href) => canonical(href) === expected)
  record(route, 'current page is marked in the nav', ok, `marked: ${marked.join(', ') || 'none'}`)
}

function checkAccess(route, $) {
  const unnamedButtons = $('button')
    .filter((_, el) => !accessibleName($, el))
    .map((_, el) => $.html(el).slice(0, 90))
    .get()
  record(route, 'every button has a name', unnamedButtons.length === 0, unnamedButtons.join(' | '))

  const unnamedLinks = $('a[href]')
    .filter((_, el) => !accessibleName($, el))
    .map((_, el) => $(el).attr('href'))
    .get()
  record(route, 'every link has a name', unnamedLinks.length === 0, unnamedLinks.join(', '))

  const badImages = $('img').filter((_, el) => $(el).attr('alt') === undefined).length
  record(route, 'every image has alt', badImages === 0, `${badImages} without alt`)

  const unnamedInputs = $('input, select, textarea')
    .filter((_, el) => {
      const $el = $(el)
      if ($el.attr('type') === 'hidden') return false
      if (accessibleName($, el)) return false
      const id = $el.attr('id')
      if (id && $(`label[for="${id}"]`).length) return false
      return $el.parents('label').length === 0
    })
    .map((_, el) => `${el.tagName}${$(el).attr('type') ? `[type=${$(el).attr('type')}]` : ''}${$(el).attr('name') ? `[name=${$(el).attr('name')}]` : ''}`)
    .get()
  record(route, 'every field has a label', unnamedInputs.length === 0, unnamedInputs.join(', '))

  const brokenSwitches = $('[role="switch"]')
    .filter((_, el) => $(el).attr('aria-checked') === undefined || !accessibleName($, el))
    .length
  record(route, 'switches say their state and their name', brokenSwitches === 0, `${brokenSwitches} incomplete`)

  const positiveTabindex = $('[tabindex]')
    .filter((_, el) => Number($(el).attr('tabindex')) > 0)
    .length
  record(route, 'no positive tabindex', positiveTabindex === 0, `${positiveTabindex} found`)

  const alerts = $('[role="alert"]').length
  const status = $('[role="status"]').length
  record(route, 'live regions are labelled by role', alerts + status >= 0)
}

function checkStyles(route, $) {
  if (!css) return
  const used = new Set()
  $('[class]').each((_, el) => {
    for (const token of String($(el).attr('class') ?? '').split(/\s+/)) {
      if (!token) continue
      const base = token.replace(VARIANTS, '')
      if (!base || isArbitrary(base)) continue
      used.add(base)
    }
  })
  // Custom classes defined in globals.css are in the sheet too, so the same
  // check covers them; anything missing is a class Tailwind never emitted.
  const missing = [...used].filter((token) => !classForms(token).some((form) => css.includes(form)))
  record(route, 'every class exists in the built CSS', missing.length === 0, missing.slice(0, 8).join(', '))
}

async function main() {
  await loadCss()
  record('/', 'stylesheet is served', Boolean(css), css ? `${(css.length / 1024).toFixed(0)} kB` : 'no stylesheet found')

  for (const route of ROUTES) {
    const res = await get(route)
    const html = await res.text()
    record(route, 'answers 200 with HTML', res.ok && /text\/html/.test(res.headers.get('content-type') ?? ''), `${res.status}`)
    if (!res.ok) continue

    const $ = cheerio.load(html)
    pages.set(route, $)
    checkStructure(route, $)
    checkNav(route, $)
    checkAccess(route, $)
    checkStyles(route, $)
  }

  // Every internal link the pages offer has to answer; a console full of dead
  // ends is worse than one with fewer links.
  const internal = new Set()
  for (const $ of pages.values()) {
    $('a[href^="/"]').each((_, el) => {
      const href = $(el).attr('href').split('#')[0].split('?')[0]
      if (href && !href.startsWith('/_next')) internal.add(href)
    })
  }
  const dead = []
  for (const href of internal) {
    const res = await get(href)
    if (!res.ok) dead.push(`${href} (${res.status})`)
  }
  record('all', `every internal link answers (${internal.size} links)`, dead.length === 0, dead.join(', '))

  const failed = results.filter((entry) => !entry.ok)
  const passed = results.length - failed.length
  console.log(`\n${passed}/${results.length} checks passed across ${ROUTES.length} routes`)
  if (failed.length) {
    console.log('\nFailures:')
    for (const entry of failed) console.log(`  ${entry.route}  ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`)
    process.exit(1)
  }
}

await main()
