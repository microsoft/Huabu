// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isVideoControlTarget } from '@/components/Nodes/video/videoInteraction';
import {
  isControlOrEditableTarget,
  isKeyboardInteractiveTarget,
} from '@/hooks/shortcuts/isKeyboardInteractiveTarget';

import type {
  CanvasTool,
  EffectiveInputMode,
  PendingNodeType,
} from '@/store/toolStore';

export type { CanvasTool } from '@/store/toolStore';

export function resolveEffectiveCanvasTool(
  state: {
    pendingNodeType: PendingNodeType;
    mouseToolPreference: CanvasTool;
    explicitLassoActive: boolean;
  },
  isNotMouse: boolean,
  temporaryPan = false,
): CanvasTool {
  if (state.pendingNodeType) return 'select';
  if (temporaryPan && !isNotMouse) return 'pan';
  if (state.explicitLassoActive) return 'lasso';
  return isNotMouse ? 'select' : state.mouseToolPreference;
}

// React Flow DOM class selectors used for pointer-target ownership checks.
// Centralised here so every gesture path agrees on what a panel, node, or
// empty pane target is, instead of duplicating `closest()` string matches.
const REACT_FLOW_PANE = '.react-flow__pane';
const REACT_FLOW_PANEL = '.react-flow__panel';
const REACT_FLOW_NODE = '.react-flow__node';
const REACT_FLOW_NODE_FRAME = '.react-flow__node-frame';
const REACT_FLOW_NODE_SKETCH = '.react-flow__node-sketch';
const REACT_FLOW_NODE_CONTROL =
  '.react-flow__handle, .react-flow__resize-control';
const REACT_FLOW_INTERACTIVE =
  '.react-flow__panel, .react-flow__node, .react-flow__edge, .react-flow__handle';

/** Panels and explicitly active video controls own native pointer interaction. */
export function isPanelTarget(target: Element | null): boolean {
  return (
    Boolean(
      target?.closest(
        `${REACT_FLOW_PANEL}, [data-multi-resize-control], [data-ink-sigil-label], [data-ink-sigil-hit-target]`,
      ),
    ) || isVideoControlTarget(target)
  );
}

/** Closest canvas node element for the pointer target, or `null`. */
export function closestNodeElement(target: Element | null): HTMLElement | null {
  return target?.closest<HTMLElement>(REACT_FLOW_NODE) ?? null;
}

/** True when the pointer target lives inside a canvas node. */
export function isNodeTarget(target: Element | null): boolean {
  return closestNodeElement(target) !== null;
}

/** True when the pointer target lives on the painted surface of a Sketch. */
export function isSketchNodeTarget(target: Element | null): boolean {
  return Boolean(target?.closest(REACT_FLOW_NODE_SKETCH));
}

/** True when the pointer target is a React Flow node manipulation control. */
export function isNodeControlTarget(target: Element | null): boolean {
  return Boolean(target?.closest(REACT_FLOW_NODE_CONTROL));
}

/** Whether a retained Lasso move may claim this pointer target. */
export function canStartRetainedSelectionMove(target: Element | null): boolean {
  return (
    !isPanelTarget(target) &&
    !isNodeControlTarget(target) &&
    !isKeyboardInteractiveTarget(target)
  );
}

/** Binding may consume a resource link, but never a native control or editor. */
export function canStartInkSigilBinding(target: Element | null): boolean {
  return (
    !isPanelTarget(target) &&
    !isNodeControlTarget(target) &&
    !isControlOrEditableTarget(target)
  );
}

/**
 * True when the pointer target is empty canvas: inside the React Flow pane
 * but not over a panel, node, edge, or handle.
 */
export function isEmptyPaneTarget(target: Element | null): boolean {
  return Boolean(
    target?.closest(REACT_FLOW_PANE) && !target.closest(REACT_FLOW_INTERACTIVE),
  );
}

/**
 * True when the pointer target is a frame's own background — i.e. the
 * topmost node under the pointer is a frame (not one of its children).
 */
export function isFrameBackgroundTarget(target: Element | null): boolean {
  const node = target?.closest(REACT_FLOW_NODE);
  return Boolean(node && node.matches(REACT_FLOW_NODE_FRAME));
}

/**
 * Nodes are drawing surfaces under Lasso, but their controls keep native input.
 * Placement deliberately retains the narrower empty-pane policy.
 */
export function isLassoStartTarget(target: Element | null): boolean {
  return (
    canStartRetainedSelectionMove(target) &&
    !target?.closest('.react-flow__edge') &&
    (isEmptyPaneTarget(target) || isNodeTarget(target))
  );
}

// Toolbar layout, tool availability, and node-drag affordances follow the
// pointer the user is *currently* using (`isNotMouse`), not the persisted
// input-mode preference. This keeps hybrid devices (e.g. Surface) desktop-like
// while a mouse is in hand and touch-friendly the moment a finger or pen takes
// over. The `inputMode` preference below only gates which non-mouse pointers
// may reach the canvas and disambiguates pen vs finger.
//
// Touch keeps Select as the safe internal home base (tap-select + drag via
// React Flow, no accidental ink), while only Lasso is exposed in the toolbar.
// Pan collapses into the same direct-manipulation state; Sketch is an explicit
// sticky tool listed among the creation nodes.
export function getAvailableCanvasTools(isNotMouse: boolean): CanvasTool[] {
  return isNotMouse ? ['lasso'] : ['select', 'pan', 'lasso'];
}

export function resolveCanvasToolShortcut(
  tool: CanvasTool,
  isNotMouse: boolean,
): CanvasTool {
  return isNotMouse && tool !== 'lasso' ? 'select' : tool;
}

export function resolveNodeDraggable(
  draggable: boolean | undefined,
  selected: boolean | undefined,
  isNotMouse: boolean,
  ignoreTouchDrag = false,
): boolean | undefined {
  if (ignoreTouchDrag) return false;
  return isNotMouse && selected !== true ? false : draggable;
}

export function canPlaceNodeWithPointer(
  pointerType: string,
  inputMode: EffectiveInputMode,
): boolean {
  // Mouse placement flows through the pane click handler, not the pointer tap.
  if (inputMode === 'mouse') return false;
  return inputMode === 'pen' ? pointerType === 'pen' : pointerType === 'touch';
}

export function canManipulateCanvasWithPointer(
  pointerType: string,
  inputMode: EffectiveInputMode,
): boolean {
  // The mouse is a precise, unambiguous pointer and always operates the canvas,
  // regardless of the input-mode preference (except never being *blocked*).
  if (pointerType === 'mouse') return true;
  // Mouse mode deliberately ignores touchscreen and pen input.
  if (inputMode === 'mouse') return false;
  if (inputMode === 'pen') {
    return pointerType === 'pen' || pointerType === 'touch';
  }
  return pointerType === 'touch';
}

export function canDirectlyManipulateWithPointer(
  pointerType: string,
  inputMode: EffectiveInputMode,
): boolean {
  if (pointerType === 'mouse') return true;
  if (inputMode === 'mouse') return false;
  return inputMode === 'pen' ? pointerType === 'pen' : pointerType === 'touch';
}

export function isEmptyCanvasPlacementTarget(target: Element): boolean {
  return isEmptyPaneTarget(target);
}

export function isNodePlacementTap(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  activationDistance: number,
): boolean {
  return Math.hypot(endX - startX, endY - startY) < activationDistance;
}
