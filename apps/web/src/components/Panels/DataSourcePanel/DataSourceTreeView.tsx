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
  onRename: (id: string, newName: string) => void;
}

const SortableTreeRow = React.memo(
  ({
    item,
    isDirectlySelected,
    isHighlighted,
    getIcon,
    getDisplayName,
    onSelect,
    onRename,
  }: SortableTreeRowProps) => {
    const {
      attributes,
      listeners,
      setNodeRef,
      transform,
      transition,
      isDragging,
    } = useSortable({ id: item.id });
    const [isEditing, setIsEditing] = React.useState(false);
    const [editValue, setEditValue] = React.useState('');

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

    const handleDoubleClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      setEditValue(name);
      setIsEditing(true);
    };

    const handleSave = () => {
      if (editValue.trim() && editValue !== name) {
        onRename(item.id, editValue);
      }
      setIsEditing(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSave();
      } else if (e.key === 'Escape') {
        setIsEditing(false);
      }
    };

    return (
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...(isEditing ? {} : listeners)}
        onClick={(e) => onSelect(item.id, e)}
        onDoubleClick={handleDoubleClick}
        className="flex h-9 w-full touch-none items-center gap-2 bg-white px-2"
      >
        <div
          className={`flex w-full items-center gap-2 rounded px-2 py-1 text-sm transition-colors ${bgColor}`}
        >
          <span className="text-muted-foreground pointer-events-none flex shrink-0 items-center">
            {icon}
          </span>
          {isEditing ? (
            <input
              autoFocus
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              className="h-6 w-full min-w-0 flex-1 rounded-sm border bg-white px-1 text-sm outline-none"
            />
          ) : (
            <span className="text-main truncate select-none">{name}</span>
          )}
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
