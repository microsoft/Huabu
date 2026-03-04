import React from 'react';

import { setDragPayload } from '@/utils/dragDrop';

import { TreeRowItem } from './TreeRowItem';

import type { DataSourceNodeLike, DataSourceTreeItem } from './types';

interface SourceRowProps {
  item: DataSourceTreeItem;
  getIcon: (nodeType: string | undefined) => React.ReactNode;
  getDisplayName: (node: DataSourceNodeLike) => string;
  onItemClick?: (item: DataSourceTreeItem) => void;
  onRename?: (id: string, newName: string) => void;
}

const SourceRow = React.memo(
  ({
    item,
    getIcon,
    getDisplayName,
    onItemClick,
    onRename,
  }: SourceRowProps) => {
    const handleDragStart = (e: React.DragEvent) => {
      setDragPayload(e, {
        kind: 'source',
        origin: { type: 'user-drag-library' },
        data: {
          sourceId: item.node.id,
          type: item.node.type,
          ...item.node.data,
        },
      });
    };

    const handleClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      onItemClick?.(item);
    };

    return (
      <TreeRowItem
        depth={item.depth}
        icon={getIcon(item.node.type)}
        label={getDisplayName(item.node)}
        onClick={handleClick}
        draggable // Enable HTML5 Drag
        onDragStart={handleDragStart}
        editable={true}
        onRename={(newName) => onRename?.(item.id, newName)}
      />
    );
  },
);
SourceRow.displayName = 'SourceRow';

export interface SourceLibraryTreeProps {
  items: DataSourceTreeItem[];
  getIcon: (nodeType: string | undefined) => React.ReactNode;
  getDisplayName: (node: DataSourceNodeLike) => string;
  emptyText?: string;
  onItemClick?: (item: DataSourceTreeItem) => void;
  onRename?: (id: string, newName: string) => void;
}

export const SourceLibraryTree = ({
  items,
  getIcon,
  getDisplayName,
  emptyText = 'No items',
  onItemClick,
  onRename,
}: SourceLibraryTreeProps) => {
  return (
    <div className="-mx-3 -my-3 overflow-hidden">
      <div className="flex flex-col py-1">
        {items.map((item) => (
          <SourceRow
            key={item.id}
            item={item}
            getIcon={getIcon}
            getDisplayName={getDisplayName}
            onItemClick={onItemClick}
            onRename={onRename}
          />
        ))}

        {items.length === 0 && (
          <div className="text-muted-foreground px-3 py-2 text-sm">
            {emptyText}
          </div>
        )}
      </div>
    </div>
  );
};
