// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { defineConfig } from '@playwright/test';

import isolated from './playwright.portal-retirement.config';

// Reuse the credential-free Disk harness, including temporary-data teardown.
export default defineConfig({
  ...isolated,
  testMatch: 'preprocess-lifecycle.spec.ts',
  outputDir: './test-results/preprocess-lifecycle',
  reporter: [
    ['list'],
    [
      'json',
      { outputFile: 'playwright-report/preprocess-lifecycle/results.json' },
    ],
  ],
});
