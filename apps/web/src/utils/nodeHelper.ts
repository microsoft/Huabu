/**
 * @file nodeHelper.ts
 *
 * Generic canvas-node utilities that are not specific to frames.
 */

import { getDescendantIds, type NestableNode } from './frameHelper';

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
