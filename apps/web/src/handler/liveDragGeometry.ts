// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  getAbsolutePosition,
  getNodeDefaultSize,
  getNodeSize,
  type NestableNode,
} from '@huabu/shared/canvas-engine';

import type { Node } from '@xyflow/react';

export function mergeLiveDragGeometry(
  stored: NestableNode,
  live: Node,
): NestableNode {
  const defaults = getNodeDefaultSize(stored.type ?? '');
  const liveSize = getNodeSize(live);
  const storedSize = getNodeSize(stored);
  const width = liveSize.width || storedSize.width || defaults.width || 0;
  const height = liveSize.height || storedSize.height || defaults.height || 0;

  return {
    ...stored,
    position: live.position,
    measured: { ...stored.measured, width, height },
  };
}

export function compensateDetachedDragPosition(
  liveNode: NestableNode,
  projectedNodes: NestableNode[],
): { x: number; y: number } | null {
  if (!liveNode.parentId) return null;
  const projectedNode = projectedNodes.find((node) => node.id === liveNode.id);
  if (!projectedNode || projectedNode.parentId) return null;

  const projectedNodeAbs = getAbsolutePosition(projectedNodes, liveNode.id);
  const projectedParentAbs = getAbsolutePosition(
    projectedNodes,
    liveNode.parentId,
  );
  if (!projectedNodeAbs || !projectedParentAbs) return null;

  return {
    x: projectedNodeAbs.x - projectedParentAbs.x,
    y: projectedNodeAbs.y - projectedParentAbs.y,
  };
}
