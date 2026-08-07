// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * L1-owned assembly of the agent reachback environment.
 *
 * When Huabu spawns an external agent it injects a small set of
 * `HUABU_*` environment variables so the agent can reach back into the
 * host over the canvas-scoped Remote File System (RFS) and attribute its
 * change-review activity to the right conversation:
 *
 *   - `HUABU_RFS_URL`   — `http://127.0.0.1:<hostPort>/api/rfs/<canvasId>`,
 *                          the canvas-scoped RFS base (capabilities / query /
 *                          download / upload / execute / agent / skill). Bakes the canvasId into the path
 *                          so the agent needs no separate canvas variable.
 *   - `HUABU_THREAD_ID` — the ACP thread this agent serves, so reachback
 *                          `/execute` calls land on this conversation's
 *                          change-review card.
 *
 * This is a **pure L1 concern**: RFS is canvas-coupled and the `HUABU_*`
 * naming + `/api/rfs/` route are Huabu conventions. The assembled env
 * is handed to the L2 driver as opaque data (via the `WorkloadSpec` /
 * `ensureAcpSession` options); the driver passes it straight through to
 * the agentlet spawn call without reading the host port or interpreting
 * any entry.
 */

import { getHostServerPort } from '../../../host-port.js';

/**
 * Build the reachback env for an agent serving `threadId` in `canvasId`.
 * `HUABU_RFS_URL` is only included when a canvasId is present and the host
 * server has bound a port; `HUABU_THREAD_ID` is always set.
 */
export function buildReachbackEnv(
  threadId: string,
  canvasId?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (canvasId) {
    const port = getHostServerPort();
    if (port > 0) {
      env.HUABU_RFS_URL = `http://127.0.0.1:${port}/api/rfs/${canvasId}`;
    }
  }
  env.HUABU_THREAD_ID = threadId;
  return env;
}
