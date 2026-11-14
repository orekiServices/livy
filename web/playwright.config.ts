import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright against a running node.
 *
 * Point `LIVY_CONSOLE_URL` at a node (default `http://127.0.0.1:3000`, which
 * is where `bun src/index.ts` puts it) and run `bun run test:e2e`.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.LIVY_CONSOLE_URL ?? 'http://127.0.0.1:3000',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    ignoreHTTPSErrors: true
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  outputDir: './e2e/test-results'
})
