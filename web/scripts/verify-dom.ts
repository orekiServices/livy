#!/usr/bin/env bun
/**
 * The console, checked as DOM.
 *
 * Fetches each route the console exports, parses the HTML, and asserts
 * structure, navigation, accessibility, internal links, and built CSS classes.
 *
 *   bun run verify:dom [baseUrl]
 */
import * as cheerio from 'cheerio'
import type { CheerioAPI } from 'cheerio'
import type { AnyNode } from 'domhandler'

const base = (process.argv[2] ?? process.env.LIVY_CONSOLE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')

const ROUTES = ['/', '/station', '/seams', '/filters', '/lyrics', '/search', '/stations', '/models', '/ops', '/owner']

interface CheckResult {
  route: string
  name: string
  ok: boolean
  detail: string
}

const results: CheckResult[] = []
const record = (route: string, name: string, ok: boolean, detail = ''): void => {
  results.push({ route, name, ok, detail })
  if (!ok) console.log(`FAIL  ${route}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const get = (p: string): Promise<Response> => fetch(`${base}${p}`, { cache: 'no-store', headers: { accept: 'text/html' } })

const VARIANTS = /^(?:(?:[a-z-]+|\[\S+\]):)+/
const isArbitrary = (token: string): boolean => token.includes('[')

const classForms = (token: string): string[] => [
  `.${token}`,
  `.${token.replace(/[:./[\]]/g, (char) => `\\${char}`)}`,
  token.replace(/\//g, '\\/')
]

const canonical = (href: string | undefined): string => {
  if (!href) return ''
  return href === '/' ? '/' : href.replace(/\/$/, '')
}

const OFF_RAIL = new Set(['/station'])

const pages = new Map<string, CheerioAPI>()
let css = ''

async function loadCss(): Promise<void> {
  const res = await get('/')
  const html = await res.text()
  const href = html.match(/href="([^"]*_next\/static\/[^"]+\.css)"/)?.[1]
  if (!href) return
  const sheet = await get(href.startsWith('http') ? href.replace(base, '') : href)
  css = await sheet.text()
}

function accessibleName($: CheerioAPI, element: AnyNode): string {
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

function checkStructure(route: string, $: CheerioAPI): void {
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
  let skip: string | null = null
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

function checkNav(route: string, $: CheerioAPI): void {
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
    .filter((h): h is string => Boolean(h))
  if (OFF_RAIL.has(route)) {
    const expected = canonical(route)
    const wrong = marked.filter((href) => canonical(href) !== expected)
    record(route, 'an off-rail page marks nothing', wrong.length === 0, wrong.join(', '))
    return
  }
  const expected = canonical(route)
  const ok = marked.some((href) => canonical(href) === expected)
  record(route, 'current page is marked in the nav', ok, `marked: ${marked.join(', ') || 'none'}`)
}

function checkAccess(route: string, $: CheerioAPI): void {
  const unnamedButtons = $('button')
    .filter((_, el) => !accessibleName($, el))
    .map((_, el) => $.html(el).slice(0, 90))
    .get()
  record(route, 'every button has a name', unnamedButtons.length === 0, unnamedButtons.join(' | '))

  const unnamedLinks = $('a[href]')
    .filter((_, el) => !accessibleName($, el))
    .map((_, el) => $(el).attr('href') ?? '')
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

function checkStyles(route: string, $: CheerioAPI): void {
  if (!css) return
  const used = new Set<string>()
  $('[class]').each((_, el) => {
    for (const token of String($(el).attr('class') ?? '').split(/\s+/)) {
      if (!token) continue
      const stripped = token.replace(VARIANTS, '')
      if (!stripped || isArbitrary(stripped)) continue
      used.add(stripped)
    }
  })
  const missing = [...used].filter((token) => !classForms(token).some((form) => css.includes(form)))
  record(route, 'every class exists in the built CSS', missing.length === 0, missing.slice(0, 8).join(', '))
}

async function main(): Promise<void> {
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

  const internal = new Set<string>()
  for (const $ of pages.values()) {
    $('a[href^="/"]').each((_, el) => {
      const raw = $(el).attr('href') ?? ''
      const href = raw.split('#')[0].split('?')[0]
      if (href && !href.startsWith('/_next')) internal.add(href)
    })
  }
  const dead: string[] = []
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
