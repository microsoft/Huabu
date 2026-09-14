// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { defineConfig } from 'vitest/config';

import base from './vitest.config.js';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/modules/storage/**/*.remote.test.ts'],
    exclude: [],
    globalSetup: ['./src/test-support/storage-containers.ts'],
    maxWorkers: 2,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
