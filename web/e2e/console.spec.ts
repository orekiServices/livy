import { test, expect, type Page } from '@playwright/test'

const OWNER_KEY = process.env.LIVY_OWNER_KEY

const ROUTES: Array<[string, string | null]> = [
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
    await page.addInitScript((key: string) => window.sessionStorage.setItem('livy-owner-key', key), OWNER_KEY)
  }
})

function watch(page: Page): string[] {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (/favicon|net::ERR_|Failed to load resource/i.test(text)) return
    problems.push(`console: ${text}`)
  })
  return problems
}

for (const [routePath, heading] of ROUTES) {
  test(`${routePath} renders without a browser error`, async ({ page }) => {
    const problems = watch(page)
    const response = await page.goto(routePath, { waitUntil: 'networkidle' })
    expect(response?.status(), `${routePath} must answer 200`).toBe(200)
    const h1 = page.locator('h1').first()
    await expect(h1).toBeVisible()
    if (heading) await expect(h1).toContainText(heading)
    expect(problems, `${routePath} console output`).toEqual([])
  })
}

test('the station page shows the jumps and where they came from', async ({ page }) => {
  const problems = watch(page)
  await page.goto('/station', { waitUntil: 'networkidle' })
  await expect(page.getByText('Jumps', { exact: true })).toBeVisible()
  expect(problems).toEqual([])
})

test('the seams page shows the jukebox panel and its analysis source', async ({ page }) => {
  const problems = watch(page)
  await page.goto('/seams', { waitUntil: 'networkidle' })
  await expect(page.getByText('Jukebox', { exact: false }).first()).toBeVisible()
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

  await page.goto('/filters', { waitUntil: 'networkidle' })
  await expect(page.getByText(/1 live/)).toBeVisible()

  const cleared = await request.post(`/api/v1/owner/stations/${station.id}/filters`, { data: {} })
  expect(cleared.ok()).toBe(true)
  const after = await (await request.get(`/api/v1/owner/stations/${station.id}/filters`)).json()
  expect(after.active ?? []).not.toContain('equalizer')
})

test('the player is part of the shell, so a page change never cuts the stream', async ({ page }) => {
  const problems = watch(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  const player = page.locator('audio').first()
  await expect(player).toBeAttached()
  await page.getByRole('link', { name: /seams/i }).first().click()
  await expect(page.locator('h1').first()).toContainText('Seams')
  await expect(page.locator('audio').first()).toBeAttached()
  expect(problems).toEqual([])
})

test('screenshots every route for a human to look at', async ({ page }, testInfo) => {
  for (const [routePath] of ROUTES) {
    await page.goto(routePath, { waitUntil: 'networkidle' })
    await testInfo.attach(`console${routePath.replace(/\//g, '-')}.png`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png'
    })
  }
})
