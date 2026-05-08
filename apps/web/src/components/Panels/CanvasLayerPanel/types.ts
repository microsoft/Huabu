export type DataSourceNodeLike = {
  id: string;
  type?: string;
  parentId?: string;
  data: {
    label: string;
    [key: string]: unknown;
  };

  measured?: Record<string, unknown>;
  width?: number;
  height?: number;
};

export type DataSourceTreeItem = {
  id: string;
  node: DataSourceNodeLike;
  depth: number;
};
