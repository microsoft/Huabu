// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import { getMissingFileKind } from '@/components/Nodes/missingFile';
import useCanvasStore from '@/store/canvasStore.ts';
import { useExternalImportsStore } from '@/store/externalImportsStore';
import { usePanelStore } from '@/store/panelStore';
import { openPreviewNode } from '@/store/previewWorkspace/actions';

import {
  computeCollision as computeCollisionPure,
  resolveDrop as resolveDropPure,
  type DropIntent,
  type ResolvedDrop,
} from './dropResolver';
import { focusNodesOnCanvas } from './focusNodesOnCanvas';
import { TreeRowItem } from './TreeRowItem';
import { EmptyState } from '../../Common/EmptyState';

import type { DataSourceNodeLike, DataSourceTreeItem } from './types';
import type {
  CollisionDetection,
  DragEndEvent,
  DragMoveEvent,
} from '@dnd-kit/core';

/**
 * See {@link DropIntent} in `./dropResolver` for the full intent model.
 */

/**
 * Resolved caret placement for the current drag-over. Computed from
 * the raw pointer-resolved hover (target row + raw intent) by mapping
 * it to where the dragged node would ACTUALLY land in the visual
 * list — so a caret never appears at a slot the drop would skip over.
 *
 * - `id` → the row the caret is anchored to.
 * - `intent` →
 *     - `'before'`: caret on the row's TOP edge;
 *     - `'after'`: caret on the row's BOTTOM edge;
 *     - `'into'`: NO caret on this row — used when the destination
 *       is a COLLAPSED frame (the children aren't visible so the
 *       caret would have no meaningful slot to land in). The row
 *       still renders the dashed `outline-info` frame around its
 *       pill via the same branch as `isIntoFrameHighlight`. For an
 *       EXPANDED frame the drop is encoded as `anchorIntent='after'`
 *       with `depth` bumped one level deeper, so the caret visibly
 *       sits in the new first-child slot.
 * - `depth` → indent (in tree-depth units) used to position the
 *   caret horizontally; reflects the destination parent's children
 *   depth, NOT the anchor row's own depth. Unused when intent is
 *   `'into'` (no caret).
 */
interface DropTarget {
  id: string;
  intent: DropIntent;
  depth: number;
  /**
   * When the drop will land as a child of an expanded frame, this is
   * that frame's id. The frame row gets a soft `bg-info/15` fill on
   * its pill so the caret-at-bottom (= "new first-child slot") is
   * unambiguously attributed to it — instead of reading as "after
   * this frame as a sibling". Same row as the caret for Rules 1+2;
   * the panel-previous row (parent frame) for Rule 3.
   */
  highlightFrameId?: string;
}

interface SortableRowProps {
  item: DataSourceTreeItem;
  isDirectlySelected: boolean;
  isHighlighted: boolean;
  isCollapsible: boolean;
  isCollapsed: boolean;
  isLocked: boolean;
  isDraggingDisabled: boolean;
  dropIntent: 'before' | 'after' | 'into' | null;
  dropIntentDepth: number | undefined;
  isIntoFrameHighlight: boolean;
  getIcon: (node: DataSourceNodeLike) => React.ReactNode;
  getDisplayName: (node: DataSourceNodeLike) => string;
  onSelect: (id: string, event: React.MouseEvent) => void;
  onRename: (id: string, newName: string) => Promise<boolean>;
  onToggleCollapse: (id: string) => void;
  onToggleLock: (id: string) => void;
}

const SortableRow = React.memo(
  ({
    item,
    isDirectlySelected,
    isHighlighted,
    isCollapsible,
    isCollapsed,
    isLocked,
    isDraggingDisabled,
    dropIntent,
    dropIntentDepth,
    isIntoFrameHighlight,
    getIcon,
    getDisplayName,
    onSelect,
    onRename,
    onToggleCollapse,
    onToggleLock,
  }: SortableRowProps) => {
    const { t } = useTranslation();
    const { listeners, setNodeRef, isDragging } = useSortable({
      id: item.id,
    });
    const missingFileKind = getMissingFileKind(item.node.data);
    const missingFileLabel =
      missingFileKind === 'sidecar'
        ? t('layers.nodeContentFileMissing')
        : missingFileKind === 'artifact'
          ? t('layers.nodeSourceFileMissing')
          : undefined;

    // Intentionally drop BOTH the active row's drag transform AND the
    // sibling rows' strategy transform: the dragged row stays in its
    // original slot (just dimmed via `isDragging` → `opacity 0.3` on
    // `TreeRowItem`), and the rest of the list does not "open a gap".
    // The insertion caret is the sole signal for where the drop will
    // land — matching the file-explorer style — so the user never
    // loses the dragged row from view, and the visual gap can't
    // disagree with our anchor resolver (which skips past expanded
    // frame subtrees and may land on a different slot than dnd-kit's
    // raw `over`).
    const style: React.CSSProperties = {};

    return (
      <TreeRowItem
        depth={item.depth}
        icon={getIcon(item.node)}
        label={getDisplayName(item.node)}
        isSelected={isDirectlySelected}
        isHighlighted={isHighlighted}
        isDragging={isDragging}
        missingFileLabel={missingFileLabel}
        isCollapsible={isCollapsible}
        isCollapsed={isCollapsed}
        isLocked={isLocked}
        dropIntent={dropIntent}
        dropIntentDepth={dropIntentDepth}
        isIntoFrameHighlight={isIntoFrameHighlight}
        onClick={(e) => onSelect(item.id, e)}
        editable={true}
        onRename={(newName) => onRename(item.id, newName)}
        onToggleCollapse={() => onToggleCollapse(item.id)}
        onToggleLock={() => onToggleLock(item.id)}
        // DnD plumbing - disabled if dragging is disabled
        forwardedRef={setNodeRef}
        style={style}
        dndListeners={isDraggingDisabled ? undefined : listeners}
      />
    );
  },
);
SortableRow.displayName = 'SortableRow';

export interface CanvasLayerTreeProps {
  items: DataSourceTreeItem[];
  getIcon: (node: DataSourceNodeLike) => React.ReactNode;
  getDisplayName: (node: DataSourceNodeLike) => string;
  emptyText?: string;
  /**
   * When `true`, the tree behaves as a flat search-result list:
   * - The collapsed-frame visibility filter is skipped (matches inside
   *   collapsed frames still appear).
   * - All rows are non-collapsible (chevron is hidden) since the result
   *   set is flattened to depth 0 by the parent.
   * - Drag-to-reorder is disabled — reordering a filtered subset would
   *   produce surprising z-order changes that "jump over" hidden nodes.
   */
  isFilterActive?: boolean;
}

export function shouldOpenLayerInPreview(
  isPreviewFullscreen: boolean,
  event: Pick<React.MouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>,
): boolean {
  return (
    isPreviewFullscreen && !event.shiftKey && !event.metaKey && !event.ctrlKey
  );
}

export const CanvasLayerTree = ({
  items,
  getIcon,
  getDisplayName,
  emptyText = 'No items',
  isFilterActive = false,
}: CanvasLayerTreeProps) => {
  const nodes = useCanvasStore((state) => state.nodes);
  const selectNodes = useCanvasStore((state) => state.selectNodes);
  const reorderNodes = useCanvasStore((state) => state.reorderNodes);
  const tryRename = useCanvasStore((state) => state.tryRename);
  const rfInstance = useCanvasStore((state) => state.rfInstance);
  const moveNodeIntoFrame = useCanvasStore((state) => state.moveNodeIntoFrame);
  const moveNodeOutOfFrame = useCanvasStore(
    (state) => state.moveNodeOutOfFrame,
  );
  const toggleFrameCollapse = useCanvasStore(
    (state) => state.toggleFrameCollapse,
  );
  const collapsedFrameIds = useCanvasStore((state) => state.collapsedFrameIds);
  const toggleNodeLock = useCanvasStore((state) => state.toggleNodeLock);

  const isFrameCollapsed = (frameId: string) => collapsedFrameIds.has(frameId);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // ============================================================
  // Drag state — local to the panel. `dropTarget` is recomputed on
  // every `onDragMove` tick from the pointer's position within the
  // hovered row, then mapped onto the row that should host the
  // indicator (see `resolveAnchor` in `handleDragMove` for the
  // "skip past an expanded frame's subtree" logic). It drives both
  // the indicator visuals on `TreeRowItem` and the action dispatched
  // in `onDragEnd`.
  //
  // We use `onDragMove` (not just `onDragOver`) because @dnd-kit only
  // fires `onDragOver` when `over.id` changes — so moving the pointer
  // WITHIN the same row from one ratio-zone to another (e.g. from a
  // frame row's `before` strip into its `into` middle) would otherwise
  // keep a stale `dropTarget` / cached resolve and dispatch the wrong
  // intent on release. `onDragMove` fires on every pointer tick so the
  // cache is always in sync with the current zone.
  // ============================================================
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  // Snapshot of the most recent `resolveDrop` result from
  // `onDragMove`, keyed by `activeId`. `onDragEnd` reuses this
  // instead of re-running `resolveDrop` on the release event's
  // pointer position — so the slot the user SAW under the caret is
  // exactly the slot the drop dispatches against, even if the
  // release event's collision result differs by a pixel (e.g. the
  // pointer drifted between the last `onDragMove` frame and the
  // `pointerup` event, or @dnd-kit re-measures rects on release).
  // Cleared on cancel and on every new drag (when `activeId`
  // changes).
  const lastResolvedRef = useRef<{
    activeId: string;
    resolved: ResolvedDrop;
  } | null>(null);

  // Auto-expand collapsed frames after the cursor lingers on them.
  // Mirrors the file-explorer pattern so the user can target
  // descendants without first clicking the chevron. Cancelled on every
  // `onDragMove` tick that changes the target.
  const expandTimerRef = useRef<{
    timeout: ReturnType<typeof setTimeout>;
    targetId: string;
  } | null>(null);
  const clearExpandTimer = useCallback(() => {
    if (expandTimerRef.current) {
      clearTimeout(expandTimerRef.current.timeout);
      expandTimerRef.current = null;
    }
  }, []);

  // Anchor row for Shift+click range selection. Updated on every plain
  // or Cmd/Ctrl+click; preserved across Shift+clicks so the user can
  // extend / re-extend the range from the same starting row (matches
  // Finder / VS Code behaviour). `null` until the user has clicked any
  // row in this tree session.
  const selectionAnchorRef = useRef<string | null>(null);
  useEffect(() => clearExpandTimer, [clearExpandTimer]);

  // Filter out children of collapsed frames.
  // In filter mode the parent already produced a flat result set; we
  // bypass the collapsed-frame walk entirely so a match buried inside a
  // currently-collapsed frame still surfaces in search results.
  const visibleItems = useMemo(() => {
    if (isFilterActive) return items;

    const result: DataSourceTreeItem[] = [];
    const itemMap = new Map(items.map((item) => [item.id, item]));

    for (const item of items) {
      // If this item is a child of a collapsed frame, skip it
      let parentId = item.node.parentId;
      let shouldHide = false;
      while (parentId) {
        if (collapsedFrameIds.has(parentId)) {
          shouldHide = true;
          break;
        }
        const parent = itemMap.get(parentId);
        parentId = parent?.node.parentId;
      }

      if (!shouldHide) {
        result.push(item);
      }
    }

    return result;
  }, [items, collapsedFrameIds, isFilterActive]);

  const selectedIdSet = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) if (n.selected) set.add(n.id);
    return set;
  }, [nodes]);

  const highlightedIdSet = useMemo(() => {
    const highlighted = new Set<string>(selectedIdSet);
    // Pre-index visibleItems for O(1) lookup; the previous implementation
    // called `visibleItems.find` / `indexOf` inside the per-selection loop
    // which made highlight recomputation O(N * M).
    const indexById = new Map<string, number>();
    for (let i = 0; i < visibleItems.length; i += 1) {
      indexById.set(visibleItems[i].id, i);
    }

    selectedIdSet.forEach((id) => {
      const idx = indexById.get(id);
      if (idx === undefined) return;
      const selectedItem = visibleItems[idx];
      if (
        selectedItem.node.type !== 'frame' &&
        selectedItem.node.type !== 'group'
      ) {
        return;
      }
      for (let i = idx + 1; i < visibleItems.length; i += 1) {
        if (visibleItems[i].depth > selectedItem.depth) {
          highlighted.add(visibleItems[i].id);
        } else {
          break;
        }
      }
    });
    return highlighted;
  }, [selectedIdSet, visibleItems]);

  // Pre-index items + descendant sets so the per-tick collision /
  // intent computation stays O(1). `descendantsOf` is used to forbid
  // dropping a frame INTO one of its own descendants (would create a
  // cycle in the parent chain).
  const itemById = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items],
  );
  // Visible-items lookup is used both by the drag-over caret anchor
  // resolver and (further down) by the row render to walk the parent
  // chain for `isLocked`. Kept here, near `itemById`, because
  // `handleDragOver` is defined above the row render.
  const visibleItemMap = useMemo(
    () => new Map(visibleItems.map((item) => [item.id, item])),
    [visibleItems],
  );
  const descendantsByFrameId = useMemo(() => {
    const childrenByParent = new Map<string, string[]>();
    for (const item of items) {
      const pid = item.node.parentId;
      if (!pid) continue;
      const arr = childrenByParent.get(pid) ?? [];
      arr.push(item.id);
      childrenByParent.set(pid, arr);
    }
    const out = new Map<string, Set<string>>();
    const collect = (rootId: string): Set<string> => {
      const cached = out.get(rootId);
      if (cached) return cached;
      const set = new Set<string>();
      const stack = [rootId];
      while (stack.length > 0) {
        const id = stack.pop() as string;
        const kids = childrenByParent.get(id);
        if (!kids) continue;
        for (const kid of kids) {
          if (!set.has(kid)) {
            set.add(kid);
            stack.push(kid);
          }
        }
      }
      out.set(rootId, set);
      return set;
    };
    for (const item of items) {
      if (item.node.type === 'frame' || item.node.type === 'group') {
        collect(item.id);
      }
    }
    return out;
  }, [items]);

  /**
   * dnd-kit adapter around the pure {@link computeCollisionPure} —
   * extracts `pointerY` + per-candidate rect data from the dnd-kit
   * event shape, runs the zone rules (see `./dropResolver`), and
   * wraps the result back into dnd-kit's `Collision[]` format with
   * the `DropIntent` encoded in `data.intent`.
   */
  const collisionDetection: CollisionDetection = useCallback(
    ({ pointerCoordinates, droppableContainers, droppableRects, active }) => {
      if (!pointerCoordinates) return [];
      const candidates = [];
      for (const c of droppableContainers) {
        const rect = droppableRects.get(c.id);
        if (!rect) continue;
        candidates.push({
          id: c.id as string,
          top: rect.top,
          height: rect.height,
        });
      }
      const out = computeCollisionPure({
        pointerY: pointerCoordinates.y,
        activeId: active.id as string,
        candidates,
        visibleItems,
        itemById,
        descendantsByFrameId,
        collapsedFrameIds,
      });
      if (!out) return [];
      return [{ id: out.id, data: { intent: out.intent } }];
    },
    [collapsedFrameIds, descendantsByFrameId, itemById, visibleItems],
  );

  /**
   * Unified resolver for both the drag-over indicator AND the
   * drop dispatch. Maps the raw collision result `(overId, rawIntent)`
   * onto:
   *   - the row+intent the INDICATOR should be drawn on (`anchorId`,
   *     `anchorIntent`, `anchorDepth`);
   *   - the row+intent the DROP action should be dispatched against
   *     (`effectiveOverId`, `effectiveIntent`).
   *
   * `handleDragOver` reads the anchor fields; `handleDragEnd` reads
   * the effective fields. Sharing this resolver guarantees that the
   * caret / highlight the user sees is exactly the slot the drop
   * will land in — no more "caret outside the frame but drop lands
   * inside" mismatches.
   *
   * Rules (in order):
   *
   *   1. `'into'` over a frame / group → drop as first child of the
   *      frame. Indicator: COLLAPSED frame → soft-fill on the frame
   *      row's pill (caret would have nowhere meaningful to sit since
   *      the children aren't visible). EXPANDED frame → caret on the
   *      bottom edge of the frame row, indented to child depth (it
   *      visually sits in the slot the new first child will occupy).
   *      Expanded frames have no `after` zone in `collisionDetection`
   *      (its semantic collides with the next visible child row's
   *      `before` edge), so we don't need a separate rule for it.
   *
   *   2. `'after'` over a NON-container row that is the panel-bottom
   *      direct child of its parent frame → drop as sibling-below
   *      the parent frame (escape one nesting level). Indicator:
   *      caret on this row's BOTTOM edge but indented to the parent
   *      frame's depth, so the caret reads as "outside parent frame
   *      at sibling level". If the parent frame itself sits inside
   *      a grandparent frame, the grandparent gets the destination
   *      highlight.
   *
   *   3. Default → pass through: indicator on `overId` at its own
   *      depth, drop dispatched against `overId` with `rawIntent`.
   *      If `overId` sits inside a frame, that parent frame gets
   *      the destination highlight (caret on the child row + fill
   *      on the parent reads as "inside this frame, between these
   *      two children").
   */
  /**
   * Adapter around the pure {@link resolveDropPure}. Closes over
   * the panel's current `itemById` / `visibleItemMap` /
   * `visibleItems` / `collapsedFrameIds` so call sites can pass
   * just `(overId, rawIntent)`.
   *
   * See `./dropResolver` for the rules.
   */
  const resolveDrop = useCallback(
    (_activeId: string, overId: string, rawIntent: DropIntent): ResolvedDrop =>
      resolveDropPure({
        overId,
        rawIntent,
        itemById,
        visibleItemMap,
        visibleItems,
        collapsedFrameIds,
      }),
    [collapsedFrameIds, itemById, visibleItemMap, visibleItems],
  );

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      const activeId = event.active.id as string;
      const overId = event.over?.id as string | undefined;
      const rawIntent = (
        event.collisions?.[0]?.data as { intent?: DropIntent } | undefined
      )?.intent;
      if (!overId || !rawIntent) {
        setDropTarget(null);
        lastResolvedRef.current = null;
        clearExpandTimer();
        return;
      }

      const resolved = resolveDrop(activeId, overId, rawIntent);
      lastResolvedRef.current = { activeId, resolved };
      setDropTarget((prev) =>
        prev &&
        prev.id === resolved.anchorId &&
        prev.intent === resolved.anchorIntent &&
        prev.depth === resolved.anchorDepth &&
        prev.highlightFrameId === resolved.intoHighlightId
          ? prev
          : {
              id: resolved.anchorId,
              intent: resolved.anchorIntent,
              depth: resolved.anchorDepth,
              highlightFrameId: resolved.intoHighlightId,
            },
      );

      // Auto-expand: hover for 350ms over a collapsed frame with raw
      // `'into'` intent → expand so the user can drop on its children.
      // Cancel as soon as the target / intent changes.
      const overItem = visibleItemMap.get(overId);
      const shouldArm =
        overItem &&
        (overItem.node.type === 'frame' || overItem.node.type === 'group') &&
        rawIntent === 'into' &&
        collapsedFrameIds.has(overId);
      if (!shouldArm) {
        clearExpandTimer();
        return;
      }
      if (expandTimerRef.current?.targetId === overId) return;
      clearExpandTimer();
      const tid = setTimeout(() => {
        toggleFrameCollapse(overId);
        expandTimerRef.current = null;
      }, 350);
      expandTimerRef.current = { timeout: tid, targetId: overId };
    },
    [
      clearExpandTimer,
      collapsedFrameIds,
      resolveDrop,
      toggleFrameCollapse,
      visibleItemMap,
    ],
  );

  const handleDragCancel = useCallback(() => {
    setDropTarget(null);
    lastResolvedRef.current = null;
    clearExpandTimer();
  }, [clearExpandTimer]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDropTarget(null);
      clearExpandTimer();

      const { active, over } = event;
      if (!over) {
        lastResolvedRef.current = null;
        return;
      }

      const activeId = active.id as string;
      const rawOverId = over.id as string;
      if (activeId === rawOverId) {
        lastResolvedRef.current = null;
        return;
      }

      const rawIntent = (
        event.collisions?.[0]?.data as { intent?: DropIntent } | undefined
      )?.intent;
      if (!rawIntent) {
        lastResolvedRef.current = null;
        return;
      }

      // Prefer the snapshot from the last `onDragOver` tick: the
      // slot the user SAW under the caret at the moment they decided
      // to release. Re-running `resolveDrop` here on the release
      // event's (potentially slightly different) pointer can flip
      // the rule — e.g. a sub-pixel drift across the frame top/middle
      // boundary would silently turn "above the frame" into "first
      // child of the frame". Fall back to a fresh resolve only if the
      // snapshot is missing or stale (different `activeId`).
      const cached = lastResolvedRef.current;
      const resolved =
        cached && cached.activeId === activeId
          ? cached.resolved
          : resolveDrop(activeId, rawOverId, rawIntent);
      lastResolvedRef.current = null;
      const { effectiveOverId, effectiveIntent } = resolved;
      if (activeId === effectiveOverId) return;

      const activeItem = itemById.get(activeId);
      const targetItem = itemById.get(effectiveOverId);
      if (!activeItem || !targetItem) return;

      const activeParentId = activeItem.node.parentId ?? null;

      // `into` → make `activeId` a child of the target frame, placed
      // as the topmost visible (top-of-panel) child. The tree is built
      // by DFS in reverse-children order so the FIRST item in `items`
      // whose parent matches the target is its highest-z (last-in-
      // array) child. Inserting AFTER that child in the nodes array
      // makes the new node the very last entry → the new top of the
      // visual list. If the frame is empty we pass no reorderTarget
      // and let the store decide the default placement.
      if (effectiveIntent === 'into') {
        const topmostChild = items.find(
          (i) => i.node.parentId === effectiveOverId && i.id !== activeId,
        );
        moveNodeIntoFrame(
          activeId,
          effectiveOverId,
          topmostChild
            ? { nodeId: topmostChild.id, position: 'after' }
            : undefined,
        );
        return;
      }

      // `before` / `after` → place `activeId` adjacent to the target
      // row. If the target's parent differs from the active's parent
      // this is also a hierarchy change (move-into / move-out).
      //
      // Visual ↔ array axis flip: the panel renders nodes in REVERSE
      // array order (top of panel = higher z = later in `nodes`), so a
      // pointer in the TOP zone of the target (visual `before`) means
      // the user wants the dragged node ABOVE the target visually =
      // HIGHER z = AFTER the target in the nodes array, and vice versa.
      const position: 'before' | 'after' =
        effectiveIntent === 'before' ? 'after' : 'before';
      const targetParentId = targetItem.node.parentId ?? null;

      if (targetParentId === activeParentId) {
        reorderNodes(activeId, effectiveOverId, position);
        return;
      }

      if (targetParentId === null) {
        // Move out of the current frame and land next to the target
        // top-level row.
        moveNodeOutOfFrame(activeId, {
          nodeId: effectiveOverId,
          position,
        });
        return;
      }

      // Move into the target's frame at this slot.
      moveNodeIntoFrame(activeId, targetParentId, {
        nodeId: effectiveOverId,
        position,
      });
    },
    [
      clearExpandTimer,
      items,
      itemById,
      moveNodeIntoFrame,
      moveNodeOutOfFrame,
      reorderNodes,
      resolveDrop,
    ],
  );

  // Stable handlers — these read fresh state from the store inside the
  // callback (rather than closing over `selectedIdSet`, which changes
  // every selection) so they retain identity across renders. That keeps
  // `SortableRow`'s `React.memo` valid for unchanged rows.
  const handleSelect = useCallback(
    (id: string, event: React.MouseEvent) => {
      event.stopPropagation();
      if (
        shouldOpenLayerInPreview(
          usePanelStore.getState().isPreviewFullscreen,
          event,
        )
      ) {
        openPreviewNode(id);
        selectionAnchorRef.current = id;
        return;
      }
      const isShift = event.shiftKey;
      const isMulti = event.metaKey || event.ctrlKey;

      // Snapshot the selection BEFORE dispatching so toggle / range math
      // operates on the pre-update set (matches the original semantics).
      const snapshot = useCanvasStore.getState();
      const currentSelected: string[] = [];
      for (const n of snapshot.nodes)
        if (n.selected) currentSelected.push(n.id);

      let targetIds: string[];
      let nextAnchor: string;

      if (isShift && selectionAnchorRef.current) {
        // Shift+click: extend a contiguous range from the anchor to the
        // just-clicked row in VISIBLE order (so collapsed-frame
        // descendants are skipped — matches Finder / VS Code). The
        // anchor itself is preserved so the user can re-extend the
        // range from the same starting point.
        const anchor = selectionAnchorRef.current;
        const anchorIdx = visibleItems.findIndex((v) => v.id === anchor);
        const clickIdx = visibleItems.findIndex((v) => v.id === id);
        if (anchorIdx === -1 || clickIdx === -1) {
          // Anchor went off-screen (collapsed away / filtered) — fall
          // back to a plain single-select and reset the anchor.
          targetIds = [id];
          nextAnchor = id;
        } else {
          const [lo, hi] =
            anchorIdx <= clickIdx
              ? [anchorIdx, clickIdx]
              : [clickIdx, anchorIdx];
          const rangeIds = visibleItems.slice(lo, hi + 1).map((v) => v.id);
          if (isMulti) {
            // Shift+Cmd/Ctrl: add the range to the existing selection
            // (additive extend, doesn't clear previously selected rows
            // outside the range).
            const merged = new Set(currentSelected);
            for (const rid of rangeIds) merged.add(rid);
            targetIds = Array.from(merged);
          } else {
            // Plain Shift: replace selection with the range.
            targetIds = rangeIds;
          }
          nextAnchor = anchor;
        }
      } else if (isMulti) {
        // Cmd/Ctrl+click: toggle this row in/out of the selection.
        if (currentSelected.includes(id)) {
          targetIds = currentSelected.filter((sid) => sid !== id);
        } else {
          targetIds = [...currentSelected, id];
        }
        nextAnchor = id;
      } else {
        // Plain click: select just this row.
        targetIds = [id];
        nextAnchor = id;
      }

      // Dispatch with the explicit final selection (replace mode), so
      // the resolver doesn't re-apply toggle semantics on top of our
      // already-computed set.
      selectNodes(targetIds, false);
      selectionAnchorRef.current = nextAnchor;

      // Re-center the canvas on the just-selected node(s). See
      // `focusNodesOnCanvas` for why we don't use `rfInstance.fitView`
      // here — short version: `onlyRenderVisibleElements` leaves
      // offscreen nodes unmeasured, and `fitView` silently no-ops on
      // them. The helper falls back to `style.width|height` and uses
      // `setCenter` directly.
      if (rfInstance && targetIds.length > 0) {
        focusNodesOnCanvas(rfInstance, targetIds, 800);
      }
    },
    [selectNodes, rfInstance, visibleItems],
  );

  const handleRename = useCallback(
    (id: string, newName: string) => {
      return tryRename('node', id, newName);
    },
    [tryRename],
  );

  const handleToggleCollapse = useCallback(
    (id: string) => {
      toggleFrameCollapse(id);
    },
    [toggleFrameCollapse],
  );

  const handleToggleLock = useCallback(
    (id: string) => {
      toggleNodeLock(id);
    },
    [toggleNodeLock],
  );

  const { externalItems, sortableItems } = useMemo(() => {
    const ext: DataSourceTreeItem[] = [];
    const sort: DataSourceTreeItem[] = [];
    for (const item of visibleItems) {
      if (item.externalRelativePath) ext.push(item);
      else sort.push(item);
    }
    return { externalItems: ext, sortableItems: sort };
  }, [visibleItems]);

  const sortableIds = useMemo(
    () => sortableItems.map((i) => i.id),
    [sortableItems],
  );

  const importExternal = useExternalImportsStore((s) => s.importItem);
  const externalByPath = useExternalImportsStore((s) => s.pending);

  const handleImport = useCallback(
    (relativePath: string) => {
      const item = externalByPath.find((i) => i.relativePath === relativePath);
      if (item) void importExternal(item);
    },
    [externalByPath, importExternal],
  );

  // Build lookup map once for efficient parent-chain traversal
  // (defined above, near `itemById`, so the drag-over anchor resolver
  // can use it).

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragOver={handleDragMove}
      onDragMove={handleDragMove}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      <div className="overflow-hidden">
        <div className="flex flex-col py-1">
          <SortableContext
            items={sortableIds}
            strategy={verticalListSortingStrategy}
          >
            {sortableItems.map((item) => {
              // Filter mode flattens the list to depth 0 and renders a
              // pure result set, so chevrons / drag are both meaningless
              // and confusing — we force them off here.
              const isCollapsible =
                !isFilterActive &&
                (item.node.type === 'frame' || item.node.type === 'group');
              const isCollapsed = isFrameCollapsed(item.id);
              const isSelfLocked = Boolean(item.node.data?.locked);

              // Check if this node is inside a locked frame
              let isParentLocked = false;
              let parentId = item.node.parentId;
              while (parentId) {
                const parent = visibleItemMap.get(parentId);
                if (parent && Boolean(parent.node.data?.locked)) {
                  isParentLocked = true;
                  break;
                }
                parentId = parent?.node.parentId;
              }

              const isLocked = isSelfLocked || isParentLocked;
              const isDraggingDisabled = isParentLocked || isFilterActive;
              const isDropAnchor = dropTarget?.id === item.id;
              const rowDropIntent = isDropAnchor ? dropTarget.intent : null;
              const rowDropIntentDepth = isDropAnchor
                ? dropTarget.depth
                : undefined;
              const isIntoFrameHighlight =
                dropTarget?.highlightFrameId === item.id;

              return (
                <SortableRow
                  key={item.id}
                  item={item}
                  isDirectlySelected={selectedIdSet.has(item.id)}
                  isHighlighted={highlightedIdSet.has(item.id)}
                  isCollapsible={isCollapsible}
                  isCollapsed={isCollapsed}
                  isLocked={isLocked}
                  isDraggingDisabled={isDraggingDisabled}
                  dropIntent={rowDropIntent}
                  dropIntentDepth={rowDropIntentDepth}
                  isIntoFrameHighlight={isIntoFrameHighlight}
                  getIcon={getIcon}
                  getDisplayName={getDisplayName}
                  onSelect={handleSelect}
                  onRename={handleRename}
                  onToggleCollapse={handleToggleCollapse}
                  onToggleLock={handleToggleLock}
                />
              );
            })}
          </SortableContext>

          {externalItems.map((item) => {
            const relativePath = item.externalRelativePath ?? '';
            return (
              <TreeRowItem
                key={item.id}
                depth={0}
                icon={getIcon(item.node)}
                label={getDisplayName(item.node)}
                isExternal
                onImport={() => handleImport(relativePath)}
              />
            );
          })}

          {visibleItems.length === 0 && (
            <EmptyState message={emptyText} className="px-3 py-2" />
          )}
        </div>
      </div>
    </DndContext>
  );
};
