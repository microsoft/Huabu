// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * End-to-end acceptance for a selected storage profile.
 *
 * Phase 6 made `postgres` records and `azure` blobs selectable, and made Agent
 * persistence asynchronous underneath. Both halves are covered by unit and
 * service-level suites; what no suite can cover is whether a *deployment* on
 * those backends actually works — a Space created through the UI, an Agent
 * turn driven by a real model, an attachment whose bytes leave the machine,
 * and all of it still there after the server process is replaced.
 *
 * The profile is selected the way a deployment selects it, through
 * `HUABU_STRUCTURED_BACKEND` / `HUABU_BLOB_BACKEND`, so one config covers
 * every pairing:
 *
 *   pnpm --filter @huabu/web exec playwright test \
 *     --config playwright.storage-profiles.config.ts
 *
 *   HUABU_STRUCTURED_BACKEND=postgres HUABU_BLOB_BACKEND=azure \
 *   HUABU_POSTGRES_URL=... HUABU_AZURE_STORAGE_CONNECTION_STRING=... \
 *   HUABU_AZURE_BLOB_CONTAINER=... HUABU_AZURE_BLOB_PREFIX=... \
 *   pnpm --filter @huabu/web exec playwright test \
 *     --config playwright.storage-profiles.config.ts
 *
 * Isolation follows `playwright.config.ts`: only the Disk structured backend
 * has a Workspace folder to lock onto, so `HUABU_WORKSPACE` is passed there
 * and nowhere else, and every profile gets its own temp data dir. A run
 * against a shared service should be given a prefix of its own
 * (`HUABU_AZURE_BLOB_PREFIX`) and a database of its own, because this config
 * deliberately does not delete what a backend holds outside the temp dir.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const SERVER_PORT = process.env.E2E_SERVER_PORT ?? '3121';
const WEB_PORT = process.env.E2E_WEB_PORT ?? '5293';
const baseURL = `http://127.0.0.1:${WEB_PORT}`;

const structured = (process.env.HUABU_STRUCTURED_BACKEND ?? 'postgres')
  .trim()
  .toLowerCase();
const blobs = (process.env.HUABU_BLOB_BACKEND ?? 'azure').trim().toLowerCase();

const workspaceIsAFolder = structured === 'disk';

// This module is evaluated by the runner *and* again by every worker, which
// inherits the runner's environment. Minting a fresh run id each time would
// give the worker a different state file than the one globalSetup wrote, so
// the run's identity is decided once and then read back.
if (!process.env.E2E_BACKEND_STATE) {
  const runId = `${process.pid}-${randomUUID()}`;
  const dataDir = join(tmpdir(), `huabu-profile-e2e-data-${runId}`);
  process.env.E2E_DATA_DIR = dataDir;
  if (workspaceIsAFolder)
    process.env.E2E_WORKSPACE_DIR = join(
      tmpdir(),
      `huabu-profile-e2e-workspace-${runId}`,
    );
  process.env.E2E_SERVER_PORT = SERVER_PORT;
  process.env.E2E_BACKEND_STATE = join(
    tmpdir(),
    `huabu-profile-e2e-${runId}.json`,
  );
  process.env.E2E_STORAGE_PROFILE = `${structured}/${blobs}`;
  process.env.E2E_BACKEND_ENV = JSON.stringify({
    HUABU_STRUCTURED_BACKEND: structured,
    HUABU_BLOB_BACKEND: blobs,
    HUABU_DATA_DIR: dataDir,
    ...(workspaceIsAFolder
      ? { HUABU_WORKSPACE: process.env.E2E_WORKSPACE_DIR }
      : {}),
    HUABU_BIND_HOST: '127.0.0.1',
  });
}

export default defineConfig({
  testDir: './e2e',
  testMatch: 'storage-profiles.spec.ts',
  // A real model turn is the slow step, and it is the point of the suite.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  globalSetup: './e2e/storage-profile-setup.ts',
  globalTeardown: './e2e/storage-profile-teardown.ts',
  outputDir: './test-results/storage-profiles',
  metadata: { storageProfile: `${structured}/${blobs}`, realAgentRun: true },
  use: {
    baseURL,
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'on',
    viewport: { width: 1600, height: 1000 },
  },
  projects: [
    { name: `${structured}/${blobs}`, use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'pnpm exec vite --host 127.0.0.1',
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        WEB_PORT,
        SERVER_PORT,
        VITE_API_PROXY_TARGET: `http://127.0.0.1:${SERVER_PORT}`,
      },
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    },
  ],
});
