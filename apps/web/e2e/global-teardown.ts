// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { rmSync } from 'node:fs';

/**
 * Remove the throwaway workspace + data dirs the e2e backend was locked to.
 *
 * `playwright.config.ts` assigns unique paths per run and exposes them via
 * `E2E_WORKSPACE_DIR` / `E2E_DATA_DIR`; the backend creates them at boot.
 * Deleting them here keeps repeated
 * `test:e2e` runs from piling up temp Spaces and sqlite state under the OS
 * temp dir. Runs in the same runner process that evaluated the config, so
 * the env vars set there are visible. `force` makes teardown idempotent and
 * safe even if a run crashed before either dir existed.
 */
export default function globalTeardown(): void {
  for (const dir of [process.env.E2E_WORKSPACE_DIR, process.env.E2E_DATA_DIR]) {
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
}
