// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { Edge } from '@xyflow/react';

export function getEdgeIdsBetweenSelectedNodes(
  nodeIds: string[],
  edges: Edge[],
): string[] {
  const selectedNodeIds = new Set(nodeIds);

  return edges
    .filter(
      (edge) =>
        selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target),
    )
    .map((edge) => edge.id);
}
