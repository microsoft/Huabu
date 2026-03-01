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
import React, { useMemo } from 'react';

import useCanvasStore from '@/store/canvasStore.ts';

import { TreeRowItem } from './TreeRowItem';

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
  getIcon: (nodeType: string | undefined) => React.ReactNode;
  getDisplayName: (node: DataSourceNodeLike) => string;
  onSelect: (id: string, event: React.MouseEvent) => void;
  onRename: (id: string, newName: string) => void;
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
        icon={getIcon(item.node.type)}
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
  getIcon: (nodeType: string | undefined) => React.ReactNode;
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
  const setSelectedNodes = useCanvasStore((state) => state.setSelectedNodes);
  const reorderNodes = useCanvasStore((state) => state.reorderNodes);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const rfInstance = useCanvasStore((state) => state.rfInstance);
  const moveNodeIntoFrame = useCanvasStore((state) => state.moveNodeIntoFrame);
  const moveNodeOutOfFrame = useCanvasStore(
    (state) => state.moveNodeOutOfFrame,
  );
  const toggleFrameCollapse = useCanvasStore(
    (state) => state.toggleFrameCollapse,
  );
  const collapsedFrameIds = useCanvasStore((state) => state.collapsedFrameIds);
  const toggleFrameLock = useCanvasStore((state) => state.toggleFrameLock);

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

  const selectedIds = useMemo(
    () => nodes.filter((n) => n.selected).map((n) => n.id),
    [nodes],
  );

  const highlightedIds = useMemo(() => {
    const allHighlighted = new Set<string>();
    selectedIds.forEach((id) => {
      allHighlighted.add(id);
      const selectedItem = visibleItems.find((item) => item.id === id);
      if (
        selectedItem?.node.type === 'frame' ||
        selectedItem?.node.type === 'group'
      ) {
        const currentIndex = visibleItems.indexOf(selectedItem);
        for (let i = currentIndex + 1; i < visibleItems.length; i++) {
          if (visibleItems[i].depth > selectedItem.depth) {
            allHighlighted.add(visibleItems[i].id);
          } else {
            break;
          }
        }
      }
    });
    return allHighlighted;
  }, [selectedIds, visibleItems]);

  const handleDragEnd = (event: DragEndEvent) => {
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

    // ============================================================
    // Canvas Layer Tree handles:
    // 1. Hierarchy changes (frame/unframe)
    // 2. Same-level reordering (changes render order / z-index)
    // Unlike Source Library, it doesn't have sort buttons (alpha/time)
    // ============================================================

    // Case 1: Dropping on the parent frame itself → unframe
    if (isTargetFrame && activeParentId === overId) {
      moveNodeOutOfFrame(activeId);
      // After unframe, reorder to place node near the target position
      reorderNodes(activeId, overId);
      return;
    }

    // Case 2: Dropping on a different frame → move into that frame
    if (isTargetFrame) {
      moveNodeIntoFrame(activeId, overId);
      // After moving into frame, reorder to place node near the target position
      reorderNodes(activeId, overId);
      return;
    }

    // Case 3: Dropping on a node in a different frame → move into that frame
    if (targetParentId && targetParentId !== activeParentId) {
      moveNodeIntoFrame(activeId, targetParentId);
      // After moving into frame, reorder to place node near the target node
      reorderNodes(activeId, overId);
      return;
    }

    // Case 4: Dropping on a top-level node when active is in a frame → unframe
    if (activeHasParent && !targetParentId) {
      moveNodeOutOfFrame(activeId);
      // After unframe, reorder to place node near the target position
      reorderNodes(activeId, overId);
      return;
    }

    // Case 5: Same-level drag → reorder to change render order (z-index)
    reorderNodes(activeId, overId);
  };

  const handleSelect = (id: string, event: React.MouseEvent) => {
    event.stopPropagation();
    const isMulti = event.metaKey || event.ctrlKey;
    setSelectedNodes([id], isMulti);

    if (rfInstance) {
      let targetIds = [id];
      if (isMulti) {
        if (selectedIds.includes(id)) {
          // Deselecting
          targetIds = selectedIds.filter((sid) => sid !== id);
        } else {
          // Selecting
          targetIds = [...selectedIds, id];
        }
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
  };

  const handleRename = (id: string, newName: string) => {
    updateNodeData(
      id,
      { label: newName, labelSource: 'user' },
      { recordHistory: true },
    );
  };

  const handleToggleCollapse = (id: string) => {
    toggleFrameCollapse(id);
  };

  const handleToggleLock = (id: string) => {
    toggleFrameLock(id);
  };

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
              const isLocked = Boolean(item.node.data?.locked);

              // Check if this node is inside a locked frame
              let isDraggingDisabled = false;
              let parentId = item.node.parentId;
              while (parentId) {
                const parent = visibleItemMap.get(parentId);
                if (parent && Boolean(parent.node.data?.locked)) {
                  isDraggingDisabled = true;
                  break;
                }
                parentId = parent?.node.parentId;
              }

              return (
                <SortableRow
                  key={item.id}
                  item={item}
                  isDirectlySelected={selectedIds.includes(item.id)}
                  isHighlighted={highlightedIds.has(item.id)}
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
            <div className="text-muted-foreground px-3 py-2 text-sm">
              {emptyText}
            </div>
          )}
        </div>
      </div>
    </DndContext>
  );
};
