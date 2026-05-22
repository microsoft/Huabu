import { defineConfig } from 'vitest/config';

import baseConfig from './vite.config';

/**
 * Vitest configuration for the web app.
 *
 * We extend the Vite config so module resolution / aliasing matches the
 * dev server, then layer test-specific options on top.
 *
 * `setupFiles` runs before each test file. We use it to shim `window`
 * on the global object so that CommonJS modules like
 * `cytoscape-layout-utilities` — which is transitively loaded by the
 * shared canvas-engine through the command registry — can register
 * themselves without crashing in Node-only test runs.
 */
export default defineConfig(async (env) => {
  const resolved =
    typeof baseConfig === 'function' ? await baseConfig(env) : baseConfig;
  return {
    ...resolved,
    test: {
      environment: 'happy-dom',
      setupFiles: ['./vitest.setup.ts'],
    },
  };
});
