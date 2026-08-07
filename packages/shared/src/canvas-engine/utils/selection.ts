// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { Node } from '@xyflow/react';

/**
 * Return a new nodes array where only the nodes whose id is in `selectedIds`
 * are marked selected; all other nodes are deselected.
 */
export function selectOnly(
  nodes: Node[],
  selectedIds: Iterable<string>,
): Node[] {
  const ids = new Set(selectedIds);
  return nodes.map((n) => ({ ...n, selected: ids.has(n.id) }));
}
