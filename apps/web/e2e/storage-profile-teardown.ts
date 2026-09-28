// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Stop the backend this run spawned and delete everything it was pointed at.
 *
 * The throwaway data dir holds the staged LLM credentials for the duration of
 * the run, so removing it is part of the run, not a tidiness nicety. Durable
 * state the profile wrote elsewhere — a Postgres schema, an Azure prefix — is
 * the operator's to clean; the acceptance note says which names a run uses.
 */

import { rmSync } from 'node:fs';

import { clearBackendState, stopBackend } from './storage-profile-server';

export default async function globalTeardown(): Promise<void> {
  try {
    await stopBackend();
  } finally {
    clearBackendState();
    for (const dir of [
      process.env.E2E_WORKSPACE_DIR,
      process.env.E2E_DATA_DIR,
    ]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }
}
