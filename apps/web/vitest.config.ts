// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { defineConfig } from 'vitest/config';
import { configDefaults } from 'vitest/config';

import baseConfig from './vite.config';

/**
 * Vitest configuration for the web app.
 *
 * We extend the Vite config so module resolution / aliasing matches the
 * dev server, then layer test-specific options on top.
 *
 * `setupFiles` runs before each test file. We use it to provide DOM /
 * environment shims required by modules the shared canvas-engine loads
 * through the command registry when running under Node.
 */
export default defineConfig(async (env) => {
  const resolved =
    typeof baseConfig === 'function' ? await baseConfig(env) : baseConfig;
  return {
    ...resolved,
    test: {
      environment: 'happy-dom',
      setupFiles: ['./vitest.setup.ts'],
      // Playwright end-to-end specs under `e2e/` run via `playwright test`,
      // not Vitest; exclude them so Vitest does not try to load
      // `@playwright/test`.
      exclude: [...configDefaults.exclude, 'e2e/**'],
    },
  };
});
