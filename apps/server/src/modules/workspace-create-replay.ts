// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Retry-safe Workspace creation for `POST /api/workspaces`.
 *
 * A client that loses the answer to a create cannot tell whether the
 * Workspace was made, and names may repeat, so it cannot tell by looking
 * either. It sends a `requestId` with the create instead, and sends the same
 * one when it retries. A repeat of a create that succeeded returns that
 * Workspace rather than making another; a repeat of one still in flight
 * waits for it; a repeat of one that failed, or whose Workspace has since
 * been removed, creates afresh.
 *
 * Requests are told apart per caller, `requestId` and name, so one person's
 * id never answers another's. They are remembered in this process for
 * {@link REPLAY_WINDOW_MS} after they start: a retry after a Server restart,
 * or past the window, creates afresh. (The Server already assumes a single
 * process for Workspace activation.)
 */

import { getWorkspaceRepository } from './storage/index.js';

import type { WorkspaceHandle } from './storage/index.js';

/** How long a create can be replayed after it starts, in milliseconds. */
export const REPLAY_WINDOW_MS = 15 * 60_000;

interface RememberedCreate {
  /** The create's outcome; rejects when it failed. */
  readonly workspace: Promise<WorkspaceHandle>;
  /** Epoch milliseconds after which a repeat creates afresh. */
  readonly expiresAt: number;
}

const creates = new Map<string, RememberedCreate>();

/**
 * Run `create` once per caller, `requestId` and name.
 *
 * - `caller`: the caller's principal id (any stable string for a local
 *   caller), so ids are never shared between people.
 * - `requestId`: the client's id for this create; without one, `create`
 *   always runs.
 *
 * Resolves with the Workspace and whether this call made it (`false` for a
 * replay, which the route answers with 200 rather than 201).
 */
export async function createOnce(
  caller: string,
  requestId: string | undefined,
  name: string,
  create: () => Promise<WorkspaceHandle>,
): Promise<{ workspace: WorkspaceHandle; created: boolean }> {
  if (!requestId) return { workspace: await create(), created: true };
  const now = Date.now();
  for (const [key, remembered] of creates)
    if (remembered.expiresAt <= now) creates.delete(key);
  const key = JSON.stringify([caller, requestId, name]);
  for (;;) {
    const earlier = creates.get(key);
    if (!earlier) break;
    const made = await earlier.workspace.catch(() => null);
    const current = made
      ? await getWorkspaceRepository().get(made.workspaceId)
      : null;
    if (current) return { workspace: current, created: false };
    // Failed (it removes itself) or since removed: make it afresh, unless a
    // concurrent repeat already took that over.
    if (creates.get(key) === earlier) {
      creates.delete(key);
      break;
    }
  }
  const workspace = create();
  const remembered = { workspace, expiresAt: now + REPLAY_WINDOW_MS };
  creates.set(key, remembered);
  try {
    return { workspace: await workspace, created: true };
  } catch (error) {
    if (creates.get(key) === remembered) creates.delete(key);
    throw error;
  }
}
