// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomBytes } from 'node:crypto';

/**
 * The global connection token used to authenticate the embedded
 * agentlet transport (L2 `@agenetes/agentlet-host`) and every agent
 * reachback that reuses it (e.g. the `/api/rfs/*` bearer gate).
 *
 * This is L1-owned config injected downward via `mountAgenetes()`.
 * Unlike the previous per-fork mint, it is stable for the lifetime of
 * the server process, so agent reachback credentials survive an
 * agentlet daemon restart.
 *
 * Two runtime layouts, mirroring {@link ./data-dir.ts}:
 *   ─ `HUABU_CONNECTION_TOKEN` env var — explicit override (e.g. the
 *     Electron main process can pin a value across restarts).
 *   ─ Otherwise a fresh 256-bit hex token is minted once per boot and
 *     cached for the process lifetime.
 */
let cached: string | null = null;

export function getConnectionToken(): string {
  if (cached) return cached;
  const fromEnv = process.env.HUABU_CONNECTION_TOKEN;
  cached =
    fromEnv && fromEnv.length > 0 ? fromEnv : randomBytes(32).toString('hex');
  return cached;
}
