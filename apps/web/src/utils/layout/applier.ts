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

  // Take undo snapshot before applying changes
  canvasHistoryManager.takeSnapshot(nodes, edges);

  const newNodes = nodes.map((n) => {
    const newPos = positions.get(n.id);
    const newSize = groupSizes.get(n.id);

    if (!newPos && !newSize) return n;

    let updated = n;

    if (newPos) {
      updated = {
        ...updated,
        position: { x: newPos.x, y: newPos.y },
      };
    }

    if (newSize) {
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
