import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
 * Isolation: the suite creates real Spaces (`POST /api/canvas`), which the
 * server persists as folders inside its active workspace. To keep tests from
 * ever writing into the developer's real workspace or app data, Playwright
 * boots a *dedicated* backend locked (managed mode) to throwaway temp dirs:
 *
 *   • `HUABU_WORKSPACE` → a fresh temp workspace (all created Spaces land here)
 *   • `HUABU_DATA_DIR`  → a fresh temp data dir (sqlite, secrets, logs)
 *
 * Both dev servers run on dedicated ports and set `reuseExistingServer:false`
 * so an already-running local dev stack (which points at the real workspace)
 * is never reused. Temp dirs are process-scoped and discarded by the OS.
 */

// Dedicated, non-default ports so a running `pnpm dev` stack is never reused.
const E2E_SERVER_PORT = process.env.E2E_SERVER_PORT ?? '3101';
const E2E_WEB_PORT = process.env.E2E_WEB_PORT ?? '5273';
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${E2E_WEB_PORT}`;

// Throwaway workspace + data dir for the e2e backend. Managed mode locks the
// server to `HUABU_WORKSPACE` at boot, so every Space the suite creates is
// written here instead of the developer's real workspace.
const e2eWorkspace = mkdtempSync(join(tmpdir(), 'sediment-e2e-workspace-'));
const e2eDataDir = mkdtempSync(join(tmpdir(), 'sediment-e2e-data-'));

// Expose the temp dirs to `global-teardown.ts` (same runner process) so it can
// delete them after the run and keep repeated e2e runs from piling up.
process.env.E2E_WORKSPACE_DIR = e2eWorkspace;
process.env.E2E_DATA_DIR = e2eDataDir;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL,
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
  webServer: [
    {
      // Isolated backend: locked to temp workspace + data dir (managed mode).
      command: 'pnpm --filter @sediment/server dev',
      url: `http://localhost:${E2E_SERVER_PORT}/api/workspace`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        SERVER_PORT: E2E_SERVER_PORT,
        HUABU_WORKSPACE: e2eWorkspace,
        HUABU_DATA_DIR: e2eDataDir,
      },
    },
    {
      // Web dev server proxying `/api` to the isolated backend above.
      command: 'pnpm --filter @sediment/web dev',
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        WEB_PORT: E2E_WEB_PORT,
        SERVER_PORT: E2E_SERVER_PORT,
      },
    },
  ],
});
