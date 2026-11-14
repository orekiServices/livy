import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright against a running node.
 *
 * The console is served by the radio node itself, so there is nothing to start
 * here: point `LIVY_CONSOLE_URL` at a node (default `http://127.0.0.1:3000`,
 * which is where `bun src/index.js` puts it) and run `bun run test:e2e`.
 *
 * `bunx playwright install chromium` downloads the browser once. It is not part
 * of `bun install` on purpose: CI images usually bring their own, and a failed
 * browser download should not fail a dependency install.
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
    // The preview origin is not localhost, and the console is same-origin, so
    // there is nothing to relax here beyond the standard headless flags.
    ignoreHTTPSErrors: true
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  outputDir: './e2e/test-results'
})
