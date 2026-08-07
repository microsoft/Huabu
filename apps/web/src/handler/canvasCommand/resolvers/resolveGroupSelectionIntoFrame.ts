// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createId, type CanvasCommand, type CanvasNodeId } from '@huabu/shared';
import { frameNodes, type NestableNode } from '@huabu/shared/canvas-engine';

import { getSelectedNodeIds } from '../utils';

import type {
  CanvasUiIntent,
  UiIntentResolution,
  UiResolverState,
} from '../uiIntent';

export default function resolveGroupSelectionIntoFrame(
  _intent: Extract<CanvasUiIntent, { type: 'GROUP_SELECTION_INTO_FRAME' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const selectedIds = getSelectedNodeIds(ui.nodes);
  const commands: CanvasCommand[] = [];

  if (selectedIds.length < 2) {
    return { commands, trace: [] };
  }

  const frameId = createId('node');
  const result = frameNodes(ui.nodes as NestableNode[], selectedIds, {
    frameId,
    label: 'Frame',
  });

  const frameNode = result.nodes.find((n) => n.id === frameId);
  if (frameNode) {
    commands.push({
      type: 'CREATE_NODES',
      nodes: [
        {
          id: frameId as CanvasNodeId,
          nodeType: 'frame',
          data: { label: 'Frame', origin: { type: 'user-created' } } as never,
          position: frameNode.position,
          size: {
            width: (frameNode.style as Record<string, number>)?.width ?? 400,
            height: (frameNode.style as Record<string, number>)?.height ?? 300,
          },
        },
      ],
    });
  }

  commands.push({
    type: 'SET_NODE_PARENT',
    nodeIds: selectedIds as CanvasNodeId[],
    parentId: frameId as CanvasNodeId,
  });

  commands.push({
    type: 'SET_NODE_SELECTION',
    nodeIds: [frameId as CanvasNodeId],
  });

  return {
    commands,
    trace: [
      {
        action: 'node_created' as const,
        nodes: [{ id: frameId, type: 'frame' as const, label: 'Frame' }],
      },
    ],
  };
}
