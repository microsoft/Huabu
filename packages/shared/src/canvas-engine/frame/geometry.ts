// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Frame Geometry - Internal rectangle / overlap helpers shared by the
 * detection and mutation submodules.
 *
 * Everything here except the publicly-referenced Options types is private
 * to the frame subsystem and intentionally omitted from the barrel.
 */

import { getDescendantIds, type NestableNode } from '../container/tree.js';
import { getNodeSize } from '../utils/nodeSizes.js';

import type { XYPosition } from '@xyflow/react';

export type AutoFrameByOverlapOptions = {
  /** Portion of the dragged node area that must be inside the frame. */
  threshold?: number;
  /**
   * Allow entry into a nested Frame. Without this explicit override, child
   * Frames are frozen as complete nodes; the dragged node's own ancestors
   * remain eligible as upward exit surfaces.
   */
  allowNestedFrameEntry?: boolean;
  /**
   * Cursor position in absolute flow coordinates. When provided, the pointer
   * surface selects candidates and any positive body overlap qualifies. The
   * area-ratio threshold is used only when pointer information is unavailable.
   */
  pointer?: { x: number; y: number };
};

export type AutoUnframeByNonOverlapOptions = {
  /** Treat intersection area <= epsilon as "no overlap". */
  epsilon?: number;
  /**
   * If the node extends beyond any edge of the parent frame by more than
   * this many pixels, treat it as "dragged out" even if there is still
   * some overlap. Default: 0 (disabled).
   */
  margin?: number;
  /**
   * Cursor position in absolute flow coordinates. When provided together
   * with `pointerCaptureMargin`, the node stays parented while the
   * pointer is still inside the parent frame rect expanded by
   * `pointerCaptureMargin`. Lets users reposition a child inside its
   * frame even when the node's bbox momentarily extends past the frame
   * edge, without the node escaping on each grazing drag.
   */
  pointer?: { x: number; y: number };
  /**
   * Halo (in px) added around the parent frame for the pointer capture
   * test. Either a single number (symmetric on both axes) or an object
   * with separate horizontal / vertical values. Ignored when `pointer`
   * is not provided. Default: 0.
   *
   * Per-axis form lets callers scale the halo with the dragged node's
   * size (e.g. `0.25 * nodeSize` floored at a minimum), so that pulling
   * a large node out of its frame still feels deliberate rather than
   * trivial.
   */
  pointerCaptureMargin?: number | { x: number; y: number };
};

export type Rect = { x: number; y: number; width: number; height: number };

export function rectIntersectionArea(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);

  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

/**
 * Creates a memoized function to get node rectangles in absolute coordinates.
 * Returns null if the node doesn't exist or has invalid dimensions.
 */
export function createRectGetter(
  byId: Map<string, NestableNode>,
  getAbs: (nodeId: string) => XYPosition | null,
) {
  const rectById = new Map<string, Rect | null>();

  return (id: string): Rect | null => {
    if (rectById.has(id)) return rectById.get(id) ?? null;

    const current = byId.get(id);
    if (!current) {
      rectById.set(id, null);
      return null;
    }

    const abs = getAbs(id);
    if (!abs) {
      rectById.set(id, null);
      return null;
    }

    const { width, height } = getNodeSize(current);
    if (width <= 0 || height <= 0) {
      rectById.set(id, null);
      return null;
    }

    const rect = { x: abs.x, y: abs.y, width, height };
    rectById.set(id, rect);
    return rect;
  };
}

/**
 * Shared predicate: should a child node leave its parent frame?
 *
 * Returns `true` when the node has no (or negligible) overlap with the
 * parent frame AND the edge-to-edge gap exceeds `margin`. If `pointer`
 * is provided together with `pointerCaptureMargin`, a pointer inside the
 * parent rect expanded by `pointerCaptureMargin` short-circuits the test
 * (the node stays parented), making intra-frame drags sticky.
 *
 * Used by both `autoUnframeNodeByNonOverlap` (mutates) and
 * `wouldUnframe` (pure predicate) so the decision logic is defined once.
 */
export function checkShouldUnframe(
  nodeRect: Rect,
  parentRect: Rect,
  options: AutoUnframeByNonOverlapOptions,
): boolean {
  // Pointer capture zone: while the cursor is still in (or close to) the
  // parent frame, keep the node parented regardless of bbox geometry.
  // This is the free-frame analogue of the structured-frame capture zone
  // in `resolveNodeDragStop.ts` — both implement the same UX rule:
  // "intent to leave" requires the user to pull the *cursor* clearly out
  // of the frame, not just nudge the node's body across the edge.
  const pointer = options.pointer;
  if (pointer) {
    const captureMargin = options.pointerCaptureMargin ?? 0;
    const captureX =
      typeof captureMargin === 'number' ? captureMargin : captureMargin.x;
    const captureY =
      typeof captureMargin === 'number' ? captureMargin : captureMargin.y;
    if (
      pointer.x >= parentRect.x - captureX &&
      pointer.x <= parentRect.x + parentRect.width + captureX &&
      pointer.y >= parentRect.y - captureY &&
      pointer.y <= parentRect.y + parentRect.height + captureY
    ) {
      return false;
    }
  }

  const intersection = rectIntersectionArea(nodeRect, parentRect);
  const epsilon = options.epsilon ?? 0;
  if (intersection > epsilon) return false; // Still overlapping, keep in frame

  const margin = options.margin ?? 0;
  if (margin > 0) {
    const hGap = Math.max(
      0,
      nodeRect.x - (parentRect.x + parentRect.width),
      parentRect.x - (nodeRect.x + nodeRect.width),
    );
    const vGap = Math.max(
      0,
      nodeRect.y - (parentRect.y + parentRect.height),
      parentRect.y - (nodeRect.y + nodeRect.height),
    );
    const gap = Math.max(hGap, vGap);
    if (gap <= margin) return false; // Close enough, keep in frame
  }

  return true;
}

/**
 * Shared predicate: which frame (if any) should a node auto-enter?
 *
 * Returns the frame ID selected by the pointer surface, or `null`.
 * Used by both `autoFrameNodeByOverlap` (mutates) and
 * `wouldAutoFrame` (pure predicate).
 *
 * With a pointer, only frames containing that pointer and having positive body
 * overlap qualify. Without a pointer, the legacy body-overlap ratio threshold
 * is the fallback. Ancestors remain candidates without the nested-entry
 * modifier so leaving an inner surface can land on an exposed ancestor;
 * unrelated child Frames remain frozen unless nested entry is explicit.
 *
 * Deepest-first selection makes the current parent a natural no-op surface and
 * chooses the nearest ancestor or explicitly opened descendant under the
 * pointer. Highest overlap breaks ties between unrelated overlapping Frames.
 */
export function findBestFrameForNode(
  nodes: NestableNode[],
  nodeId: string,
  threshold: number,
  getRect: (id: string) => Rect | null,
  pointer?: { x: number; y: number },
  allowNestedFrameEntry = false,
): string | null {
  const nodeRect = getRect(nodeId);
  if (!nodeRect) return null;

  const nodeArea = nodeRect.width * nodeRect.height;
  if (nodeArea <= 0) return null;

  const node = nodes.find((candidate) => candidate.id === nodeId);
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  const ancestorIds = new Set<string>();
  let ancestorId = node?.parentId;
  while (ancestorId && !ancestorIds.has(ancestorId)) {
    ancestorIds.add(ancestorId);
    ancestorId = byId.get(ancestorId)?.parentId;
  }
  const descendantIds = new Set(getDescendantIds(nodes, nodeId));

  // 1. Collect all qualifying candidate frames.
  const candidates: { frameId: string; ratio: number }[] = [];

  for (const candidate of nodes) {
    if (candidate.type !== 'frame') continue;
    if (candidate.id === nodeId) continue;
    if (candidate.data?.locked) continue;
    if (descendantIds.has(candidate.id)) continue;
    // Ancestors remain eligible without the nested-entry modifier: moving
    // from an inner Frame onto an exposed ancestor surface is an upward exit,
    // not a downward entry. Every other nested Frame stays frozen unless the
    // modifier explicitly opens nested entry.
    if (
      candidate.parentId &&
      !ancestorIds.has(candidate.id) &&
      !allowNestedFrameEntry
    ) {
      continue;
    }

    const frameRect = getRect(candidate.id);
    if (!frameRect) continue;

    const frameArea = frameRect.width * frameRect.height;
    const intersection = rectIntersectionArea(nodeRect, frameRect);
    const ratio = intersection / Math.min(nodeArea, frameArea);

    const pointerInside =
      pointer !== undefined &&
      pointer.x >= frameRect.x &&
      pointer.x <= frameRect.x + frameRect.width &&
      pointer.y >= frameRect.y &&
      pointer.y <= frameRect.y + frameRect.height;

    // Pointer is the primary ownership signal. The node body must still touch
    // that surface, which protects synthetic and multi-node drag paths where
    // the pointer is not necessarily inside every dragged footprint. Only
    // pointer-less callers fall back to the legacy overlap-ratio policy.
    if (pointer) {
      if (!pointerInside) continue;
      if (intersection <= 0) continue;
    } else {
      if (ratio < threshold) continue;
    }

    candidates.push({ frameId: candidate.id, ratio });
  }

  if (candidates.length === 0) return null;

  // 2. Among qualifying candidates, remove any frame whose descendant is
  //    also a candidate — this ensures we always pick the deepest (most
  //    nested) frame rather than relying on area heuristics.
  const candidateIdSet = new Set(candidates.map((c) => c.frameId));
  const deepest = candidates.filter((c) => {
    const children = getDescendantIds(nodes, c.frameId);
    return !children.some((d) => candidateIdSet.has(d));
  });

  // 3. Among the deepest candidates, pick the one with the highest overlap.
  const pool = deepest.length > 0 ? deepest : candidates;
  let best: { frameId: string; ratio: number } | undefined;
  for (const c of pool) {
    if (!best || c.ratio > best.ratio) {
      best = c;
    }
  }

  if (!best) return null;
  if (node?.parentId === best.frameId) return null;
  return best.frameId;
}
