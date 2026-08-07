// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright end-to-end configuration for the web app.
 *
 * Uses Playwright-managed Chromium by default. Set `E2E_BROWSER_CHANNEL`
 * (for example `chrome` or `msedge`) to validate a system browser channel.
 * The single project enables touch emulation
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
const browserChannel = process.env.E2E_BROWSER_CHANNEL;

// Unique paths for the throwaway workspace + data dir. Do not create them
// while evaluating this config: editor test discovery and `--list` also load
// the module but do not reliably run global teardown. The backend creates the
// directories when the actual test run starts.
const runId = `${process.pid}-${randomUUID()}`;
const e2eWorkspace = join(tmpdir(), `huabu-e2e-workspace-${runId}`);
const e2eDataDir = join(tmpdir(), `huabu-e2e-data-${runId}`);

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
    ...(browserChannel ? { channel: browserChannel } : {}),
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'touch',
      use: {
        ...devices['Desktop Chrome'],
        ...(browserChannel ? { channel: browserChannel } : {}),
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
      command: 'pnpm --filter @huabu/server dev',
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
      command: 'pnpm --filter @huabu/web dev',
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
