// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { extractNodeRef } from '../utils';

import type {
  CanvasUiIntent,
  UiIntentResolution,
  UiResolverState,
} from '../uiIntent';
import type { CanvasEdgeId } from '@huabu/shared';

export default function resolveDisconnectEdge(
  intent: Extract<CanvasUiIntent, { type: 'DISCONNECT_EDGE' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const edgesToRemove = ui.edges.filter((e) => intent.edgeIds.includes(e.id));
  const disconnectedPairs = edgesToRemove
    .map((e) => {
      const source = ui.nodes.find((n) => n.id === e.source);
      const target = ui.nodes.find((n) => n.id === e.target);
      if (source && target) {
        return {
          source: extractNodeRef(source),
          target: extractNodeRef(target),
        };
      }
      return null;
    })
    .filter((p): p is NonNullable<typeof p> => !!p);

  return {
    commands: [
      {
        type: 'DISCONNECT_EDGES',
        edges: intent.edgeIds as CanvasEdgeId[],
      },
    ],
    trace:
      disconnectedPairs.length > 0
        ? [{ action: 'edges_disconnected', edges: disconnectedPairs }]
        : [],
  };
}
