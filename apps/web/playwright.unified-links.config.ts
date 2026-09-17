// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { defineConfig } from '@playwright/test';

import isolated from './playwright.portal-retirement.config';

// Reuse the sanitized environment, temporary Disk workspace, and teardown.
const serverPort = process.env.E2E_SERVER_PORT ?? '3257';
const webPort = process.env.E2E_WEB_PORT ?? '5357';
const baseURL = `http://127.0.0.1:${webPort}`;
const servers = isolated.webServer;
if (!Array.isArray(servers)) throw new Error('Expected isolated server pair');

export default defineConfig({
  ...isolated,
  testMatch: ['unified-links.spec.ts', 'preview-link-mutations.spec.ts'],
  metadata: { ...isolated.metadata, serverPort, webPort },
  outputDir: './test-results/unified-links',
  reporter: [
    ['list'],
    ['json', { outputFile: 'playwright-report/unified-links/results.json' }],
  ],
  use: { ...isolated.use, baseURL },
  webServer: servers.map((server, index) => ({
    ...server,
    url: index === 0 ? `http://127.0.0.1:${serverPort}/api/workspace` : baseURL,
    env: {
      ...server.env,
      SERVER_PORT: serverPort,
      WEB_PORT: webPort,
      VITE_API_PROXY_TARGET: `http://127.0.0.1:${serverPort}`,
    },
  })),
});
