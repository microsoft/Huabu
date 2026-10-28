// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The Workspace one request, or one piece of background work, runs in.
 *
 * Local mode has one person and one process-active Workspace, and never fills
 * a scope: every getter in `../workspace.ts` falls back to the process state,
 * exactly as before. In Bubble mode each request runs in its caller's current
 * Workspace, so two people can work in two Workspaces at once without either
 * one moving the other.
 *
 * The scope travels with the async call chain. Work a request starts and that
 * outlives it (an agent run, a memory update, a Task Run) keeps the Workspace
 * it started in, even after its starter switches away.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { WorkspaceHandle } from '../storage/index.js';

/** One Workspace, as the getters in `../workspace.ts` answer for it. */
export interface WorkspaceScope {
  readonly handle: WorkspaceHandle;
  /** The Disk materialization, or `null` when the Workspace is a row. */
  readonly path: string | null;
}

/**
 * A request's slot, opened before identity is known and filled once.
 *
 * Opening comes first because only a callback-style `onRequest` hook can wrap
 * the rest of Fastify's lifecycle in `run()`; choosing comes later, after
 * admission has found the principal. An open slot that was never filled is a
 * request with no Workspace, not a request in the process's.
 */
interface ScopeSlot {
  scope: WorkspaceScope | null;
}

const storage = new AsyncLocalStorage<ScopeSlot>();

/** Run `fn` with an empty slot that {@link fillWorkspaceScope} may fill. */
export function openWorkspaceScope<T>(fn: () => T): T {
  return storage.run({ scope: null }, fn);
}

/**
 * Choose the Workspace for the request this call runs inside.
 *
 * Refuses a second choice: a request reads one Workspace from start to finish,
 * so a handler can never act in a different one from the one authorized.
 */
export function fillWorkspaceScope(scope: WorkspaceScope): void {
  const slot = storage.getStore();
  if (!slot) throw new Error('No Workspace scope is open for this call');
  if (slot.scope && slot.scope.handle.workspaceId !== scope.handle.workspaceId)
    throw new Error('This request already runs in another Workspace');
  slot.scope = scope;
}

/** Run `fn`, and everything it starts, in one Workspace. */
export function runInWorkspace<T>(scope: WorkspaceScope, fn: () => T): T {
  return storage.run({ scope }, fn);
}

/**
 * The scope this call runs in.
 *
 * `undefined` when no slot is open (local mode, startup, process work), so the
 * caller uses the process-active Workspace. `null` when a slot is open but
 * nothing was chosen, which is a request with no Workspace.
 */
export function currentWorkspaceScope(): WorkspaceScope | null | undefined {
  const slot = storage.getStore();
  return slot ? slot.scope : undefined;
}
