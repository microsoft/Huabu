/**
 * @file helper.ts
 *
 * Generic canvas-node utilities that are not specific to frames.
 */

import { getDescendantIds, type NestableNode } from '../canvas/frame';

type NodeWithPosition = {
  position: { x: number; y: number };
  measured?: { width?: number; height?: number };
  width?: number;
  height?: number;
};

/**
 * Returns the best source/target handle pair for an edge between two nodes
 * based on their relative positions on the canvas.
 *
 * Picks the handles that produce the most direct, least-crossing path:
 * - Target primarily to the right → right-source / left-target
 * - Target primarily to the left  → left-source  / right-target
 * - Target primarily below        → bottom-source / top-target
 * - Target primarily above        → top-source   / bottom-target
 */
export function getSmartHandles(
  sourceNode: NodeWithPosition,
  targetNode: NodeWithPosition,
): { sourceHandle: string; targetHandle: string } {
  const sw = sourceNode.measured?.width ?? sourceNode.width ?? 150;
  const sh = sourceNode.measured?.height ?? sourceNode.height ?? 100;
  const tw = targetNode.measured?.width ?? targetNode.width ?? 150;
  const th = targetNode.measured?.height ?? targetNode.height ?? 100;

  const sx = sourceNode.position.x + sw / 2;
  const sy = sourceNode.position.y + sh / 2;
  const tx = targetNode.position.x + tw / 2;
  const ty = targetNode.position.y + th / 2;

  const dx = tx - sx;
  const dy = ty - sy;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: 'right-source', targetHandle: 'left-target' }
      : { sourceHandle: 'left-source', targetHandle: 'right-target' };
  } else {
    return dy >= 0
      ? { sourceHandle: 'bottom-source', targetHandle: 'top-target' }
      : { sourceHandle: 'top-source', targetHandle: 'bottom-target' };
  }
}

/**
 * Recalculate sourceHandle / targetHandle for every edge based on the
 * current relative positions of their source and target nodes.
 *
 * Returns the original `edges` reference when nothing changed, so React /
 * zustand can skip re-renders via reference equality.
 */
export function rerouteAllEdges<
  N extends NodeWithPosition & { id: string },
  E extends {
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  },
>(nodes: N[], edges: E[]): E[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  let changed = false;
  const result = edges.map((edge) => {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) return edge;

    const handles = getSmartHandles(source, target);
    if (
      edge.sourceHandle === handles.sourceHandle &&
      edge.targetHandle === handles.targetHandle
    ) {
      return edge;
    }
    changed = true;
    return { ...edge, ...handles };
  });
  return changed ? result : edges;
}

/**
 * Toggles a node's locked state by flipping `data.locked`.
 *
 * Works for any node type, not just frames. When locked:
 * - The node itself becomes non-draggable on the canvas.
 * - The node remains selectable so that pointer events (e.g. double-click
 *   to expand) still work; resize and content editing are blocked at the
 *   component level instead.
 * - For frame nodes, all descendant nodes additionally become non-draggable
 *   so they cannot be individually repositioned inside the locked container.
 *
 * Unlocking reverses all of the above.
 */
export function toggleNodeLock(
  nodes: NestableNode[],
  nodeId: string,
): NestableNode[] {
  const target = nodes.find((n) => n.id === nodeId);
  if (!target) return nodes;

  const locked = Boolean(target.data?.locked);
  const nextLocked = !locked;

  const flagKey = '__dragDisabledByFrameLock';
  const descendantIds = new Set(getDescendantIds(nodes, nodeId));

  return nodes.map((n) => {
    // The locked node itself: set draggable so ReactFlow respects it.
    // Always strip `selectable` so it defaults to the global
    // `elementsSelectable` (true) — this also cleans up any stale
    // `selectable: false` that may have been persisted by older code.
    // Add `nopan` to className so ReactFlow's ZoomPane still skips mousedown
    // on this node — without it, panning would interfere with double-click.
    if (n.id === nodeId) {
      if (nextLocked) {
        const { selectable: _s, ...rest } = n;
        void _s;
        return {
          ...rest,
          draggable: false,
          className: [n.className, 'nopan'].filter(Boolean).join(' '),
          data: { ...(n.data ?? {}), locked: true },
        };
      }
      // Unlock: restore defaults (ReactFlow treats undefined as true).
      // Also remove the 'nopan' class we injected during locking.
      const { draggable: _d, selectable: _s, ...rest } = n;
      void _d;
      void _s;
      const prevClass =
        (n.className ?? '')
          .split(' ')
          .filter((c) => c !== 'nopan')
          .join(' ') || undefined;
      return {
        ...rest,
        ...(prevClass ? { className: prevClass } : {}),
        data: { ...(n.data ?? {}), locked: false },
      };
    }

    if (!descendantIds.has(n.id)) return n;

    // Descendant handling (frame children become non-draggable when parent locks).
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
