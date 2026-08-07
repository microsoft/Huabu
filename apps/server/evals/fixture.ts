// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Fixture lifecycle for evals.
 *
 * Each case ships a minimal vault under `evals/fixtures/<id>/`. Before
 * a run we copy that tree into a fresh tmp directory and point the
 * server's workspace at it; after the run we rm-rf the tmp dir.
 *
 * Why a tmp directory rather than running directly in the fixture
 * folder:
 *   1. The agent may mutate the canvas (`operate` mode) — fixtures
 *      must stay clean for the next seed / the next reviewer.
 *   2. `setWorkspacePath` runs storage migrations that create files
 *      we do not want to leak into git (`.history/`, dedupe renames).
 */

import { cpSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resetStorageCache } from '../src/modules/storage/index.js';
import { setWorkspacePath } from '../src/modules/workspace.js';

export interface PreparedFixture {
  /** Absolute path to the temp workspace root. */
  workspacePath: string;
  /** Cleans the temp workspace. Idempotent. */
  cleanup: () => void;
}

/**
 * Copy a fixture into a fresh tmp workspace and activate it.
 *
 * @param fixturesDir Absolute path to `evals/fixtures/`.
 * @param fixtureId   Subdirectory name under `fixturesDir`.
 */
export function prepareFixture(
  fixturesDir: string,
  fixtureId: string,
): PreparedFixture {
  const src = path.join(fixturesDir, fixtureId);
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    throw new Error(
      `Fixture not found: ${src}. ` +
        `Create the directory under evals/fixtures/ before running this case.`,
    );
  }

  const workspacePath = mkdtempSync(path.join(tmpdir(), 'sediment-eval-'));
  // `cpSync` recursively copies the fixture tree. `dereference: false`
  // keeps symlinks as symlinks (we have none today, but it's the safer
  // default for cross-platform behaviour).
  cpSync(src, workspacePath, { recursive: true });

  // Activate the new workspace. `setWorkspacePath` triggers the
  // canvas-dir scan + label migration; we drop the in-process cache
  // first so a previous case's `CanvasStore` instances do not leak.
  resetStorageCache();
  setWorkspacePath(workspacePath);

  return {
    workspacePath,
    cleanup: () => {
      try {
        rmSync(workspacePath, { recursive: true, force: true });
      } catch {
        // best-effort; the OS will reclaim tmp eventually
      }
    },
  };
}
