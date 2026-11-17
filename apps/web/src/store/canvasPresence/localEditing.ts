// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCanvasPresenceStore } from './canvasPresenceStore';

/** Controls a person types into. */
export const EDITABLE =
  'textarea, input, select, [contenteditable]:not([contenteditable="false"])';

/** Where a node is edited: in place on the canvas, or in its preview. */
const NODE_SCOPE = '.react-flow__node[data-id], [data-search-node-id]';

/**
 * Whether the person is typing into something of the open Space right now,
 * so that replacing the Space under them (a sync-triggered reload) would
 * lose text that exists only in the control or in component state: a text
 * node's draft before blur, a title being renamed, a property field, an edge
 * label.
 *
 * - A control of a node — body, title or property, on the canvas or in the
 *   preview — counts while the editing tracker reports the node
 *   (`localEditingNodeId`): it follows focus and ends after the tracker's
 *   idle time, so a caret left in a note does not hold a reload for ever.
 * - Any other text control inside the canvas (an edge label) counts while it
 *   has focus on a focused page.
 */
export function pageIsEditing(): boolean {
  if (useCanvasPresenceStore.getState().localEditingNodeId !== null)
    return true;
  if (typeof document === 'undefined' || !document.hasFocus()) return false;
  const active = document.activeElement;
  const control = active?.closest(EDITABLE);
  if (!active || !control) return false;
  if (
    (control instanceof HTMLInputElement ||
      control instanceof HTMLTextAreaElement) &&
    control.readOnly
  )
    return false;
  // A node's control the tracker has released (idle) does not hold.
  if (active.closest(NODE_SCOPE)) return false;
  return active.closest('[data-canvas-root]') !== null;
}
