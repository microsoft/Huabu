/**
 * Frame Geometry - Internal rectangle / overlap helpers shared by the
 * detection and mutation submodules.
 *
 * Everything here except the publicly-referenced Options types is private
 * to the frame subsystem and intentionally omitted from the barrel.
 */

import { getDescendantIds, type NestableNode } from './tree.js';
import { getNodeSize } from '../utils/nodeSizes.js';

import type { XYPosition } from '@xyflow/react';

export type AutoFrameByOverlapOptions = {
  /** Portion of the dragged node area that must be inside the frame. */
  threshold?: number;
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
 * parent frame AND the edge-to-edge gap exceeds `margin`.
 *
 * Used by both `autoUnframeNodeByNonOverlap` (mutates) and
 * `wouldUnframe` (pure predicate) so the decision logic is defined once.
 */
export function checkShouldUnframe(
  nodeRect: Rect,
  parentRect: Rect,
  options: AutoUnframeByNonOverlapOptions,
): boolean {
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
 * Returns the frame ID with the best overlap ratio, or `null`.
 * Used by both `autoFrameNodeByOverlap` (mutates) and
 * `wouldAutoFrame` (pure predicate).
 */
export function findBestFrameForNode(
  nodes: NestableNode[],
  nodeId: string,
  threshold: number,
  getRect: (id: string) => Rect | null,
): string | null {
  const nodeRect = getRect(nodeId);
  if (!nodeRect) return null;

  const nodeArea = nodeRect.width * nodeRect.height;
  if (nodeArea <= 0) return null;

  const descendantIds = new Set(getDescendantIds(nodes, nodeId));

  // 1. Collect all qualifying candidate frames.
  const candidates: { frameId: string; ratio: number }[] = [];

  for (const candidate of nodes) {
    if (candidate.type !== 'frame') continue;
    if (candidate.id === nodeId) continue;
    if (candidate.data?.locked) continue;
    if (descendantIds.has(candidate.id)) continue;

    const frameRect = getRect(candidate.id);
    if (!frameRect) continue;

    const frameArea = frameRect.width * frameRect.height;
    const intersection = rectIntersectionArea(nodeRect, frameRect);
    const ratio = intersection / Math.min(nodeArea, frameArea);
    if (ratio < threshold) continue;

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
  const node = nodes.find((n) => n.id === nodeId);
  if (node?.parentId === best.frameId) return null;
  return best.frameId;
}
