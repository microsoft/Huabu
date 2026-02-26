/**
 * Frame Helper - Canvas Node Hierarchy Management
 *
 * This module provides utilities for managing frame-based node hierarchies in ReactFlow.
 * Frames are container nodes that can hold child nodes, with automatic coordinate
 * transformation to maintain visual consistency.
 *
 * Architecture (Layered Design):
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ Geometry Layer (Low-level, Pure Functions)                      │
 * ├─────────────────────────────────────────────────────────────────┤
 * │ • createAbsolutePositionGetter - Compute absolute coordinates   │
 * │   with memoization for performance                              │
 * │ • createRectGetter - Calculate node rectangles in absolute      │
 * │   coordinates with validation and caching                       │
 * │ • rectIntersectionArea - Calculate overlap between rectangles   │
 * └─────────────────────────────────────────────────────────────────┘
 *                                ▼
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ Detection Layer (Mid-level, Decision Makers)                    │
 * ├─────────────────────────────────────────────────────────────────┤
 * │ • autoFrameNodeByOverlap - Detect if node should enter frame    │
 * │   (75% overlap threshold, prefers smallest matching frame)      │
 * │ • autoUnframeNodeByNonOverlap - Detect if node should exit      │
 * │   frame (no overlap with parent)                                │
 * │ Both delegate to Execution Layer for actual moves               │
 * └─────────────────────────────────────────────────────────────────┘
 *                                ▼
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ Execution Layer (High-level, Core Operations)                   │
 * ├─────────────────────────────────────────────────────────────────┤
 * │ • moveNodeIntoFrame - Core function to add node to frame        │
 * │   Validates: locked status, no frame nesting, no cycles         │
 * │ • moveNodeOutOfFrame - Core function to remove node from frame  │
 * │   Validates: parent exists and is not locked                    │
 * │ Both preserve visual positions via coordinate transformation    │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Design Principles:
 * 1. Single Responsibility: Each function has one clear purpose
 * 2. Logic Reuse: Detection functions delegate to execution functions
 * 3. Immutability: All functions return new arrays, never mutate input
 * 4. Visual Consistency: All moves preserve node's visual position on canvas
 * 5. Locked Frame Respect: Locked frames cannot gain or lose children
 */

import type { Edge, Node, XYPosition } from '@xyflow/react';

export type NestableNode = Node & {
  parentId?: string;
  data?: Record<string, unknown>;
};

function addPos(a: XYPosition, b: XYPosition): XYPosition {
  return { x: a.x + b.x, y: a.y + b.y };
}

function subPos(a: XYPosition, b: XYPosition): XYPosition {
  return { x: a.x - b.x, y: a.y - b.y };
}

function indexById(nodes: NestableNode[]): Map<string, NestableNode> {
  return new Map(nodes.map((n) => [n.id, n] as const));
}

/**
 * Ensures nodes are ordered so parents appear before their children.
 * This is required by React Flow to avoid "parent node not found" errors.
 * Also removes dangling parent references and breaks cycles.
 */
export function normalizeTreeOrder(nodes: NestableNode[]): NestableNode[] {
  const byId = indexById(nodes);
  const originalIndex = new Map(nodes.map((n, i) => [n.id, i] as const));

  // Drop dangling parent links to avoid runtime errors.
  const normalized = nodes.map((n) => {
    if (!n.parentId) return n;
    if (byId.has(n.parentId)) return n;

    const { parentId: _parentId, ...rest } = n;
    return rest;
  });

  const normalizedById = indexById(normalized);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const result: NestableNode[] = [];

  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      // Break cycles defensively by treating the node as root.
      const node = normalizedById.get(id);
      if (node?.parentId) {
        const { parentId: _parentId, ...rest } = node;
        normalizedById.set(id, rest);
      }
      visiting.delete(id);
    }

    const node = normalizedById.get(id);
    if (!node) return;

    visiting.add(id);
    if (node.parentId) visit(node.parentId);
    visiting.delete(id);

    visited.add(id);
    result.push(node);
  };

  // Stable-ish order: iterate by original index.
  const ids = [...normalizedById.keys()].sort((a, b) => {
    return (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0);
  });
  for (const id of ids) visit(id);

  return result;
}

function getNodeSize(node: NestableNode): { width: number; height: number } {
  const measured = (
    node as unknown as { measured?: { width?: number; height?: number } }
  ).measured;
  const style = (
    node as unknown as { style?: { width?: unknown; height?: unknown } }
  ).style;

  const width =
    (typeof measured?.width === 'number' ? measured.width : undefined) ??
    (typeof style?.width === 'number'
      ? style.width
      : typeof style?.width === 'string'
      ? Number.parseFloat(style.width)
      : undefined) ??
    0;

  const height =
    (typeof measured?.height === 'number' ? measured.height : undefined) ??
    (typeof style?.height === 'number'
      ? style.height
      : typeof style?.height === 'string'
      ? Number.parseFloat(style.height)
      : undefined) ??
    0;

  return {
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
  };
}

function getAncestorIds(
  byId: Map<string, NestableNode>,
  nodeId: string,
): string[] {
  const result: string[] = [];

  let current = byId.get(nodeId);
  const visited = new Set<string>([nodeId]);

  while (current?.parentId) {
    const parentId = current.parentId;
    if (visited.has(parentId)) break;
    visited.add(parentId);
    result.push(parentId);
    current = byId.get(parentId);
  }

  return result;
}

function getTopLevelIds(nodes: NestableNode[], ids: string[]): string[] {
  const byId = indexById(nodes);
  const selected = new Set(ids);
  return ids.filter((id) => {
    const ancestors = getAncestorIds(byId, id);
    return !ancestors.some((a) => selected.has(a));
  });
}

function createAbsolutePositionGetter(byId: Map<string, NestableNode>) {
  const absById = new Map<string, XYPosition | null>();

  return (nodeId: string): XYPosition | null => {
    if (absById.has(nodeId)) return absById.get(nodeId) ?? null;

    const chain: NestableNode[] = [];
    const visited = new Set<string>();

    let currentId: string | undefined = nodeId;
    let baseAbs: XYPosition = { x: 0, y: 0 };

    while (currentId) {
      if (absById.has(currentId)) {
        baseAbs = absById.get(currentId) ?? { x: 0, y: 0 };
        break;
      }

      const current = byId.get(currentId);
      if (!current) {
        absById.set(nodeId, null);
        return null;
      }

      chain.push(current);
      visited.add(current.id);

      const parentId = current.parentId;
      if (!parentId) break;

      // Match getAbsolutePosition semantics:
      // - dangling parentId: stop walking
      // - cycles: stop walking
      if (!byId.has(parentId)) break;
      if (visited.has(parentId)) break;

      if (absById.has(parentId)) {
        baseAbs = absById.get(parentId) ?? { x: 0, y: 0 };
        break;
      }

      currentId = parentId;
    }

    let abs = baseAbs;
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const n = chain[i];
      abs = addPos(abs, n.position);
      absById.set(n.id, abs);
    }

    return absById.get(nodeId) ?? null;
  };
}

/**
 * Computes a node's absolute position in the flow coordinate space.
 * Works for nested frames by walking the parent chain.
 *
 * Delegates to createAbsolutePositionGetter for consistent logic.
 */
export function getAbsolutePosition(
  nodes: NestableNode[],
  nodeId: string,
): XYPosition | null {
  const byId = indexById(nodes);
  const getAbs = createAbsolutePositionGetter(byId);
  return getAbs(nodeId);
}

export function getDescendantIds(
  nodes: NestableNode[],
  rootId: string,
): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const arr = childrenByParent.get(n.parentId) ?? [];
    arr.push(n.id);
    childrenByParent.set(n.parentId, arr);
  }

  const result: string[] = [];
  const stack: string[] = [...(childrenByParent.get(rootId) ?? [])];

  while (stack.length) {
    const id = stack.pop();
    if (!id) continue;
    result.push(id);

    const kids = childrenByParent.get(id);
    if (kids?.length) stack.push(...kids);
  }

  return result;
}

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
        nextNodes.push({
          ...n,
          parentId,
          position: subPos(childAbs, parentAbs),
        });
      } else {
        const { parentId: _parentId, ...rest } = n;
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

/**
 * Toggles a frame's locked state by flipping `data.locked`.
 *
 * This is intentionally scoped to the frame node itself so locking only affects
 * behaviors that explicitly check this flag (e.g. auto-frame).
 */
export function toggleFrameLock(
  nodes: NestableNode[],
  frameId: string,
): NestableNode[] {
  const byId = indexById(nodes);
  const group = byId.get(frameId);
  if (!group) return nodes;

  const locked = Boolean(group.data?.locked);
  const nextLocked = !locked;

  const flagKey = '__dragDisabledByFrameLock';
  const descendantIds = new Set(getDescendantIds(nodes, frameId));

  return nodes.map((n) => {
    if (n.id === frameId) {
      return {
        ...n,
        data: { ...(n.data ?? {}), locked: nextLocked },
      };
    }

    if (!descendantIds.has(n.id)) return n;

    if (nextLocked) {
      if (n.draggable === false) return n;
      return {
        ...n,
        draggable: false,
        data: {
          ...(n.data ?? {}),
          [flagKey]: true,
        },
      };
    }

    if ((n.data as Record<string, unknown> | undefined)?.[flagKey] !== true)
      return n;

    const dataObj = (n.data ?? {}) as Record<string, unknown>;
    const { [flagKey]: removedFlag, ...restData } = dataObj;
    void removedFlag;

    return {
      ...n,
      draggable: true,
      data: restData,
    };
  });
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

export type AutoFrameByOverlapOptions = {
  /** Portion of the dragged node area that must be inside the frame. */
  threshold?: number;
};

export type AutoUnframeByNonOverlapOptions = {
  /** Treat intersection area <= epsilon as "no overlap". */
  epsilon?: number;
};

type Rect = { x: number; y: number; width: number; height: number };

function rectIntersectionArea(a: Rect, b: Rect): number {
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
function createRectGetter(
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
  if (!parent) return nodes;

  const getAbs = createAbsolutePositionGetter(byId);
  const getRect = createRectGetter(byId, getAbs);

  const nodeRect = getRect(nodeId);
  const parentRect = getRect(parentId);
  if (!nodeRect || !parentRect) return nodes;

  const intersection = rectIntersectionArea(nodeRect, parentRect);
  const epsilon = options.epsilon ?? 0;
  if (intersection > epsilon) return nodes; // Still overlapping, don't unframe

  // Delegate to moveNodeOutOfFrame for consistent validation and movement logic
  return moveNodeOutOfFrame(nodes, nodeId);
}

/**
 * If a node is dropped with >= threshold of its area inside an *unlocked* frame,
 * find the best matching frame and delegate to moveNodeIntoFrame.
 *
 * This function is responsible for:
 * - Calculating overlap ratios
 * - Finding the best frame (highest overlap, smallest area)
 * - Delegating the actual move to moveNodeIntoFrame (which handles validation)
 */
export function autoFrameNodeByOverlap(
  nodes: NestableNode[],
  nodeId: string,
  options: AutoFrameByOverlapOptions = {},
): NestableNode[] {
  const threshold = options.threshold ?? 0.75;
  if (!Number.isFinite(threshold) || threshold <= 0) return nodes;

  const byId = indexById(nodes);
  const node = byId.get(nodeId);
  if (!node) return nodes;
  if (node.type === 'frame') return nodes;

  const getAbs = createAbsolutePositionGetter(byId);
  const getRect = createRectGetter(byId, getAbs);

  const nodeRect = getRect(nodeId);
  if (!nodeRect) return nodes;

  const nodeArea = nodeRect.width * nodeRect.height;
  if (nodeArea <= 0) return nodes;

  let best:
    | {
        frameId: string;
        ratio: number;
        frameArea: number;
      }
    | undefined;

  for (const candidate of nodes) {
    if (candidate.type !== 'frame') continue;
    if (candidate.id === nodeId) continue;
    if (candidate.data?.locked) continue; // Skip locked frames during search

    const frameRect = getRect(candidate.id);
    if (!frameRect) continue;

    const intersection = rectIntersectionArea(nodeRect, frameRect);
    const ratio = intersection / nodeArea;
    if (ratio < threshold) continue;

    const frameArea = frameRect.width * frameRect.height;

    if (
      !best ||
      ratio > best.ratio ||
      (ratio === best.ratio && frameArea < best.frameArea)
    ) {
      best = { frameId: candidate.id, ratio, frameArea };
    }
  }

  if (!best) return nodes;
  if (node.parentId === best.frameId) return nodes;

  // Delegate to moveNodeIntoFrame for consistent validation and movement logic
  return moveNodeIntoFrame(nodes, nodeId, best.frameId);
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
  const padding = options.padding ?? 24;
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

  for (const id of topLevelIds) {
    const n = byId.get(id);
    if (!n) continue;
    const abs = getAbs(id);
    if (!abs) continue;

    const size = getNodeSize(n);
    minX = Math.min(minX, abs.x);
    minY = Math.min(minY, abs.y);
    maxX = Math.max(maxX, abs.x + size.width);
    maxY = Math.max(maxY, abs.y + size.height);
  }

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
    selected: true,
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
      selected: false,
      extent: undefined,
    };
  });

  return {
    nodes: normalizeTreeOrder([groupNode, ...nextNodes]),
    frameId: options.frameId,
  };
}

/**
 * Move a node into a frame, making it a child of the frame.
 * Preserves the node's visual position on the canvas.
 *
 * This is the core function for frame operations. It validates:
 * - Node and frame existence
 * - Frame is not locked
 * - No frames inside frames
 * - No cycles
 * - Not already a child
 */
export function moveNodeIntoFrame(
  nodes: NestableNode[],
  nodeId: string,
  frameId: string,
): NestableNode[] {
  const byId = indexById(nodes);
  const node = byId.get(nodeId);
  const frame = byId.get(frameId);

  if (!node || !frame) return nodes;
  if (frame.data?.locked) return nodes; // Don't move into locked frames
  if (node.type === 'frame') return nodes; // Don't allow frames inside frames
  if (node.id === frameId) return nodes; // Can't move into itself
  if (node.parentId === frameId) return nodes; // Already a child

  // Check if frameId is a descendant of nodeId (would create a cycle)
  const descendants = new Set(getDescendantIds(nodes, nodeId));
  if (descendants.has(frameId)) return nodes;

  const getAbs = createAbsolutePositionGetter(byId);
  const nodeAbs = getAbs(nodeId);
  const frameAbs = getAbs(frameId);

  if (!nodeAbs || !frameAbs) return nodes;

  // Calculate new relative position
  const newPosition = subPos(nodeAbs, frameAbs);

  const nextNodes = nodes.map((n) => {
    if (n.id !== nodeId) return n;
    return {
      ...n,
      parentId: frameId,
      position: newPosition,
      extent: undefined,
    };
  });

  return normalizeTreeOrder(nextNodes);
}

/**
 * Move a node out of its parent frame, making it a top-level node.
 * Preserves the node's visual position on the canvas.
 *
 * This is the core function for unframe operations. It validates:
 * - Node has a parent
 * - Parent frame is not locked
 * - Node position can be calculated
 */
export function moveNodeOutOfFrame(
  nodes: NestableNode[],
  nodeId: string,
): NestableNode[] {
  const byId = indexById(nodes);
  const node = byId.get(nodeId);

  if (!node?.parentId) return nodes; // Already top-level

  const parent = byId.get(node.parentId);
  if (parent?.data?.locked) return nodes; // Don't move out of locked frames

  const getAbs = createAbsolutePositionGetter(byId);
  const nodeAbs = getAbs(nodeId);

  if (!nodeAbs) return nodes;

  const nextNodes = nodes.map((n) => {
    if (n.id !== nodeId) return n;

    const { parentId: _parentId, ...rest } = n;
    return {
      ...rest,
      position: nodeAbs,
      extent: undefined,
    };
  });

  return normalizeTreeOrder(nextNodes);
}
