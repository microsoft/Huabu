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
 * server persists inside its active workspace. To keep tests from ever
 * writing into the developer's real workspace or app data, Playwright boots a
 * *dedicated* backend pointed at throwaway temp dirs:
 *
 *   • `HUABU_WORKSPACE` → a fresh temp workspace (all created Spaces land here)
 *   • `HUABU_DATA_DIR`  → a fresh temp data dir (sqlite, secrets, logs)
 *
 * `HUABU_WORKSPACE` is Disk's isolation, and only Disk's: it names a folder,
 * and a structured backend that keeps Spaces in tables has none, so setting it
 * there is a configuration error the server refuses at boot. On such a profile
 * the data dir is the whole isolation — the backend opens its own Workspace
 * underneath it — so the suite passes the data dir alone. Select the profile
 * under test the way a deployment does, through `HUABU_STRUCTURED_BACKEND`:
 *
 *   HUABU_STRUCTURED_BACKEND=sqlite pnpm test:e2e
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

// Only the Disk structured backend gives a Workspace a folder to lock onto.
// Anything else is isolated by its data dir alone, and would refuse to boot if
// handed a Workspace path (see `initWorkspaceFromEnv`).
const structuredBackend = process.env.HUABU_STRUCTURED_BACKEND ?? 'disk';
const workspaceIsAFolder = structuredBackend.trim().toLowerCase() === 'disk';

// Expose the temp dirs to `global-teardown.ts` (same runner process) so it can
// delete them after the run and keep repeated e2e runs from piling up.
if (workspaceIsAFolder) process.env.E2E_WORKSPACE_DIR = e2eWorkspace;
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
      // Isolated backend: pointed at the temp dirs its profile can use.
      command: 'pnpm --filter @huabu/server dev',
      url: `http://localhost:${E2E_SERVER_PORT}/api/workspace`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        SERVER_PORT: E2E_SERVER_PORT,
        ...(workspaceIsAFolder ? { HUABU_WORKSPACE: e2eWorkspace } : {}),
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
