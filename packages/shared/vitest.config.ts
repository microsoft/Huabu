// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the shared package.
 *
 * These specs were previously unreachable: the package had no `test`
 * script, and the `apps/web` / `apps/server` configs only collect from
 * their own roots, so nothing ran them. Run them with
 * `pnpm run test:shared` from the repo root. Deliberately not wired
 * into CI — the quality gate stays lint / format / typecheck only.
 *
 * `include` is pinned to `src/` on purpose. `pnpm build` emits compiled
 * copies of these same specs into `dist/`, and the default include
 * pattern picks those up too — asserting against whenever the package
 * was last built rather than against the working tree.
 *
 * The default `node` environment is enough: nothing under `src/` needs
 * a DOM. The happy-dom environment and canvas shims in
 * `apps/web/vitest.setup.ts` exist for the web app's own tests.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
