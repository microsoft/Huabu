import type React from 'react';

export type DataSourceNodeLike = {
  id: string;
  type?: string;
  parentId?: string;
  data?: Record<string, unknown>;
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
}

export const DataSourceTreeView = ({
  items,
  getIcon,
  getDisplayName,
  emptyText = 'No items',
}: DataSourceTreeViewProps) => {
  return (
    <div className="-mx-3 -my-3">
      <div className="flex flex-col py-1">
        {items.map((item) => {
          const icon = getIcon(item.node.type);
          const name = getDisplayName(item.node);

          return (
            <div
              key={item.id}
              className="hover:bg-background flex h-8 w-full items-center gap-2 px-3 text-sm"
              style={{ paddingLeft: 12 + item.depth * 16 }}
            >
              <span className="text-muted-foreground flex shrink-0 items-center">
                {icon}
              </span>
              <span className="truncate">{name}</span>
            </div>
          );
        })}

        {items.length === 0 ? (
          <div className="text-muted-foreground px-3 py-2 text-sm">
            {emptyText}
          </div>
        ) : null}
      </div>
    </div>
  );
};
