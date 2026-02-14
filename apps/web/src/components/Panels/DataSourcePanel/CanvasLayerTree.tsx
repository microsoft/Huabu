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
  getIcon: (nodeType: string | undefined) => React.ReactNode;
  getDisplayName: (node: DataSourceNodeLike) => string;
  onSelect: (id: string, event: React.MouseEvent) => void;
  onRename: (id: string, newName: string) => void;
}

const SortableRow = React.memo(
  ({
    item,
    isDirectlySelected,
    isHighlighted,
    getIcon,
    getDisplayName,
    onSelect,
    onRename,
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
        onClick={(e) => onSelect(item.id, e)}
        editable={true}
        onRename={(newName) => onRename(item.id, newName)}
        // DnD plumbing
        forwardedRef={setNodeRef}
        style={style}
        dndAttributes={attributes}
        dndListeners={listeners}
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
  onDragStart?: () => void;
}

export const CanvasLayerTree = ({
  items,
  getIcon,
  getDisplayName,
  emptyText = 'No items',
  onDragStart,
}: CanvasLayerTreeProps) => {
  const nodes = useCanvasStore((state) => state.nodes);
  const setSelectedNodes = useCanvasStore((state) => state.setSelectedNodes);
  const reorderNodes = useCanvasStore((state) => state.reorderNodes);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const rfInstance = useCanvasStore((state) => state.rfInstance);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const selectedIds = useMemo(
    () => nodes.filter((n) => n.selected).map((n) => n.id),
    [nodes],
  );

  const highlightedIds = useMemo(() => {
    const allHighlighted = new Set<string>();
    selectedIds.forEach((id) => {
      allHighlighted.add(id);
      const selectedItem = items.find((item) => item.id === id);
      if (
        selectedItem?.node.type === 'frame' ||
        selectedItem?.node.type === 'group'
      ) {
        const currentIndex = items.indexOf(selectedItem);
        for (let i = currentIndex + 1; i < items.length; i++) {
          if (items[i].depth > selectedItem.depth) {
            allHighlighted.add(items[i].id);
          } else {
            break;
          }
        }
      }
    });
    return allHighlighted;
  }, [selectedIds, items]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      reorderNodes(active.id as string, over.id as string);
    }
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
    updateNodeData(id, { label: newName });
  };

  const itemIds = useMemo(() => items.map((i) => i.id), [items]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
      onDragStart={onDragStart}
    >
      <div className="-mx-3 -my-3 overflow-hidden">
        <div className="flex flex-col py-1">
          <SortableContext
            items={itemIds}
            strategy={verticalListSortingStrategy}
          >
            {items.map((item) => (
              <SortableRow
                key={item.id}
                item={item}
                isDirectlySelected={selectedIds.includes(item.id)}
                isHighlighted={highlightedIds.has(item.id)}
                getIcon={getIcon}
                getDisplayName={getDisplayName}
                onSelect={handleSelect}
                onRename={handleRename}
              />
            ))}
          </SortableContext>

          {items.length === 0 && (
            <div className="text-muted-foreground px-3 py-2 text-sm">
              {emptyText}
            </div>
          )}
        </div>
      </div>
    </DndContext>
  );
};
