import {
  DndContext,
  closestCenter,
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
import { CSS } from '@dnd-kit/utilities';
import React, { useCallback, useMemo } from 'react';

import useCanvasStore from '@/store/canvasStore.ts';

import { TreeRowItem } from './TreeRowItem';
import { EmptyState } from '../../Common/EmptyState';

import type { DataSourceNodeLike, DataSourceTreeItem } from './types';
import type { DragEndEvent } from '@dnd-kit/core';

interface SortableRowProps {
  item: DataSourceTreeItem;
  isDirectlySelected: boolean;
  isHighlighted: boolean;
  isCollapsible: boolean;
  isCollapsed: boolean;
  isLocked: boolean;
  isDraggingDisabled: boolean;
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
    getIcon,
    getDisplayName,
    onSelect,
    onRename,
    onToggleCollapse,
    onToggleLock,
  }: SortableRowProps) => {
    const {
      attributes,
      listeners,
      setNodeRef,
      transform,
      transition,
      isDragging,
    } = useSortable({ id: item.id });

    const style: React.CSSProperties = {
      transform: CSS.Translate.toString(transform),
      transition,
    };

    return (
      <TreeRowItem
        depth={item.depth}
        icon={getIcon(item.node)}
        label={getDisplayName(item.node)}
        isSelected={isDirectlySelected}
        isHighlighted={isHighlighted}
        isDragging={isDragging}
        isCollapsible={isCollapsible}
        isCollapsed={isCollapsed}
        isLocked={isLocked}
        onClick={(e) => onSelect(item.id, e)}
        editable={true}
        onRename={(newName) => onRename(item.id, newName)}
        onToggleCollapse={() => onToggleCollapse(item.id)}
        onToggleLock={() => onToggleLock(item.id)}
        // DnD plumbing - disabled if dragging is disabled
        forwardedRef={setNodeRef}
        style={style}
        dndAttributes={isDraggingDisabled ? undefined : attributes}
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
}

export const CanvasLayerTree = ({
  items,
  getIcon,
  getDisplayName,
  emptyText = 'No items',
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

  // Filter out children of collapsed frames
  const visibleItems = useMemo(() => {
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
  }, [items, collapsedFrameIds]);

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

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const activeId = active.id as string;
      const overId = over.id as string;

      // Find the target node to check if it's a frame
      const targetItem = items.find((item) => item.id === overId);
      const activeItem = items.find((item) => item.id === activeId);

      if (!targetItem || !activeItem) return;

      const isTargetFrame = targetItem.node.type === 'frame';
      const activeHasParent = Boolean(activeItem.node.parentId);
      const activeParentId = activeItem.node.parentId;
      const targetParentId = targetItem.node.parentId;

      // Determine drag direction from visible item indices.
      // The visual list is reversed (higher z-order at top), so dragging DOWN
      // in the list means lower z-order → insert "before" in the nodes array,
      // and dragging UP means higher z-order → insert "after".
      const activeIndex = visibleItems.findIndex((i) => i.id === activeId);
      const overIndex = visibleItems.findIndex((i) => i.id === overId);
      const position: 'before' | 'after' =
        activeIndex < overIndex ? 'before' : 'after';

      // ============================================================
      // Canvas Layer Tree handles:
      // 1. Hierarchy changes (frame/unframe)
      // 2. Same-level reordering (changes render order / z-index)
      // Unlike Source Library, it doesn't have sort buttons (alpha/time)
      // ============================================================

      // Case 1: Dropping on the parent frame itself → unframe
      // Place the node near the frame in the tree
      if (isTargetFrame && activeParentId === overId) {
        moveNodeOutOfFrame(activeId, {
          nodeId: overId,
          position,
        });
        return;
      }

      // Case 2: Dropping on a different frame → move into that frame
      // Place the node as the first visible child (highest z-order)
      if (isTargetFrame) {
        // The visual list is reversed: the first visible child under a
        // frame is the LAST child in the nodes array (highest z-order). To
        // make the new node the first visible child, place it AFTER that
        // child in the array.
        const firstVisibleChild = items.find(
          (item) => item.node.parentId === overId && item.id !== activeId,
        );
        moveNodeIntoFrame(
          activeId,
          overId,
          firstVisibleChild
            ? { nodeId: firstVisibleChild.id, position: 'after' }
            : undefined,
        );
        return;
      }

      // Case 3: Dropping on a node in a different frame → move into that
      // frame. Place the node near the target node within the frame.
      if (targetParentId && targetParentId !== activeParentId) {
        moveNodeIntoFrame(activeId, targetParentId, {
          nodeId: overId,
          position,
        });
        return;
      }

      // Case 4: Dropping on a top-level node when active is in a frame →
      // unframe. Place the node near the target in the tree.
      if (activeHasParent && !targetParentId) {
        moveNodeOutOfFrame(activeId, {
          nodeId: overId,
          position,
        });
        return;
      }

      // Case 5: Same-level drag → reorder to change render order (z-index)
      reorderNodes(activeId, overId, position);
    },
    [items, visibleItems, moveNodeIntoFrame, moveNodeOutOfFrame, reorderNodes],
  );

  // Stable handlers — these read fresh state from the store inside the
  // callback (rather than closing over `selectedIdSet`, which changes
  // every selection) so they retain identity across renders. That keeps
  // `SortableRow`'s `React.memo` valid for unchanged rows.
  const handleSelect = useCallback(
    (id: string, event: React.MouseEvent) => {
      event.stopPropagation();
      const isMulti = event.metaKey || event.ctrlKey;

      // Snapshot the selection BEFORE dispatching so toggle math operates
      // on the pre-update set (matches the original semantics).
      const snapshot = useCanvasStore.getState();
      const currentSelected: string[] = [];
      for (const n of snapshot.nodes)
        if (n.selected) currentSelected.push(n.id);

      selectNodes([id], isMulti);

      if (rfInstance) {
        let targetIds: string[];
        if (isMulti) {
          if (currentSelected.includes(id)) {
            targetIds = currentSelected.filter((sid) => sid !== id);
          } else {
            targetIds = [...currentSelected, id];
          }
        } else {
          targetIds = [id];
        }

        if (targetIds.length > 0) {
          const nodesToFit = targetIds.map((nid) => ({ id: nid }));
          void rfInstance.fitView({
            nodes: nodesToFit,
            duration: 800,
            maxZoom: 1,
          });
        }
      }
    },
    [selectNodes, rfInstance],
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

  const itemIds = useMemo(() => visibleItems.map((i) => i.id), [visibleItems]);

  // Build lookup map once for efficient parent-chain traversal
  const visibleItemMap = useMemo(
    () => new Map(visibleItems.map((item) => [item.id, item])),
    [visibleItems],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <div className="-mx-3 -my-3 overflow-hidden">
        <div className="flex flex-col py-1">
          <SortableContext
            items={itemIds}
            strategy={verticalListSortingStrategy}
          >
            {visibleItems.map((item) => {
              const isCollapsible =
                item.node.type === 'frame' || item.node.type === 'group';
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
              const isDraggingDisabled = isParentLocked;

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

          {visibleItems.length === 0 && (
            <EmptyState message={emptyText} className="px-3 py-2" />
          )}
        </div>
      </div>
    </DndContext>
  );
};
