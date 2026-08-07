// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { EffectiveInputMode } from '@/store/toolStore';

export type CanvasTool = 'select' | 'pan' | 'lasso';

// React Flow DOM class selectors used for pointer-target ownership checks.
// Centralised here so every gesture path agrees on what a panel, node, or
// empty pane target is, instead of duplicating `closest()` string matches.
const REACT_FLOW_PANE = '.react-flow__pane';
const REACT_FLOW_PANEL = '.react-flow__panel';
const REACT_FLOW_NODE = '.react-flow__node';
const REACT_FLOW_NODE_FRAME = '.react-flow__node-frame';
const REACT_FLOW_INTERACTIVE =
  '.react-flow__panel, .react-flow__node, .react-flow__edge, .react-flow__handle';

/** True when the pointer target lives inside a floating panel or toolbar. */
export function isPanelTarget(target: Element | null): boolean {
  return Boolean(target?.closest(REACT_FLOW_PANEL));
}

/** Closest canvas node element for the pointer target, or `null`. */
export function closestNodeElement(target: Element | null): HTMLElement | null {
  return target?.closest<HTMLElement>(REACT_FLOW_NODE) ?? null;
}

/** True when the pointer target lives inside a canvas node. */
export function isNodeTarget(target: Element | null): boolean {
  return closestNodeElement(target) !== null;
}

/**
 * True when the pointer target is empty canvas: inside the React Flow pane
 * but not over a panel, node, edge, or handle. Shared by click-to-place
 * creation and lasso start so both agree on what "empty canvas" means.
 */
export function isEmptyPaneTarget(target: Element | null): boolean {
  return Boolean(
    target?.closest(REACT_FLOW_PANE) && !target.closest(REACT_FLOW_INTERACTIVE),
  );
}

/**
 * True when the pointer target is a frame's own background — i.e. the
 * topmost node under the pointer is a frame (not one of its children).
 *
 * A frame is a solid container node, so a pointerdown inside it (or one that
 * drills through a framed sketch's transparent `pointer-events: none` bbox
 * and lands on the frame beneath) targets the frame element rather than the
 * empty pane. Treating the frame background as a valid surface lets the
 * lasso begin inside a frame; on its own this is not enough — React Flow
 * node dragging must also be off in lasso mode (see `nodesDraggable`), or the
 * frame is grabbed and moved before the lasso can claim the gesture.
 */
export function isFrameBackgroundTarget(target: Element | null): boolean {
  const node = target?.closest(REACT_FLOW_NODE);
  return Boolean(node && node.matches(REACT_FLOW_NODE_FRAME));
}

/**
 * Valid surface for STARTING a lasso: empty canvas, or a frame's own
 * background (so a lasso can select the frame's contents). Node interiors
 * (except frames) and panels are excluded.
 */
export function isLassoStartTarget(target: Element | null): boolean {
  return isEmptyPaneTarget(target) || isFrameBackgroundTarget(target);
}

// Toolbar layout, tool availability, and node-drag affordances follow the
// pointer the user is *currently* using (`isNotMouse`), not the persisted
// input-mode preference. This keeps hybrid devices (e.g. Surface) desktop-like
// while a mouse is in hand and touch-friendly the moment a finger or pen takes
// over. The `inputMode` preference below only gates which non-mouse pointers
// may reach the canvas and disambiguates pen vs finger.
//
// Touch keeps Select as the safe default home base (tap-select + drag via
// React Flow, no accidental ink) alongside Lasso. Pan collapses into the
// internal direct-manipulation state and is hidden from the touch toolbar;
// Sketch is an explicit sticky tool listed among the creation nodes.
export function getAvailableCanvasTools(isNotMouse: boolean): CanvasTool[] {
  return isNotMouse ? ['select', 'lasso'] : ['select', 'pan', 'lasso'];
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
): boolean | undefined {
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
