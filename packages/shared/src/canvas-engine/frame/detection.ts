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
import {
  createAbsolutePositionGetter,
  indexById,
  type NestableNode,
} from './tree.js';

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
