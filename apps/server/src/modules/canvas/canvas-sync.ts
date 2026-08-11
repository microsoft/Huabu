// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas real-time sync publisher.
 *
 * A minimal in-memory pub/sub keyed by active Workspace plus `canvasId`,
 * mirroring the pattern in `external-watcher.ts`. `publishCanvasUpdate` is
 * called after durable commits; every live SSE subscriber for that exact
 * Workspace/Space receives the event and replays the consequences locally.
 *
 * ALL canvas writes broadcast — the out-of-band HTTP `/execute` route
 * (ACP / headless) AND the built-in / question-node agents that mutate
 * in-process via `executeOnServer` (C2). The chat SSE tool result no
 * longer applies canvas state, so the initiating tab is a plain receiver
 * that applies its own change once. Phase 4's commit originator and `commitId`
 * let the web client suppress optimistic same-tab echoes and deduplicate the
 * HTTP/SSE race.
 */

import path from 'node:path';

import { getWorkspacePath } from '../workspace.js';

import type { CanvasSyncEvent } from '@huabu/shared';

type Listener = (event: CanvasSyncEvent) => void;

const listenersBySpace = new Map<string, Set<Listener>>();

/**
 * Canvas ids are unique only inside one Workspace. Capture the active root at
 * subscription/publication time so an SSE stream opened in Workspace A can
 * never receive a same-id Canvas event published after activation moved to B.
 */
function spaceKey(workspacePath: string, canvasId: string): string {
  return `${path.resolve(workspacePath)}\0${canvasId}`;
}

/** Broadcast to subscribers of this Space in the currently leased Workspace. */
export function publishCanvasUpdate(
  canvasId: string,
  event: CanvasSyncEvent,
): void {
  const key = spaceKey(getWorkspacePath(), canvasId);
  const set = listenersBySpace.get(key);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch {
      /* ignore listener errors — one bad subscriber must not stall others */
    }
  }
}

/** Subscribe in the active Workspace. Returns a Workspace-bound unsubscribe. */
export function subscribeCanvasUpdates(
  canvasId: string,
  listener: Listener,
): () => void {
  const key = spaceKey(getWorkspacePath(), canvasId);
  let set = listenersBySpace.get(key);
  if (!set) {
    set = new Set();
    listenersBySpace.set(key, set);
  }
  set.add(listener);
  return () => {
    // Remove from the Workspace captured above, even if activation changed
    // before the connection closed.
    const s = listenersBySpace.get(key);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) listenersBySpace.delete(key);
  };
}
