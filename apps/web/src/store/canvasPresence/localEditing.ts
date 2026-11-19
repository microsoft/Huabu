// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCanvasPresenceStore } from './canvasPresenceStore';

/** Controls a person types into. */
const EDITABLE =
  'textarea, input, select, [contenteditable]:not([contenteditable="false"])';

/** Where a node is edited: in place on the canvas, or in its preview. */
const NODE_SCOPE = '.react-flow__node[data-id], [data-search-node-id]';

/**
 * Marks a control that sits inside a node's scope and does not edit the node
 * (the find field of a preview): `data-not-node-content` on it or on an
 * ancestor.
 */
const NOT_NODE_CONTENT = '[data-not-node-content]';

/**
 * The control `active` is in, when what is typed there can change saved
 * content; `null` otherwise. This is the one place that decides what
 * "editing" means: the edit lock a page reports, the page's own exemption
 * from other pages' locks, and the gates that keep a reload or a remote
 * deletion away from a control in use all follow from it.
 *
 * Focus alone is not editing. A surface that only shows text keeps its caret
 * and is not counted: a read-only field (`readOnly`), and a read-only editor
 * that stays focusable for selection and copying (`aria-readonly`, which is
 * how a CodeMirror view with `EditorState.readOnly` presents itself).
 */
function writableControl(active: Element | null): Element | null {
  const control = active?.closest(EDITABLE) ?? null;
  if (!control || control.closest(NOT_NODE_CONTENT)) return null;
  if (
    (control instanceof HTMLInputElement ||
      control instanceof HTMLTextAreaElement) &&
    control.readOnly
  )
    return null;
  if (control.getAttribute('aria-readonly') === 'true') return null;
  return control;
}

/**
 * The node `active` is editing: a node edited in place on the canvas, or the
 * one open in the preview panel beside it.
 */
export function editingNodeId(
  canvas: HTMLElement,
  active: Element | null,
): string | null {
  if (!active || !writableControl(active)) return null;
  if (canvas.contains(active))
    return (
      active.closest<HTMLElement>('.react-flow__node[data-id]')?.dataset.id ??
      null
    );
  return (
    active.closest<HTMLElement>('[data-search-node-id]')?.dataset
      .searchNodeId ?? null
  );
}

/**
 * Whether the person is typing into something of the open Space right now,
 * so that replacing the Space under them (a sync-triggered reload) would
 * lose text that exists only in the control or in component state: a title
 * being renamed, a property field, an edge label.
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
  if (!active || !writableControl(active)) return false;
  // A node's control the tracker has released (idle) does not hold.
  if (active.closest(NODE_SCOPE)) return false;
  return active.closest('[data-canvas-root]') !== null;
}
