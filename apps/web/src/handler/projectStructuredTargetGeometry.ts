// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  getFrameSizing,
  projectAffectedFrameGeometry,
  type NestableNode,
  type StructuredDropZone,
} from '@huabu/shared/canvas-engine';

import type { Edge } from '@xyflow/react';

export function projectStructuredTargetGeometry({
  nodes,
  targetFrameId,
  zone,
  edges,
}: {
  nodes: NestableNode[];
  targetFrameId: string;
  zone: StructuredDropZone;
  edges: readonly Edge[];
}): NestableNode[] {
  const reflowById = new Map(zone.reflow.map((entry) => [entry.id, entry]));
  const projected = nodes.map((node) => {
    if (node.id === targetFrameId && getFrameSizing(node) === 'hug') {
      return {
        ...node,
        style: {
          ...node.style,
          width: zone.frameSize.width,
          height: zone.frameSize.height,
        },
        measured: {
          ...node.measured,
          width: zone.frameSize.width,
          height: zone.frameSize.height,
        },
      };
    }
    const reflow = reflowById.get(node.id);
    return reflow ? { ...node, position: { x: reflow.x, y: reflow.y } } : node;
  });
  const targetFrame = projected.find((node) => node.id === targetFrameId);

  return targetFrame?.parentId
    ? projectAffectedFrameGeometry(projected, [targetFrame.parentId], edges)
        .nodes
    : projected;
}
