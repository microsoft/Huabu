// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { toast } from '@/components/Common/Toast';
import { i18n } from '@/i18n';

import {
  useCanvasPresenceStore,
  type RemotePresencePage,
} from './canvasPresenceStore';

/**
 * One editor at a time.
 *
 * While another page reports a node in its `editingNodeIds`, this page does
 * not let the person start editing that node's body or title. The lock is
 * advisory and lives only in presence: it is gone as soon as the other page
 * stops reporting the node (its editor lost focus or closed), leaves, expires
 * or this page's stream drops. Nothing is stored and the server enforces
 * nothing; a body save from a page that edited anyway is still checked by
 * the content revision (`NODE_CONTENT_CONFLICT`). Custom properties have no
 * revision: two pages that edit the same property anyway are
 * last-writer-wins.
 *
 * A page that is itself editing the node is never locked: when two pages
 * start at the same moment both keep their editor, and the revision check
 * decides. Moving, resizing and styling the node are not affected.
 */

type LockState = Pick<
  ReturnType<typeof useCanvasPresenceStore.getState>,
  'pages' | 'localEditingNodeId'
>;

/** The page that holds the edit lock on `nodeId` against this page, if any. */
export function selectEditLockHolder(
  state: LockState,
  nodeId: string | null | undefined,
): RemotePresencePage | null {
  if (!nodeId || state.localEditingNodeId === nodeId) return null;
  let holder: RemotePresencePage | null = null;
  for (const page of Object.values(state.pages)) {
    if (!page.editingNodeIds.includes(nodeId)) continue;
    // Stable choice when several pages report the node.
    if (!holder || page.pageId < holder.pageId) holder = page;
  }
  return holder;
}

/** The page whose editing keeps this page from editing `nodeId`, or `null`. */
export function editLockHolder(
  nodeId: string | null | undefined,
): RemotePresencePage | null {
  return selectEditLockHolder(useCanvasPresenceStore.getState(), nodeId);
}

let hintToastId: string | null = null;
let hintShownAt = 0;

/** Tell the person why the node did not enter editing. */
export function showEditLockedHint(holder: RemotePresencePage): void {
  // A double-click or a burst of key presses is one attempt.
  const now = Date.now();
  if (hintToastId && now - hintShownAt < 1_500) return;
  hintShownAt = now;
  const label =
    holder.displayName?.trim() ||
    holder.label.trim() ||
    i18n.t('canvasPresence.anotherDevice');
  hintToastId = toast(i18n.t('canvasPresence.editLocked', { label }), {
    tone: 'info',
  });
}

/**
 * Whether this page may start editing `nodeId` now. When another page holds
 * the lock the hint is shown and the answer is `false`.
 */
export function canStartEditing(nodeId: string | null | undefined): boolean {
  const holder = editLockHolder(nodeId);
  if (!holder) return true;
  showEditLockedHint(holder);
  return false;
}

/** Subscribes a component to the lock on `nodeId`. */
export function useEditLockHolder(
  nodeId: string | null | undefined,
): RemotePresencePage | null {
  return useCanvasPresenceStore((state) => selectEditLockHolder(state, nodeId));
}
