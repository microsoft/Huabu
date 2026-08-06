// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Pure drop-intent resolution for the layer panel's DnD layer.
 *
 * Extracted from `CanvasLayerTree` so the rules — which are subtle
 * (panel-edge zone collapse, expanded-vs-collapsed frame asymmetry,
 * escape-leaf-from-frame, descendant-cycle rejection) — can be
 * unit-tested without spinning up the full panel + dnd-kit machinery.
 *
 * The functions here are framework-agnostic: they take plain
 * arrays / maps / sets and return plain data. `CanvasLayerTree`
 * wraps them in `useCallback` and adapts dnd-kit's
 * `collisionDetection` / `onDragMove` signatures to call them.
 */

import type { DataSourceTreeItem } from './types';

/**
 * Layer-panel drop intent computed from the pointer position within
 * the hovered row. Drives both the indicator visuals on
 * `TreeRowItem` and the move/reorder action dispatched on drop.
 *
 *  - `'before' | 'after'` → drop in the slot above / below this row.
 *    If the row's parent differs from the dragged node's parent the
 *    drop changes hierarchy (move-into / move-out); otherwise it is a
 *    pure reorder at the same level.
 *  - `'into'` → drop INTO this row (only meaningful when the row is a
 *    frame / group). Adds the dragged node as the topmost visible
 *    child of that frame.
 */
export type DropIntent = 'before' | 'after' | 'into';

/**
 * Candidate row for {@link computeCollision}. Built from dnd-kit's
 * `droppableContainers` + `droppableRects`; this module only needs
 * the id and the row's vertical extent.
 */
export interface CollisionCandidate {
  id: string;
  top: number;
  height: number;
}

export interface CollisionInput {
  /** Pointer Y in the same coordinate space as `candidates[].top`. */
  pointerY: number;
  /** Id of the row being dragged — excluded from candidate set. */
  activeId: string;
  candidates: readonly CollisionCandidate[];
  /**
   * Visible-row order used for panel-edge detection. The first and
   * last entries get special zone rules (see {@link computeCollision}).
   */
  visibleItems: readonly DataSourceTreeItem[];
  itemById: ReadonlyMap<string, DataSourceTreeItem>;
  /** All transitive descendant ids per frame/group id. Used for cycle prevention. */
  descendantsByFrameId: ReadonlyMap<string, ReadonlySet<string>>;
  collapsedFrameIds: ReadonlySet<string>;
}

/**
 * Pick the row whose vertical range contains the pointer (falling
 * back to nearest-by-center when the pointer is above the first /
 * below the last row), and encode the drop intent based on the
 * pointer's position WITHIN the row.
 *
 * Returns `null` only when there are no eligible candidates.
 *
 * Layout zones inside the row:
 *  - frame / group target (middle row): top 15% = before, middle
 *    70% = into, bottom 15% = after. `into` dominates so dropping
 *    INTO a frame just needs to hover anywhere over the row body.
 *  - non-container target: top 50% = before, bottom 50% = after.
 *  - PANEL-FIRST frame row: top 30% = before, bottom 70% = into,
 *    no `after`. Removes the panel-top-vs-into UX collision: the
 *    `after` slot is reachable by the next row's top edge.
 *  - PANEL-LAST frame row: symmetric (top 70% = into, bottom 30% =
 *    after, no `before`). EXPANDED panel-last frame keeps no
 *    `after` either (collides with the first visible child below).
 *  - ONLY frame row (panel-first AND panel-last): 25% before /
 *    50% into / 25% after — all three intents reachable.
 *  - PANEL-FIRST non-container row: ENTIRE row = before.
 *  - PANEL-LAST non-container row: ENTIRE row = after.
 *
 * `into` is suppressed when the candidate target is the active node
 * itself or any of its descendants (would create a parent cycle), in
 * which case the zone collapses to the simple before / after split.
 */
export function computeCollision(
  input: CollisionInput,
): { id: string; intent: DropIntent } | null {
  const {
    pointerY,
    activeId,
    candidates,
    visibleItems,
    itemById,
    descendantsByFrameId,
    collapsedFrameIds,
  } = input;

  const activeDescendants = descendantsByFrameId.get(activeId);

  let bestId: string | null = null;
  let bestRect: { top: number; height: number } | null = null;
  let bestContainsExact = false;
  let bestDist = Infinity;

  for (const c of candidates) {
    if (c.id === activeId) continue;
    const top = c.top;
    const bottom = top + c.height;
    const contains = pointerY >= top && pointerY <= bottom;
    const center = top + c.height / 2;
    const dist = Math.abs(pointerY - center);
    if (contains && !bestContainsExact) {
      bestId = c.id;
      bestRect = { top, height: c.height };
      bestContainsExact = true;
      bestDist = dist;
      continue;
    }
    if (contains && dist < bestDist) {
      bestId = c.id;
      bestRect = { top, height: c.height };
      bestDist = dist;
      continue;
    }
    if (!bestContainsExact && dist < bestDist) {
      bestId = c.id;
      bestRect = { top, height: c.height };
      bestDist = dist;
    }
  }

  if (!bestId || !bestRect) return null;

  const target = itemById.get(bestId);
  const isContainer =
    target?.node.type === 'frame' || target?.node.type === 'group';
  const canDropInto =
    isContainer &&
    bestId !== activeId &&
    !(activeDescendants && activeDescendants.has(bestId));

  const ratio = Math.min(
    1,
    Math.max(0, (pointerY - bestRect.top) / bestRect.height),
  );

  let intent: DropIntent;
  if (canDropInto) {
    const overIdx = visibleItems.findIndex((v) => v.id === bestId);
    const isPanelFirst = overIdx === 0;
    const isPanelLast = overIdx === visibleItems.length - 1;
    const isOnlyRow = isPanelFirst && isPanelLast;
    const isExpandedFrame = !collapsedFrameIds.has(bestId);
    let beforeMax: number;
    let afterMin: number;
    if (isOnlyRow) {
      beforeMax = 0.25;
      afterMin = isExpandedFrame ? 1.1 : 0.75;
    } else if (isPanelFirst) {
      beforeMax = 0.3;
      afterMin = 1.1;
    } else if (isPanelLast) {
      beforeMax = -0.1;
      afterMin = isExpandedFrame ? 1.1 : 0.7;
    } else {
      beforeMax = 0.15;
      afterMin = isExpandedFrame ? 1.1 : 0.85;
    }
    if (ratio < beforeMax) intent = 'before';
    else if (ratio > afterMin) intent = 'after';
    else intent = 'into';
  } else {
    const overIdx = visibleItems.findIndex((v) => v.id === bestId);
    const isPanelFirst = overIdx === 0;
    const isPanelLast = overIdx === visibleItems.length - 1;
    const cutoff =
      isPanelFirst && !isPanelLast
        ? 1.1
        : isPanelLast && !isPanelFirst
          ? -0.1
          : 0.5;
    intent = ratio < cutoff ? 'before' : 'after';
  }

  return { id: bestId, intent };
}

/**
 * Resolved drop placement, computed from a raw collision result.
 *
 * `anchor*` fields drive the indicator visuals (caret position).
 * `effective*` fields drive the action dispatched on drop.
 *
 * Sharing one resolver between the drag-over indicator and the
 * drop dispatch guarantees that the caret the user sees is the
 * slot the drop actually lands in.
 */
export interface ResolvedDrop {
  anchorId: string;
  anchorIntent: DropIntent;
  anchorDepth: number;
  effectiveOverId: string;
  effectiveIntent: DropIntent;
  /**
   * Optional. Set when the drop lands as a child of a frame /
   * group. The row with this id gets a soft fill + dashed outline
   * so the destination frame is unambiguous regardless of where
   * the caret is drawn.
   */
  intoHighlightId?: string;
}

export interface ResolveInput {
  overId: string;
  rawIntent: DropIntent;
  itemById: ReadonlyMap<string, DataSourceTreeItem>;
  visibleItemMap: ReadonlyMap<string, DataSourceTreeItem>;
  visibleItems: readonly DataSourceTreeItem[];
  collapsedFrameIds: ReadonlySet<string>;
}

/**
 * Map a raw collision result `(overId, rawIntent)` onto the
 * resolved {@link ResolvedDrop}.
 *
 * Rules (in order):
 *
 *   1. `'into'` over a frame / group → drop as first child of the
 *      frame. EXPANDED frame → caret at frame row's bottom edge,
 *      indented to child depth. COLLAPSED frame → no caret, soft
 *      fill on the frame row is the sole drop signal.
 *
 *   2. `'after'` over a NON-container row that is the panel-bottom
 *      direct child of its parent frame → drop as sibling-below
 *      the parent frame (escape one nesting level). Caret indents
 *      to parent frame's depth; grandparent (if a frame) gets
 *      destination highlight.
 *
 *   3. Default → pass through. If `overId` sits inside a frame,
 *      that parent frame gets the destination highlight.
 */
export function resolveDrop(input: ResolveInput): ResolvedDrop {
  const {
    overId,
    rawIntent,
    itemById,
    visibleItemMap,
    visibleItems,
    collapsedFrameIds,
  } = input;

  const overItem = visibleItemMap.get(overId);
  if (!overItem) {
    return {
      anchorId: overId,
      anchorIntent: rawIntent,
      anchorDepth: 0,
      effectiveOverId: overId,
      effectiveIntent: rawIntent,
    };
  }

  const isContainer =
    overItem.node.type === 'frame' || overItem.node.type === 'group';
  const isExpandedContainer = isContainer && !collapsedFrameIds.has(overId);

  // Rule 1
  if (rawIntent === 'into' && isContainer) {
    return {
      anchorId: overId,
      anchorIntent: isExpandedContainer ? 'after' : 'into',
      anchorDepth: isExpandedContainer ? overItem.depth + 1 : overItem.depth,
      effectiveOverId: overId,
      effectiveIntent: 'into',
      intoHighlightId: overId,
    };
  }

  // Rule 2
  if (rawIntent === 'after' && !isContainer && overItem.node.parentId) {
    const parent = itemById.get(overItem.node.parentId);
    if (
      parent &&
      (parent.node.type === 'frame' || parent.node.type === 'group')
    ) {
      const overIdx = visibleItems.findIndex((v) => v.id === overId);
      const next = visibleItems[overIdx + 1];
      const isPanelBottom =
        !next ||
        next.depth < overItem.depth ||
        next.node.parentId !== overItem.node.parentId;
      if (isPanelBottom) {
        let grandparentHighlight: string | undefined;
        const grandparentId = parent.node.parentId;
        if (grandparentId) {
          const grandparent = itemById.get(grandparentId);
          if (
            grandparent &&
            (grandparent.node.type === 'frame' ||
              grandparent.node.type === 'group')
          ) {
            grandparentHighlight = grandparentId;
          }
        }
        return {
          anchorId: overId,
          anchorIntent: 'after',
          anchorDepth: parent.depth,
          effectiveOverId: parent.id,
          effectiveIntent: 'after',
          intoHighlightId: grandparentHighlight,
        };
      }
    }
  }

  // Rule 3 (default)
  let defaultHighlight: string | undefined;
  const parentId = overItem.node.parentId;
  if (parentId) {
    const parentItem = itemById.get(parentId);
    if (
      parentItem &&
      (parentItem.node.type === 'frame' || parentItem.node.type === 'group')
    ) {
      defaultHighlight = parentId;
    }
  }
  return {
    anchorId: overId,
    anchorIntent: rawIntent,
    anchorDepth: overItem.depth,
    effectiveOverId: overId,
    effectiveIntent: rawIntent,
    intoHighlightId: defaultHighlight,
  };
}
