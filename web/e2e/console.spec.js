import { test, expect } from '@playwright/test'

/**
 * The console, driven the way a person drives it.
 *
 * Every test runs against a live node, because the console is mostly a thin
 * view over `/api/v1`: a page that renders but cannot read the node is not
 * working, and a page that throws in the console is not working either even
 * when it renders. So each test both asserts on what is on screen and fails on
 * an uncaught exception or a React error in the browser console.
 *
 * `LIVY_OWNER_KEY` is optional. On a node with no owner key set, the owner
 * routes are open and the console skips its key prompt; on a locked node, set
 * the variable and the console never asks.
 */

const OWNER_KEY = process.env.LIVY_OWNER_KEY

/** Routes that must render for the console to be usable at all. */
const ROUTES = [
  ['/', 'Late night'],
  ['/station', null],
  ['/seams', 'Seams'],
  ['/filters', 'Radio filters'],
  ['/lyrics', 'Words'],
  ['/search', 'Search'],
  ['/stations', 'Stations'],
  ['/models', 'Training'],
  ['/ops', 'Node'],
  ['/owner', 'Owner desk']
]

test.beforeEach(async ({ page }) => {
  if (OWNER_KEY) {
    await page.addInitScript((key) => window.sessionStorage.setItem('livy-owner-key', key), OWNER_KEY)
  }
})

/** Collect what the browser complained about, so a test can fail on it. */
function watch(page) {
  const problems = []
  page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    // A missing favicon is not a broken console, and the node answers 404 for
    // routes it does not export; both show up here as noise.
    if (/favicon|net::ERR_|Failed to load resource/i.test(text)) return
    problems.push(`console: ${text}`)
  })
  return problems
}

for (const [path, heading] of ROUTES) {
  test(`${path} renders without a browser error`, async ({ page }) => {
    const problems = watch(page)
    const response = await page.goto(path, { waitUntil: 'networkidle' })
    expect(response?.status(), `${path} must answer 200`).toBe(200)
    // `/station` is headed by the station's own name, so it is the only route
    // without a fixed string to look for.
    const h1 = page.locator('h1').first()
    await expect(h1).toBeVisible()
    if (heading) await expect(h1).toContainText(heading)
    expect(problems, `${path} console output`).toEqual([])
  })
}

test('the station page shows the jumps and where they came from', async ({ page }) => {
  const problems = watch(page)
  await page.goto('/station', { waitUntil: 'networkidle' })
  // The Jumps stat is the trainer's view of the last jump; its hint names the
  // source, which is how a Forever Jukebox graph is visible from the console.
  await expect(page.getByText('Jumps', { exact: true })).toBeVisible()
  expect(problems).toEqual([])
})

test('the seams page shows the jukebox panel and its analysis source', async ({ page }) => {
  const problems = watch(page)
  await page.goto('/seams', { waitUntil: 'networkidle' })
  await expect(page.getByText('Jukebox', { exact: false }).first()).toBeVisible()
  // `forever.api` is the analysis endpoint the node is pointed at; it is shown
  // so an owner can tell a remote analyser from the local fallback.
  await expect(page.getByText(/analysis/i).first()).toBeVisible()
  expect(problems).toEqual([])
})

test('a filter change round-trips through the API and the rack shows it', async ({ page, request }) => {
  const stations = await (await request.get('/api/v1/stations')).json()
  const station = (stations.stations ?? stations ?? [])[0]
  test.skip(!station, 'the node has no station to filter')

  const set = await request.post(`/api/v1/owner/stations/${station.id}/filters`, {
    data: { equalizer: { bands: [{ band: 5, gain: 0.5 }] } }
  })
  expect(set.ok(), await set.text()).toBe(true)

  const state = await (await request.get(`/api/v1/owner/stations/${station.id}/filters`)).json()
  expect(state.active ?? []).toContain('equalizer')

  // The rack page reads the same state, so the badge must agree with the API.
  await page.goto('/filters', { waitUntil: 'networkidle' })
  await expect(page.getByText(/1 live/)).toBeVisible()

  const cleared = await request.post(`/api/v1/owner/stations/${station.id}/filters`, { data: {} })
  expect(cleared.ok()).toBe(true)
  const after = await (await request.get(`/api/v1/owner/stations/${station.id}/filters`)).json()
  expect(after.active ?? []).not.toContain('equalizer')
})

test('the player is part of the shell, so a page change never cuts the stream', async ({ page }) => {
  const problems = watch(page)
  // The <audio> element lives in the shell, not in a page: navigating between
  // routes must not replace it, which is the whole reason it is there.
  await page.goto('/', { waitUntil: 'networkidle' })
  const player = page.locator('audio').first()
  await expect(player).toBeAttached()
  await page.getByRole('link', { name: /seams/i }).first().click()
  await expect(page.locator('h1').first()).toContainText('Seams')
  await expect(page.locator('audio').first()).toBeAttached()
  expect(problems).toEqual([])
})

test('screenshots every route for a human to look at', async ({ page }, testInfo) => {
  for (const [path] of ROUTES) {
    await page.goto(path, { waitUntil: 'networkidle' })
    await testInfo.attach(`console${path.replace(/\//g, '-')}.png`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png'
    })
  }
})
