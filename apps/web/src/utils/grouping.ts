import type { Edge, Node, XYPosition } from '@xyflow/react';

export type GroupingNode = Node & {
  parentId?: string;
  extent?: Node['extent'];
  draggable?: boolean;
  data?: Record<string, unknown>;
};

function addPos(a: XYPosition, b: XYPosition): XYPosition {
  return { x: a.x + b.x, y: a.y + b.y };
}

function subPos(a: XYPosition, b: XYPosition): XYPosition {
  return { x: a.x - b.x, y: a.y - b.y };
}

function indexById(nodes: GroupingNode[]): Map<string, GroupingNode> {
  return new Map(nodes.map((n) => [n.id, n] as const));
}

function normalizeTreeOrder(nodes: GroupingNode[]): GroupingNode[] {
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
  const result: GroupingNode[] = [];

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

function getNodeSize(node: GroupingNode): { width: number; height: number } {
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

function getAncestorIds(nodes: GroupingNode[], nodeId: string): string[] {
  const byId = indexById(nodes);
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

function getTopLevelIds(nodes: GroupingNode[], ids: string[]): string[] {
  const selected = new Set(ids);
  return ids.filter((id) => {
    const ancestors = getAncestorIds(nodes, id);
    return !ancestors.some((a) => selected.has(a));
  });
}

/**
 * Computes a node's absolute position in the flow coordinate space.
 * Works for nested frames by walking the parent chain.
 */
export function getAbsolutePosition(
  nodes: GroupingNode[],
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
  nodes: GroupingNode[],
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
  nodes: GroupingNode[];
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
  nodes: GroupingNode[],
  edges: Edge[],
  frameId: string,
): UnframeResult {
  const byId = indexById(nodes);
  const group = byId.get(frameId);
  if (!group) return { nodes, edges };

  const groupAbs = getAbsolutePosition(nodes, frameId);
  if (!groupAbs) return { nodes, edges };

  const parentId = group.parentId;
  const parentAbs = parentId ? getAbsolutePosition(nodes, parentId) : null;

  const nextNodes: GroupingNode[] = [];
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
 * Toggles a frame's locked state by flipping `data.locked` and setting `draggable`.
 * Applies to the frame and all its descendants.
 */
export function toggleFrameLock(
  nodes: GroupingNode[],
  frameId: string,
): GroupingNode[] {
  const byId = indexById(nodes);
  const group = byId.get(frameId);
  if (!group) return nodes;

  const locked = Boolean(group.data?.locked);
  const nextLocked = !locked;

  const descendantIds = new Set([frameId, ...getDescendantIds(nodes, frameId)]);

  return nodes.map((n) => {
    if (!descendantIds.has(n.id)) return n;

    const data = { ...(n.data ?? {}), locked: nextLocked };
    return {
      ...n,
      data,
      draggable: !nextLocked,
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
  nodes: GroupingNode[];
  frameId: string;
};

/**
 * Creates a new frame node and reparents the given nodes under it.
 *
 * - Preserves visual positions by converting children to relative coordinates.
 * - If all selected nodes share the same direct parent, the frame is created under that parent.
 *   Otherwise, the frame is created at the root.
 */
export function frameNodes(
  nodes: GroupingNode[],
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

  const directParents = new Set<string | undefined>();
  for (const id of topLevelIds) {
    directParents.add(byId.get(id)?.parentId);
  }
  const groupParentId =
    directParents.size === 1 ? [...directParents][0] : undefined;
  const groupParentAbs = groupParentId
    ? getAbsolutePosition(nodes, groupParentId)
    : null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const id of topLevelIds) {
    const n = byId.get(id);
    if (!n) continue;
    const abs = getAbsolutePosition(nodes, id);
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

  const groupNode: GroupingNode = {
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

    const abs = getAbsolutePosition(nodes, n.id);
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
