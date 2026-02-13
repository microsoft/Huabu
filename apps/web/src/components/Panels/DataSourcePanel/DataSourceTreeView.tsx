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

import type { DragEndEvent } from '@dnd-kit/core';

export type DataSourceNodeLike = {
  id: string;
  type?: string;
  parentId?: string;
  data?: Record<string, unknown>;

  measured?: Record<string, unknown>;
  width?: number;
  height?: number;
};

export type DataSourceTreeItem = {
  id: string;
  node: DataSourceNodeLike;
  depth: number;
};

export interface DataSourceTreeViewProps {
  items: DataSourceTreeItem[];
  getIcon: (nodeType: string | undefined) => React.ReactNode;
  getDisplayName: (node: DataSourceNodeLike) => string;
  emptyText?: string;
  onDragStart?: () => void;
}

export interface SortableTreeRowProps {
  item: DataSourceTreeItem;

  isDirectlySelected: boolean;
  isHighlighted: boolean;

  getIcon: (nodeType: string | undefined) => React.ReactNode;
  getDisplayName: (node: DataSourceNodeLike) => string;
  onSelect: (id: string, event: React.MouseEvent) => void;
}

const SortableTreeRow = React.memo(
  ({
    item,
    isDirectlySelected,
    isHighlighted,
    getIcon,
    getDisplayName,
    onSelect,
  }: SortableTreeRowProps) => {
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
      paddingLeft: 12 + item.depth * 16,
      opacity: isDragging ? 0.3 : 1,
      zIndex: isDragging ? 999 : 'auto',
      position: 'relative',
    };

    const icon = getIcon(item.node.type);
    const name = getDisplayName(item.node);

    const bgColor = isDirectlySelected
      ? 'bg-theme-100'
      : isHighlighted
        ? 'bg-theme-50'
        : 'hover:bg-background';

    return (
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        onClick={(e) => onSelect(item.id, e)}
        className="flex h-9 w-full cursor-grab touch-none items-center gap-2 bg-white px-2 active:cursor-grabbing"
      >
        <div
          className={`flex w-full items-center gap-2 rounded px-2 py-1 text-sm font-light transition-colors ${bgColor}`}
        >
          <span className="text-muted-foreground pointer-events-none flex shrink-0 items-center">
            {icon}
          </span>
          <span className="text-main pointer-events-none truncate select-none">
            {name}
          </span>
        </div>
      </div>
    );
  },
);

export const DataSourceTreeView = ({
  items,
  getIcon,
  getDisplayName,
  emptyText = 'No items',
  onDragStart,
}: DataSourceTreeViewProps) => {
  const nodes = useCanvasStore((state) => state.nodes);
  const setSelectedNodes = useCanvasStore((state) => state.setSelectedNodes);
  const reorderNodes = useCanvasStore((state) => state.reorderNodes);

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
      const selectedItem = items.find(
        (item: DataSourceTreeItem) => item.id === id,
      );
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

  const handleDragStart = () => {
    onDragStart?.();
  };

  const handleSelect = (id: string, event: React.MouseEvent) => {
    event.stopPropagation();
    const isMulti = event.metaKey || event.ctrlKey;
    setSelectedNodes([id], isMulti);
  };

  const itemIds = useMemo(
    () => items.map((i: DataSourceTreeItem) => i.id),
    [items],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
      onDragStart={handleDragStart}
    >
      <div className="-mx-3 -my-3 overflow-hidden">
        <div className="flex flex-col py-1">
          <SortableContext
            items={itemIds}
            strategy={verticalListSortingStrategy}
          >
            {items.map((item: DataSourceTreeItem) => (
              <SortableTreeRow
                key={item.id}
                item={item}
                isDirectlySelected={selectedIds.includes(item.id)}
                isHighlighted={highlightedIds.has(item.id)}
                getIcon={getIcon}
                getDisplayName={getDisplayName}
                onSelect={handleSelect}
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
