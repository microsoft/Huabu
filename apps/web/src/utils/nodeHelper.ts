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
 * - The node itself becomes non-draggable and non-selectable on the canvas
 *   (Figma-like: the node is invisible to pointer / marquee selection).
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
    // The locked node itself: set draggable/selectable so ReactFlow respects it.
    if (n.id === nodeId) {
      if (nextLocked) {
        return {
          ...n,
          draggable: false,
          selectable: false,
          data: { ...(n.data ?? {}), locked: true },
        };
      }
      // Unlock: restore defaults (ReactFlow treats undefined as true).
      const { draggable: _d, selectable: _s, ...rest } = n;
      void _d;
      void _s;
      return {
        ...rest,
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
