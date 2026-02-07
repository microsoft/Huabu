import type { Edge, Node, XYPosition } from '@xyflow/react';

export type NestableNode = Node & {
  parentId?: string;
  extent?: Node['extent'];
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

function normalizeTreeOrder(nodes: NestableNode[]): NestableNode[] {
  const byId = indexById(nodes);
  const originalIndex = new Map(nodes.map((n, i) => [n.id, i] as const));

  // Drop dangling parent links to avoid runtime errors.
  const normalized = nodes.map((n) => {
    if (!n.parentId) return n;
    if (byId.has(n.parentId)) return n;

    const { parentId: _parentId, extent: _extent, ...rest } = n;
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
        const { parentId: _parentId, extent: _extent, ...rest } = node;
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
 */
export function getAbsolutePosition(
  nodes: NestableNode[],
  nodeId: string,
): XYPosition | null {
  const byId = indexById(nodes);
  let current = byId.get(nodeId);
  if (!current) return null;

  let pos: XYPosition = { ...current.position };
  const visited = new Set<string>([current.id]);

  while (current.parentId) {
    const parent = byId.get(current.parentId);
    if (!parent) break;
    if (visited.has(parent.id)) break;

    pos = addPos(parent.position, pos);
    visited.add(parent.id);
    current = parent;
  }

  return pos;
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
          extent: n.extent === 'parent' ? 'parent' : n.extent,
        });
      } else {
        const { parentId: _parentId, extent: _extent, ...rest } = n;
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

  return nodes.map((n) => {
    if (n.id !== frameId) return n;
    return {
      ...n,
      data: { ...(n.data ?? {}), locked: nextLocked },
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
 * If a node is dropped with >= threshold of its area inside an *unlocked* frame,
 * reparent it under that frame while preserving its visual position.
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
  const rectById = new Map<string, Rect | null>();

  const getRect = (id: string): Rect | null => {
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
    if (candidate.data?.locked) continue;

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

  const frameAbs = getAbs(best.frameId);
  const nodeAbs = getAbs(nodeId);
  if (!frameAbs || !nodeAbs) return nodes;

  const nextNodes = nodes.map((n) => {
    if (n.id !== nodeId) return n;
    return {
      ...n,
      parentId: best.frameId,
      position: subPos(nodeAbs, frameAbs),
      extent: 'parent' as const,
    };
  });

  return normalizeTreeOrder(nextNodes);
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
      extent: 'parent' as const,
      selected: false,
    };
  });

  return {
    nodes: normalizeTreeOrder([groupNode, ...nextNodes]),
    frameId: options.frameId,
  };
}
