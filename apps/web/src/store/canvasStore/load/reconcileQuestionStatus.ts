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
 * Older question nodes can own a persisted conversation while lacking a
 * persisted lifecycle status. Conversation existence proves only that a turn
 * ran; it does not prove that the turn succeeded. The Tier-2 transcript may
 * end in an error.
 *
 * ## Invariant enforced here
 *
 * Preserve explicit terminal states verbatim and never manufacture `done`
 * from `threadId` plus content. Current lifecycle writers persist terminal
 * status through the canonical Canvas executor; legacy unknown states remain
 * neutral until conversation history supplies their actual outcome.
 */

import type { Node } from '@xyflow/react';

/**
 * Reconcile a single node. Returns the original reference when no change
 * is needed (so the caller can rely on identity diffing), or a shallow
 * copy with a repaired `data.status` otherwise.
 */
function reconcileOne(node: Node): Node {
  if (node.type !== 'question') return node;

  const data = node.data as Record<string, unknown> | undefined;
  if (!data) return node;

  if (!('runAt' in data)) return node;

  // Legacy auto-run timestamps must not re-fire, but their presence says
  // nothing about the terminal outcome.
  const nextData: Record<string, unknown> = { ...data };
  delete nextData.runAt;
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
