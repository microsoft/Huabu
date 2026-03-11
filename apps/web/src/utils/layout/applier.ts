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
  /** Whether to animate node position and size transitions. */
  animate?: boolean;
}

/** CSS transition injected when animate=true. Cleared by the store after the duration. */
export const LAYOUT_ANIMATION_TRANSITION =
  'transform 350ms cubic-bezier(0.4, 0, 0.2, 1), width 350ms cubic-bezier(0.4, 0, 0.2, 1), height 350ms cubic-bezier(0.4, 0, 0.2, 1)';

/** Duration (ms) matching the transition above — used by callers for cleanup. */
export const LAYOUT_ANIMATION_DURATION_MS = 400;

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
  options: ApplyOptions = {},
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

  // Take undo snapshot before applying changes
  canvasHistoryManager.takeSnapshot(nodes, edges);

  const { animate } = options;

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

    // Inject CSS transition so ReactFlow's DOM update animates smoothly.
    if (animate) {
      updated = {
        ...updated,
        style: {
          ...(updated.style ?? {}),
          transition: LAYOUT_ANIMATION_TRANSITION,
        },
      };
    }

    return updated;
  });

  return newNodes;
}
