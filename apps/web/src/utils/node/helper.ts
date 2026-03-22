/**
 * @file helper.ts
 *
 * Generic canvas-node utilities that are not specific to frames.
 */

import { getDescendantIds, type NestableNode } from '../../canvas/utils/frame';

type NodeWithPosition = {
  id: string;
  position: { x: number; y: number };
  parentId?: string;
  measured?: { width?: number; height?: number };
  style?: { width?: number | string; height?: number | string };
  width?: number;
  height?: number;
};

/**
 * Resolve the effective width/height of a node.
 * Priority: measured (browser-actual) → style (user-set) → fallback.
 */
function resolveSize(node: NodeWithPosition): { w: number; h: number } {
  const m = node.measured;
  const s = node.style;

  const w =
    (typeof m?.width === 'number' ? m.width : undefined) ??
    (typeof s?.width === 'number'
      ? s.width
      : typeof s?.width === 'string'
        ? Number.parseFloat(s.width)
        : undefined) ??
    node.width ??
    150;

  const h =
    (typeof m?.height === 'number' ? m.height : undefined) ??
    (typeof s?.height === 'number'
      ? s.height
      : typeof s?.height === 'string'
        ? Number.parseFloat(s.height)
        : undefined) ??
    node.height ??
    100;

  return {
    w: Number.isFinite(w) ? w : 150,
    h: Number.isFinite(h) ? h : 100,
  };
}

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
  const { w: sw, h: sh } = resolveSize(sourceNode);
  const { w: tw, h: th } = resolveSize(targetNode);

  const sx = sourceNode.position.x;
  const sy = sourceNode.position.y;
  const tx = targetNode.position.x;
  const ty = targetNode.position.y;

  // Center-to-center deltas
  const dx = tx + tw / 2 - (sx + sw / 2);
  const dy = ty + th / 2 - (sy + sh / 2);

  // Edge-to-edge gap: positive means no overlap on that axis.
  const hGap = Math.max(tx - (sx + sw), sx - (tx + tw));
  const vGap = Math.max(ty - (sy + sh), sy - (ty + th));

  // When nodes are clearly separated on one axis but overlap on the other,
  // always route along the separated axis — this prevents tall side-by-side
  // nodes from being connected vertically just because of a y-offset.
  const clearlyHorizontal = hGap > 0 && vGap <= 0;
  const clearlyVertical = hGap <= 0 && vGap > 0;
  const useHorizontal =
    clearlyHorizontal || (!clearlyVertical && Math.abs(dx) >= Math.abs(dy));

  if (useHorizontal) {
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
  N extends NodeWithPosition,
  E extends {
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  },
>(nodes: N[], edges: E[]): E[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Resolve absolute positions so framed nodes are compared correctly
  // against nodes outside the frame (or in a different frame).
  const absPos = new Map<string, { x: number; y: number }>();
  const resolve = (nodeId: string): { x: number; y: number } | null => {
    const cached = absPos.get(nodeId);
    if (cached) return cached;
    const n = nodeMap.get(nodeId);
    if (!n) return null;
    if (!n.parentId) {
      absPos.set(nodeId, n.position);
      return n.position;
    }
    const parentAbs = resolve(n.parentId);
    if (!parentAbs) {
      absPos.set(nodeId, n.position);
      return n.position;
    }
    const abs = {
      x: parentAbs.x + n.position.x,
      y: parentAbs.y + n.position.y,
    };
    absPos.set(nodeId, abs);
    return abs;
  };

  let changed = false;
  const result = edges.map((edge) => {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) return edge;

    const sourceAbs = resolve(edge.source);
    const targetAbs = resolve(edge.target);
    if (!sourceAbs || !targetAbs) return edge;

    // Skip object spread when the position is already absolute (no parent).
    const srcNode =
      sourceAbs === source.position
        ? source
        : { ...source, position: sourceAbs };
    const tgtNode =
      targetAbs === target.position
        ? target
        : { ...target, position: targetAbs };

    const handles = getSmartHandles(srcNode, tgtNode);
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
