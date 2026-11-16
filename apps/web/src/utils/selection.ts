// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { Edge, EdgeChange } from '@xyflow/react';

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

/**
 * The change that selects `edgeId` when the user picks it (click, or Enter /
 * Space on the focused edge) while it is only shown as selected.
 *
 * An edge whose two ends are selected is rendered selected although its own
 * `selected` flag is not set. React Flow decides what to change from the
 * edges it renders, so for such an edge it reports nothing for the edge and
 * only deselects the nodes: the pick would leave nothing selected. Returns
 * no change when the edge is already selected itself, is not shown selected
 * (React Flow reports the change), or the pick extends a selection.
 */
export function selectionChangeForShownSelectedEdge(input: {
  edgeId: string;
  edges: readonly Edge[];
  selectedNodeIds: ReadonlySet<string>;
  /** A modifier held to add to or remove from the selection. */
  multiSelect: boolean;
}): EdgeChange[] {
  if (input.multiSelect) return [];
  const edge = input.edges.find((entry) => entry.id === input.edgeId);
  if (!edge || edge.selected || edge.selectable === false) return [];
  const shownSelected =
    input.selectedNodeIds.has(edge.source) &&
    input.selectedNodeIds.has(edge.target);
  return shownSelected ? [{ id: edge.id, type: 'select', selected: true }] : [];
}
