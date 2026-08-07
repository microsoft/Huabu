// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { join } from 'node:path';

/**
 * Resolve the absolute path of the data directory.
 *
 * Two runtime layouts:
 *   ─ Source (tsx): no HUABU_DATA_DIR env var, so fall back to
 *     `<cwd>/data/`. `apps/server`'s dev script sets cwd to the
 *     package root, so this resolves to `apps/server/data/`.
 *   ─ Bundled (Electron): the desktop main process injects
 *     `HUABU_DATA_DIR` pointing into the user's Electron `userData`
 *     directory, which is writable post-install.
 */
export function getDataDir(): string {
  return process.env.HUABU_DATA_DIR ?? join(process.cwd(), 'data');
}
