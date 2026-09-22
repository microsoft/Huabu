// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

// Build first with VITE_CHAT_PERFORMANCE_FIXTURE=true. No backend or workspace
// is needed: the spec rejects API calls and keeps complete histories in memory.
const port = process.env.E2E_ACTIVATION_PORT ?? '5381';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: '.',
  testMatch: 'chat-activation.spec.ts',
  metadata: { chatActivationProduction: true },
  outputDir: '../test-results/chat-activation',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    ...(process.env.E2E_BROWSER_CHANNEL
      ? { channel: process.env.E2E_BROWSER_CHANNEL }
      : {}),
  },
  webServer: {
    command: `pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
