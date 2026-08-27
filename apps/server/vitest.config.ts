// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the server.
 *
 * Tests are co-located alongside the code they cover (`*.test.ts` next
 * to the module under test). Runs in the default Node environment;
 * there is no jsdom / happy-dom layer because the server has no DOM.
 *
 * `globals: true` enables `describe` / `it` / `expect` without an
 * import in each file — matches the apps/web setup.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'evals/**/*.test.ts'],
    // Many suites drive real filesystem work through temp workspaces, which
    // overruns the 5s default once the whole repo runs in parallel.
    testTimeout: 20_000,
  },
});
