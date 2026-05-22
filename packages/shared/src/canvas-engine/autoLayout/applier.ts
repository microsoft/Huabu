/**
 * @file PositionApplier — maps layout results onto a canvas nodes array.
 *
 * Responsibilities:
 *  - Batch-update node positions
 *  - Update frame sizes from groupSizes
 *
 * Intentionally has no dependency on the canvas store or history manager.
 * Callers are responsible for taking an undo snapshot before invoking this.
 */

import { snapToGrid } from '../utils/constants.js';

import type { LayoutResult } from './types.js';
import type { Node } from '@xyflow/react';

/**
 * Apply layout results to the canvas by producing a new nodes array.
 *
 * Pure transformation — does NOT mutate state or take undo snapshots.
 * Callers should call `beginGesture` or ensure snapshot policy is set
 * in `COMMAND_META` when the operation needs to be undoable.
 *
 * Returns the new nodes array, or null if no changes were needed.
 */
export function applyLayoutResult(
  nodes: Node[],
  result: LayoutResult,
): Node[] | null {
  const { positions, groupSizes } = result;

  if (positions.size === 0 && groupSizes.size === 0) return null;

  // Pre-compute locked node IDs only for the size guard — locked frames must
  // not be resized by the layout engine.
  // Position write-back is NOT guarded here: the solver already marks locked
  // nodes as fixed so their output positions are unchanged; enforcing a second
  // guard here would skip necessary ReactFlow position flushes and cause
  // overlaps when adjacent nodes move.
  const lockedNodeIds = new Set<string>(
    nodes
      .filter((n) =>
        Boolean((n.data as Record<string, unknown> | undefined)?.locked),
      )
      .map((n) => n.id),
  );

  const newNodes = nodes.map((n) => {
    const newPos = positions.get(n.id);
    const newSize = groupSizes.get(n.id);

    if (!newPos && !newSize) return n;

    let updated = n;

    if (newPos) {
      updated = {
        ...updated,
        position: { x: snapToGrid(newPos.x), y: snapToGrid(newPos.y) },
      };
    }

    // Never resize a locked node.
    if (newSize && !lockedNodeIds.has(n.id)) {
      updated = {
        ...updated,
        style: {
          ...(updated.style ?? {}),
          width: newSize.width,
          height: newSize.height,
        },
      };
    }

    return updated;
  });

  return newNodes;
}
