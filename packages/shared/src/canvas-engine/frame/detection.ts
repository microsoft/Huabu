// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Frame Detection - Pure, side-effect-free predicates
 *
 * These functions answer "what would happen if…" questions used by the
 * drag-preview system and the parent-frame auto-detect on node creation.
 * They never mutate input arrays.
 */

import {
  checkShouldUnframe,
  createRectGetter,
  findBestFrameForNode,
  type AutoFrameByOverlapOptions,
  type AutoUnframeByNonOverlapOptions,
} from './geometry.js';
import { readFrameGridConfig } from '../autoLayout/gridLayout.js';
import {
  createAbsolutePositionGetter,
  indexById,
  type NestableNode,
} from '../container/tree.js';

/**
 * Pure predicate: would the given node be unframed under the current
 * `autoUnframeNodeByNonOverlap` rules? Returns `true` when the node has
 * no overlap with its parent frame AND the edge-to-edge gap exceeds
 * `margin`, except when a `pointer` + `pointerCaptureMargin` capture
 * zone is provided and the pointer falls inside it (sticky parent).
 *
 * Used by the drag-preview system to decide whether to exclude a node
 * from the fit preview of its current parent frame.
 */
export function wouldUnframe(
  nodes: NestableNode[],
  nodeId: string,
  options: AutoUnframeByNonOverlapOptions = {},
): boolean {
  const byId = indexById(nodes);
  const node = byId.get(nodeId);
  if (!node?.parentId) return false;

  const parentId = node.parentId;
  const parent = byId.get(parentId);
  if (!parent) return false;

  const getAbs = createAbsolutePositionGetter(byId);
  const getRect = createRectGetter(byId, getAbs);

  const nodeRect = getRect(nodeId);
  const parentRect = getRect(parentId);
  if (!nodeRect || !parentRect) return false;

  return checkShouldUnframe(nodeRect, parentRect, options);
}

/**
 * Pure predicate: does `nodeId` stay parented to its **structured**
 * frame because the pointer is still inside that frame's capture zone?
 *
 * The zone is the frame rect expanded by the dragged node's own size on
 * each side. Appending or prepending a track means aiming at the frame's
 * outer padding, which usually drags the node's body — and with it the
 * cursor — slightly past the frame edge and leaves zero body overlap. A
 * plain {@link wouldUnframe} test would call that a departure and drop
 * the node outside the frame, contradicting the "insert column / row"
 * indicator the user is looking at.
 *
 * Every stage of the gesture has to ask this before it asks
 * {@link wouldUnframe} — the live drag tick that records the decision
 * and the drop resolver that commits it — or the preview and the commit
 * disagree exactly in the band where new tracks are opened.
 */
export function wouldStickToStructuredFrame(
  nodes: NestableNode[],
  nodeId: string,
  pointer: { x: number; y: number } | undefined,
): boolean {
  if (!pointer) return false;

  const byId = indexById(nodes);
  const node = byId.get(nodeId);
  const parentId = node?.parentId;
  if (!parentId) return false;

  const parent = byId.get(parentId);
  if (!parent || !readFrameGridConfig(parent)) return false;

  const getAbs = createAbsolutePositionGetter(byId);
  const getRect = createRectGetter(byId, getAbs);

  const parentRect = getRect(parentId);
  if (!parentRect) return false;
  // An unmeasured node contributes no margin rather than disqualifying
  // the test: the bare frame rect is still a valid capture zone.
  const nodeRect = getRect(nodeId);
  const marginX = nodeRect?.width ?? 0;
  const marginY = nodeRect?.height ?? 0;

  return (
    pointer.x >= parentRect.x - marginX &&
    pointer.x <= parentRect.x + parentRect.width + marginX &&
    pointer.y >= parentRect.y - marginY &&
    pointer.y <= parentRect.y + parentRect.height + marginY
  );
}

/**
 * Pure predicate: returns the frame ID that the node would auto-enter under the
 * current `autoFrameNodeByOverlap` rules, or `null` if no frame qualifies.
 *
 * Used by the drag-preview system to decide whether to show an entering-frame
 * preview for root-level nodes that have no current parent.
 */
export function wouldAutoFrame(
  nodes: NestableNode[],
  nodeId: string,
  options: AutoFrameByOverlapOptions = {},
): string | null {
  const threshold = options.threshold ?? 0.5;
  if (!Number.isFinite(threshold) || threshold <= 0) return null;

  const byId = indexById(nodes);
  const node = byId.get(nodeId);
  if (!node) return null;

  const getAbs = createAbsolutePositionGetter(byId);
  const getRect = createRectGetter(byId, getAbs);

  return findBestFrameForNode(
    nodes,
    nodeId,
    threshold,
    getRect,
    options.pointer,
    options.allowNestedFrameEntry,
  );
}

/**
 * Finds the smallest unlocked frame that contains the given point.
 * Returns the frame's ID, or null if the point is not inside any frame.
 *
 * Used during node creation to auto-detect parent frames based on
 * the creation position (e.g. click, drop, paste).
 */
export function findFrameAtPoint(
  nodes: NestableNode[],
  point: { x: number; y: number },
): string | null {
  const byId = indexById(nodes);
  const getAbs = createAbsolutePositionGetter(byId);
  const getRect = createRectGetter(byId, getAbs);

  let best: { frameId: string; area: number } | undefined;

  for (const node of nodes) {
    if (node.type !== 'frame') continue;
    if (node.data?.locked) continue;

    const rect = getRect(node.id);
    if (!rect) continue;

    if (
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height
    ) {
      const area = rect.width * rect.height;
      // Prefer the smallest frame (most specific container)
      if (!best || area < best.area) {
        best = { frameId: node.id, area };
      }
    }
  }

  return best?.frameId ?? null;
}
