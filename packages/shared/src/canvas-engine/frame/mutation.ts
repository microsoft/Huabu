// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Frame Mutation - Operations that produce new nodes/edges arrays
 *
 * Includes Frame-specific batch operations (`frameNodes`,
 * `frameNodesInRect`, `unframe`) and overlap-driven auto-detect entry points.
 * Generic reparenting lives in `container/mutation.ts`.
 *
 * All functions are pure: input arrays are never mutated.
 */

import {
  checkShouldUnframe,
  createRectGetter,
  findBestFrameForNode,
  rectIntersectionArea,
  type AutoFrameByOverlapOptions,
  type AutoUnframeByNonOverlapOptions,
  type Rect,
} from './geometry.js';
import {
  moveNodeIntoContainer,
  moveNodeOutOfContainer,
} from '../container/mutation.js';
import {
  addPos,
  createAbsolutePositionGetter,
  getTopLevelIds,
  indexById,
  normalizeTreeOrder,
  subPos,
  type NestableNode,
} from '../container/tree.js';
import { medianOfChildExtents, paddingFromExtent } from '../utils/constants.js';
import { getNodeSize } from '../utils/nodeSizes.js';

import type { Edge, XYPosition } from '@xyflow/react';

export type UnframeResult = {
  nodes: NestableNode[];
  edges: Edge[];
};

/**
 * Removes a frame node and rehomes its direct children.
 *
 * - Children keep their visual positions.
 * - If the frame is nested, children are moved to the frame's parent.
 * - Any edges connected to the removed frame are dropped.
 */
export function unframe(
  nodes: NestableNode[],
  edges: Edge[],
  frameId: string,
): UnframeResult {
  const byId = indexById(nodes);
  const getAbs = createAbsolutePositionGetter(byId);
  const group = byId.get(frameId);
  if (!group) return { nodes, edges };

  const groupAbs = getAbs(frameId);
  if (!groupAbs) return { nodes, edges };

  const parentId = group.parentId;
  const parentAbs = parentId ? getAbs(parentId) : null;

  const nextNodes: NestableNode[] = [];
  for (const n of nodes) {
    if (n.id === frameId) continue;

    if (n.parentId === frameId) {
      const childAbs = addPos(groupAbs, n.position);

      if (parentId && parentAbs) {
        // Child moves to the frame's parent frame — ensure zIndex: -1.
        nextNodes.push({
          ...n,
          parentId,
          position: subPos(childAbs, parentAbs),
          zIndex: -1,
        });
      } else {
        // Child becomes top-level — strip frame-level zIndex.
        const { parentId: _parentId, zIndex: _zIndex, ...rest } = n;
        nextNodes.push({
          ...rest,
          position: childAbs,
        });
      }

      continue;
    }

    nextNodes.push(n);
  }

  const nextEdges = edges.filter(
    (e) => e.source !== frameId && e.target !== frameId,
  );

  return { nodes: normalizeTreeOrder(nextNodes), edges: nextEdges };
}

export type FrameNodesOptions = {
  frameId: string;
  label?: string;
  padding?: number;
  minWidth?: number;
  minHeight?: number;
};

export type FrameNodesResult = {
  nodes: NestableNode[];
  frameId: string;
};

/**
 * If a node has a parent and the node and parent have no overlap,
 * delegate to moveNodeOutOfFrame to detach the node.
 *
 * This function is responsible for:
 * - Detecting non-overlap condition
 * - Delegating the actual move to moveNodeOutOfFrame (which handles validation)
 */
export function autoUnframeNodeByNonOverlap(
  nodes: NestableNode[],
  nodeId: string,
  options: AutoUnframeByNonOverlapOptions = {},
): NestableNode[] {
  const byId = indexById(nodes);
  const node = byId.get(nodeId);
  if (!node?.parentId) return nodes;

  const parentId = node.parentId;
  const parent = byId.get(parentId);
  if (parent?.type !== 'frame') return nodes;

  const getAbs = createAbsolutePositionGetter(byId);
  const getRect = createRectGetter(byId, getAbs);

  const nodeRect = getRect(nodeId);
  const parentRect = getRect(parentId);
  if (!nodeRect || !parentRect) return nodes;

  if (!checkShouldUnframe(nodeRect, parentRect, options)) return nodes;

  // Delegate to moveNodeOutOfFrame for consistent validation and movement logic
  return moveNodeOutOfContainer(nodes, nodeId);
}

/**
 * If a node is dropped with >= threshold of its area inside an *unlocked* frame,
 * find the best matching frame and delegate to moveNodeIntoFrame.
 *
 * This function is responsible for:
 * - Calculating overlap ratios
 * - Selecting the pointer-owned Frame surface (or overlap fallback)
 * - Delegating the actual move to moveNodeIntoFrame (which handles validation)
 */
export function autoFrameNodeByOverlap(
  nodes: NestableNode[],
  nodeId: string,
  options: AutoFrameByOverlapOptions = {},
): NestableNode[] {
  const threshold = options.threshold ?? 0.5;
  if (!Number.isFinite(threshold) || threshold <= 0) return nodes;

  const byId = indexById(nodes);
  const node = byId.get(nodeId);
  if (!node) return nodes;

  const getAbs = createAbsolutePositionGetter(byId);
  const getRect = createRectGetter(byId, getAbs);

  const bestFrameId = findBestFrameForNode(
    nodes,
    nodeId,
    threshold,
    getRect,
    options.pointer,
    options.allowNestedFrameEntry,
  );
  if (!bestFrameId) return nodes;

  // Delegate to moveNodeIntoFrame for consistent validation and movement logic
  return moveNodeIntoContainer(nodes, nodeId, bestFrameId);
}

/**
 * Creates a new frame node and reparents the given nodes under it.
 *
 * - Preserves visual positions by converting children to relative coordinates.
 * - If all selected nodes share the same direct parent, the frame is created under that parent.
 *   Otherwise, the frame is created at the root.
 */
export function frameNodes(
  nodes: NestableNode[],
  nodeIds: string[],
  options: FrameNodesOptions,
): FrameNodesResult {
  const ids = nodeIds.filter(Boolean);
  if (ids.length === 0) return { nodes, frameId: options.frameId };

  const topLevelIds = getTopLevelIds(nodes, ids);
  if (topLevelIds.length === 0) return { nodes, frameId: options.frameId };

  const byId = indexById(nodes);
  const minWidth = options.minWidth ?? 240;
  const minHeight = options.minHeight ?? 160;

  const getAbs = createAbsolutePositionGetter(byId);

  const directParents = new Set<string | undefined>();
  for (const id of topLevelIds) {
    directParents.add(byId.get(id)?.parentId);
  }
  const groupParentId =
    directParents.size === 1 ? [...directParents][0] : undefined;
  const groupParentAbs = groupParentId ? getAbs(groupParentId) : null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  // Gather the to-be-children sizes once so we can both build the
  // bounding box and feed them to `paddingFromExtent` for a
  // content-aware initial padding (matching `applyColumnLayout` /
  // `applyRowLayout` / `computeFrameFit`).
  const childSizes: { width: number; height: number }[] = [];

  for (const id of topLevelIds) {
    const n = byId.get(id);
    if (!n) continue;
    const abs = getAbs(id);
    if (!abs) continue;

    const size = getNodeSize(n);
    childSizes.push(size);
    minX = Math.min(minX, abs.x);
    minY = Math.min(minY, abs.y);
    maxX = Math.max(maxX, abs.x + size.width);
    maxY = Math.max(maxY, abs.y + size.height);
  }

  const padding =
    options.padding ?? paddingFromExtent(medianOfChildExtents(childSizes));

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { nodes, frameId: options.frameId };
  }

  const groupAbs: XYPosition = { x: minX - padding, y: minY - padding };
  const width = Math.max(minWidth, maxX - minX + padding * 2);
  const height = Math.max(minHeight, maxY - minY + padding * 2);

  const groupPos = groupParentAbs ? subPos(groupAbs, groupParentAbs) : groupAbs;

  const groupNode: NestableNode = {
    id: options.frameId,
    type: 'frame',
    ...(groupParentId ? { parentId: groupParentId } : {}),
    position: groupPos,
    data: {
      label: options.label ?? 'Frame',
    },
    style: { width, height },
    zIndex: -1,
  };

  const topLevelSet = new Set(topLevelIds);
  const nextNodes = nodes.map((n) => {
    if (!topLevelSet.has(n.id)) return n;

    const abs = getAbs(n.id);
    if (!abs) return n;

    return {
      ...n,
      parentId: options.frameId,
      position: subPos(abs, groupAbs),
      extent: undefined,
      zIndex: -1,
    };
  });

  return {
    nodes: normalizeTreeOrder([groupNode, ...nextNodes]),
    frameId: options.frameId,
  };
}

export type FrameNodesInRectOptions = {
  /**
   * Fraction of a candidate node's area that must overlap the drawn rectangle
   * for it to be absorbed into the new frame. Default: 0.5 (50 %).
   */
  threshold?: number;
};

export type FrameNodesInRectResult = {
  nodes: NestableNode[];
  frameId: string;
};

/**
 * Creates a frame node sized to the given flow-space rectangle and absorbs
 * any top-level, non-frame nodes whose area overlaps the rectangle by at
 * least `threshold`.
 *
 * - The frame is placed at the exact drawn rectangle (no auto-resize).
 * - Delegates to moveNodeIntoFrame for each absorbed node, so all existing
 *   validations (locked, nesting, cycles) are respected.
 */
export function frameNodesInRect(
  nodes: NestableNode[],
  flowRect: { x: number; y: number; width: number; height: number },
  frameId: string,
  options: FrameNodesInRectOptions = {},
): FrameNodesInRectResult {
  const rawThreshold = options.threshold ?? 0.5;
  if (!Number.isFinite(rawThreshold) || rawThreshold <= 0)
    return { nodes, frameId };
  const threshold = Math.min(rawThreshold, 1);
  const { x, y, width, height } = flowRect;

  if (width <= 0 || height <= 0) return { nodes, frameId };

  const frameRect: Rect = { x, y, width, height };

  const frameNode: NestableNode = {
    id: frameId,
    type: 'frame',
    position: { x, y },
    data: { type: 'frame', label: 'Frame' },
    style: {
      width,
      height,
    },
    zIndex: -1,
  };

  // Insert the frame first so moveNodeIntoFrame can resolve it by id.
  let result: NestableNode[] = [...nodes, frameNode];

  // Use the original node map for absolute-position lookups (before any
  // parent-child changes are applied).
  const byId = indexById(nodes);
  const getAbs = createAbsolutePositionGetter(byId);

  for (const node of nodes) {
    // Only top-level nodes are candidates.
    if (node.parentId) continue;
    if (node.id === frameId) continue;

    const abs = getAbs(node.id);
    if (!abs) continue;

    const size = getNodeSize(node);
    if (size.width <= 0 || size.height <= 0) continue;

    const nodeRect: Rect = { x: abs.x, y: abs.y, ...size };
    const nodeArea = size.width * size.height;
    const intersection = rectIntersectionArea(nodeRect, frameRect);

    if (intersection / nodeArea >= threshold) {
      result = moveNodeIntoContainer(result, node.id, frameId);
    }
  }

  return { nodes: result, frameId };
}
