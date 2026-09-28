// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Bring up the backend for the storage-profile acceptance run.
 *
 * Playwright starts the web dev server itself — that one never needs
 * restarting — while the backend is spawned here so the spec can stop and
 * start it. See `storage-profile-server.ts` for why that split exists.
 */

import { mkdirSync } from 'node:fs';

import { startBackend, stageLlmCredentials } from './storage-profile-server';

export default async function globalSetup(): Promise<void> {
  const dataDir = process.env.E2E_DATA_DIR;
  const port = process.env.E2E_SERVER_PORT;
  if (!dataDir || !port)
    throw new Error('The storage-profile config sets E2E_DATA_DIR and port');
  mkdirSync(dataDir, { recursive: true });
  // Recorded for the spec, which skips the model half when it is false rather
  // than failing a machine that simply has no provider configured.
  process.env.E2E_LLM_READY = String(stageLlmCredentials(dataDir));
  await startBackend(port, JSON.parse(process.env.E2E_BACKEND_ENV ?? '{}'));
}
