// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Load-time reconciliation for question-node execution status.
 *
 * Pure functions only — no timers, no I/O, no store dependency. Imported
 * by `canvasStore.loadCanvas` and applied to the freshly-fetched node
 * list before it is committed to the store.
 *
 * ## Why this exists
 *
 * A question node's `status` (`idle | pending | running | done | error`)
 * is persisted as structural state via the structure PUT, which uses
 * optimistic concurrency control keyed on `canvas.version`. When the
 * agent edits the canvas *during* a question's conversation (emitting
 * `space_commands`), the server `version` advances; if the client's
 * local version then drifts, the follow-up `status: 'done'` autosave PUT
 * 409s and is silently dropped (see the guard in `saveCanvas` /
 * `useQuestionRunner`). The node is left persisted in a stale
 * non-terminal state — most commonly `idle` — even though it ran and
 * owns a fully-persisted chat thread.
 *
 * On reload the canvas badge reads that stale status and shows nothing
 * (`status === 'idle'` hides the badge), so the user loses both
 * the visual "this ran" signal and the double-click affordance that
 * reopens the conversation.
 *
 * ## Invariant enforced here
 *
 * A question node that owns a `threadId` AND has authored `content` has
 * been dispatched to an agent at least once and therefore has a
 * conversation to show. After a fresh load there is never an in-flight
 * run (run controllers live only in memory), so any non-terminal status
 * on such a node is stale. We demote it to `done` — the conversation
 * exists, the badge reappears, and `canOpenInChat` (threadId + done)
 * lets the user reopen the thread. The repaired status persists on the
 * next structural save.
 *
 * Nodes without a `threadId`, or with a `threadId` but empty `content`
 * (a thread minted for composition that never received a message), are
 * left untouched so a never-asked node stays `idle`.
 */

import type { Node } from '@xyflow/react';

/** Statuses that are valid to keep verbatim on a question node after load. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'error']);

/**
 * Reconcile a single node. Returns the original reference when no change
 * is needed (so the caller can rely on identity diffing), or a shallow
 * copy with a repaired `data.status` otherwise.
 */
function reconcileOne(node: Node): Node {
  if (node.type !== 'question') return node;

  const data = node.data as Record<string, unknown> | undefined;
  if (!data) return node;

  const threadId = data.threadId;
  // No thread yet → nothing has ever been dispatched. Leave it alone.
  if (typeof threadId !== 'string' || threadId.length === 0) return node;

  // A question node mints its `threadId` the moment it is opened for
  // composition — BEFORE any message is sent. So a thread id alone no
  // longer proves a conversation exists. The authored `content` does:
  // it is written on the first send. An empty-content node has never
  // been asked (the user dropped it / opened compose but didn't send),
  // so its `idle` state is correct and must not be promoted to `done`.
  const content = data.content;
  if (typeof content !== 'string' || content.trim().length === 0) return node;

  const status = data.status;
  // Already terminal → trust it.
  if (typeof status === 'string' && TERMINAL_STATUSES.has(status)) return node;

  // Stale non-terminal status (idle / running) on a node that already
  // owns a conversation → repair to `done` and drop any legacy auto-run
  // timestamp so nothing tries to re-fire it.
  const nextData: Record<string, unknown> = { ...data, status: 'done' };
  if ('runAt' in nextData) delete nextData.runAt;

  return { ...node, data: nextData };
}

/**
 * Reconcile stale question-node statuses across a loaded node list.
 *
 * Pure: returns the same array reference when nothing changed; otherwise
 * a new array in which only the repaired question nodes are fresh
 * objects.
 */
export function reconcileQuestionStatus(nodes: readonly Node[]): Node[] {
  let changed = false;
  const next = nodes.map((node) => {
    const reconciled = reconcileOne(node);
    if (reconciled !== node) changed = true;
    return reconciled;
  });
  return changed ? next : (nodes as Node[]);
}
