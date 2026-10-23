// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { fileURLToPath } from 'node:url';

import { resolveServerDataDir } from '@huabu/client-runtime';

/**
 * Resolve the absolute path of the data directory.
 *
 * Two runtime layouts:
 *   ─ Source (tsx): no HUABU_DATA_DIR env var, so fall back to
 *     `apps/server/data/`, independent of the caller's working directory.
 *     Relative overrides are also resolved from the repository root.
 *   ─ Bundled (Electron): the desktop main process injects
 *     `HUABU_DATA_DIR` pointing into the user's Electron `userData`
 *     directory, which is writable post-install.
 */
export function getDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveServerDataDir(
    fileURLToPath(new URL('../../../', import.meta.url)),
    env.HUABU_DATA_DIR,
  );
}
