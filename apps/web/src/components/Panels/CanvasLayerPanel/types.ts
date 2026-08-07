// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
  /**
   * When set, the row represents an unimported `.md` file dropped into
   * `<canvasDir>/nodes/` by the user. Rendered greyed-out with a hover
   * "add to canvas" affordance. The value is the file path relative to
   * the canvas dir (e.g. `nodes/foo.md`), used by `importItem()`.
   */
  externalRelativePath?: string;
};
