// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { hasMissingFile } from '@/components/Nodes/missingFile';

import { nodeMatchesFilterKey, type LayerFilterKey } from './layerFilterKey';

import type { DataSourceNodeLike } from './types';
import type { CanvasNodeType } from '@huabu/shared';

export function nodeMatchesLayerFilters(
  node: DataSourceNodeLike,
  selectedKeys: ReadonlySet<LayerFilterKey>,
  showMissingOnly: boolean,
): boolean {
  if (showMissingOnly && !hasMissingFile(node.data)) return false;
  if (selectedKeys.size === 0) return true;

  const nodeType = node.type as CanvasNodeType | undefined;
  for (const key of selectedKeys) {
    if (nodeMatchesFilterKey(nodeType, node.data, key)) return true;
  }
  return false;
}
