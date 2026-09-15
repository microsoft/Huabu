// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from '@playwright/test';
import { parse } from 'dotenv';

import base from './playwright.config';

// Reuse the standard harness's temporary directories and teardown, but never
// inherit deployment credentials, proxy targets, or a different worktree.
const webRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(webRoot, '../..');
const serverPort = '3197';
const webPort = '5297';
const baseURL = `http://127.0.0.1:${webPort}`;
const workspace = process.env.E2E_WORKSPACE_DIR;
const dataDir = process.env.E2E_DATA_DIR;
if (
  !workspace ||
  !dataDir ||
  process.env.HUABU_STRUCTURED_BACKEND?.trim() === 'sqlite'
) {
  throw new Error('Portal acceptance requires the isolated Disk profile');
}
const env: Record<string, string> = {};
for (const key of Object.keys(process.env)) {
  if (
    /^(HUABU_|VITE_|AGENTLET_|ACP_|AZURE_|AWS_|GOOGLE_|OPENAI_|ANTHROPIC_|GITHUB_|COPILOT_|TAVILY_|RAPIDAPI_|XDG_)|KEY|TOKEN|SECRET|PASSWORD|PROXY/i.test(
      key,
    )
  ) {
    env[key] = '';
  }
}
for (const directory of [repoRoot, webRoot, join(repoRoot, 'apps/server')]) {
  for (const name of [
    '.env',
    '.env.local',
    '.env.development',
    '.env.development.local',
  ]) {
    const file = join(directory, name);
    if (existsSync(file)) {
      for (const key of Object.keys(parse(readFileSync(file)))) env[key] = '';
    }
  }
}
Object.assign(env, {
  HUABU_WORKSPACE: workspace,
  HUABU_DATA_DIR: dataDir,
  HUABU_STRUCTURED_BACKEND: 'disk',
  HUABU_BLOB_BACKEND: 'disk',
  HUABU_BIND_HOST: '127.0.0.1',
  HOME: dataDir,
  XDG_CONFIG_HOME: join(dataDir, 'config'),
  XDG_CACHE_HOME: join(dataDir, 'cache'),
  SERVER_PORT: serverPort,
  WEB_PORT: webPort,
  VITE_API_BASE: '',
  VITE_API_PROXY_TARGET: `http://127.0.0.1:${serverPort}`,
  WEB_DIST_PATH: '',
});

// Multi-argument defineConfig concatenates webServer arrays; replace the base
// services so only this sanitized, isolated pair can start.
export default defineConfig({
  ...base,
  testMatch: 'portal-retirement.spec.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  metadata: {
    repoRoot,
    workspace,
    dataDir,
    serverPort,
    webPort,
    realAgentRun: false,
  },
  outputDir: './test-results/portal-retirement',
  reporter: [
    ['list'],
    [
      'html',
      { outputFolder: 'playwright-report/portal-retirement', open: 'never' },
    ],
    [
      'json',
      { outputFile: 'playwright-report/portal-retirement/results.json' },
    ],
  ],
  use: {
    ...base.use,
    baseURL,
    trace: 'on',
    screenshot: 'on',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @huabu/server dev',
      cwd: repoRoot,
      url: `http://127.0.0.1:${serverPort}/api/workspace`,
      reuseExistingServer: false,
      timeout: 120_000,
      env,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    },
    {
      command: 'pnpm exec vite --host 127.0.0.1',
      cwd: webRoot,
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      env,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    },
  ],
});
