// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { defineConfig } from '@playwright/test';

import isolated from './playwright.unified-links.config';

export default defineConfig({
  ...isolated,
  testMatch: 'overlay-panels.spec.ts',
  outputDir: './test-results/overlay-panels',
  reporter: [['list']],
});
