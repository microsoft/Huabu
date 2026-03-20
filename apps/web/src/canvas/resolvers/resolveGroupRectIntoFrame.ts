import {
  createId,
  type CanvasCommand,
  type CanvasNodeId,
} from '@sediment/shared';

import { frameNodesInRect, type NestableNode } from '../utils/frame';

import type {
  CanvasUiIntent,
  UiIntentResolution,
  UiResolverState,
} from '../uiIntent';

export default function resolveGroupRectIntoFrame(
  intent: Extract<CanvasUiIntent, { type: 'GROUP_RECT_INTO_FRAME' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const commands: CanvasCommand[] = [];
  const frameId = createId('node');
  const result = frameNodesInRect(
    ui.nodes as NestableNode[],
    intent.flowRect,
    frameId,
  );

  const frameNode = result.nodes.find((n) => n.id === frameId);
  if (frameNode) {
    commands.push({
      type: 'CREATE_NODES',
      nodes: [
        {
          id: frameId as CanvasNodeId,
          nodeType: 'frame',
          data: { label: 'Frame' } as never,
          position: frameNode.position,
          size: {
            width:
              (frameNode.style as Record<string, number>)?.width ??
              intent.flowRect.width,
            height:
              (frameNode.style as Record<string, number>)?.height ??
              intent.flowRect.height,
          },
        },
      ],
    });
  }

  const childIds = result.nodes
    .filter((n) => n.parentId === frameId && n.id !== frameId)
    .map((n) => n.id);

  if (childIds.length > 0) {
    commands.push({
      type: 'SET_NODE_PARENT',
      nodeIds: childIds as CanvasNodeId[],
      parentId: frameId as CanvasNodeId,
    });
  }

  commands.push({
    type: 'SET_NODE_SELECTION',
    nodeIds: [frameId as CanvasNodeId],
  });

  return {
    commands,
    trace: [
      {
        action: 'node_created' as const,
        nodes: [{ id: frameId, nodeType: 'frame' as const, label: 'Frame' }],
      },
    ],
  };
}
