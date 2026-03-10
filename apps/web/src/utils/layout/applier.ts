/**
 * @file PositionApplier — writes layout results back to the canvas store.
 *
 * Responsibilities:
 *  - Batch-update node positions
 *  - Update frame sizes from groupSizes
 *  - Wrap the operation as a single undo history entry
 */

import { canvasHistoryManager } from '../../store/canvasHistoryManager';

import type { LayoutResult } from './types';
import type { Node, Edge } from '@xyflow/react';

export interface ApplyOptions {
  /** Whether to animate the transition (not yet implemented). */
  animate?: boolean;
}

/**
 * Apply layout results to the canvas by producing a new nodes array.
 *
 * Takes a snapshot for undo before mutating.
 * Returns the new nodes array, or null if no changes were needed.
 */
export function applyLayoutResult(
  nodes: Node[],
  edges: Edge[],
  result: LayoutResult,
  _options: ApplyOptions = {},
): Node[] | null {
  const { positions, groupSizes } = result;

  if (positions.size === 0 && groupSizes.size === 0) return null;

  // Pre-compute locked node IDs and locked frame IDs.
  // This is the authoritative write-back guard — the solver hints (fixed flags)
  // may not be perfectly honoured by every solver backend (e.g. Cola).
  const lockedNodeIds = new Set<string>(
    nodes
      .filter((n) =>
        Boolean((n.data as Record<string, unknown> | undefined)?.locked),
      )
      .map((n) => n.id),
  );
  const lockedFrameIds = new Set<string>(
    nodes
      .filter((n) => n.type === 'frame' && lockedNodeIds.has(n.id))
      .map((n) => n.id),
  );

  // Take undo snapshot before applying changes
  canvasHistoryManager.takeSnapshot(nodes, edges);

  const newNodes = nodes.map((n) => {
    const newPos = positions.get(n.id);
    const newSize = groupSizes.get(n.id);

    if (!newPos && !newSize) return n;

    // Never reposition a locked node (any type) or children of a locked frame.
    const isLocked =
      lockedNodeIds.has(n.id) ||
      (n.parentId !== undefined &&
        n.parentId !== null &&
        lockedFrameIds.has(n.parentId));

    let updated = n;

    if (newPos && !isLocked) {
      updated = {
        ...updated,
        position: { x: newPos.x, y: newPos.y },
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
