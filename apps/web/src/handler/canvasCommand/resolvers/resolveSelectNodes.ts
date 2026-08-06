// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { extractNodeRef, getSelectedNodeIds } from '../utils';

import type {
  CanvasUiIntent,
  UiIntentResolution,
  UiResolverState,
} from '../uiIntent';
import type { CanvasNodeId, RecentAction } from '@huabu/shared';

export default function resolveSelectNodes(
  intent: Extract<CanvasUiIntent, { type: 'SELECT_NODES' }>,
  ui: UiResolverState,
): UiIntentResolution {
  let finalSelection: string[];

  if (intent.mode === 'toggle') {
    const currentlySelected = new Set(getSelectedNodeIds(ui.nodes));
    for (const id of intent.nodeIds) {
      if (currentlySelected.has(id)) {
        currentlySelected.delete(id);
      } else {
        currentlySelected.add(id);
      }
    }
    finalSelection = Array.from(currentlySelected);
  } else {
    finalSelection = intent.nodeIds;
  }

  const selectedNodes = ui.nodes.filter((n) => finalSelection.includes(n.id));
  const trace: RecentAction[] = [];
  if (selectedNodes.length === 1) {
    trace.push({
      action: 'node_selected',
      node: extractNodeRef(selectedNodes[0]),
    });
  } else if (selectedNodes.length > 1) {
    trace.push({
      action: 'nodes_selected',
      nodes: selectedNodes.map(extractNodeRef),
    });
  }

  return {
    commands: [
      {
        type: 'SET_NODE_SELECTION',
        nodeIds: finalSelection as CanvasNodeId[],
      },
    ],
    trace,
  };
}
