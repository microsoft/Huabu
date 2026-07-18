import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright end-to-end configuration for the web app.
 *
 * Uses the system Google Chrome (`channel: 'chrome'`) so no browser
 * download is required. The single project enables touch emulation
 * (`hasTouch` + `isMobile`) because these tests exist to exercise the
 * canvas multi-touch / pen gesture pipeline, which unit tests cannot
 * drive faithfully.
 *
 * The tests run against a already-running dev stack on `baseURL`. When
 * the port is free, Playwright starts the web dev server; when it is
 * already up (the common local case), it reuses it.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5174',
    channel: 'chrome',
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'touch',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        locale: 'en-US',
        hasTouch: true,
        isMobile: false,
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
  webServer: {
    command: 'pnpm --filter @sediment/web dev',
    url: process.env.E2E_BASE_URL ?? 'http://localhost:5174',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
