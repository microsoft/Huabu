// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  getAbsolutePosition,
  readFrameGridConfig,
  solveStructuredFrameLayout,
  type NestableNode,
  type StructuredReflowEntry,
} from '@huabu/shared/canvas-engine';

import type { Edge, XYPosition } from '@xyflow/react';

interface ProjectStructuredSourceTransitionOptions {
  nodes: NestableNode[];
  draggedIds: ReadonlySet<string>;
  sourceFrameId: string | undefined;
  targetFrameId: string | null | undefined;
  edges: readonly Edge[];
}

export interface StructuredSourceTransitionProjection {
  reflow: StructuredReflowEntry[];
  targetFramePosition: XYPosition | null;
}

export function projectStructuredSourceTransition({
  nodes,
  draggedIds,
  sourceFrameId,
  targetFrameId,
  edges,
}: ProjectStructuredSourceTransitionOptions): StructuredSourceTransitionProjection {
  const currentTargetPosition = targetFrameId
    ? getAbsolutePosition(nodes, targetFrameId)
    : null;
  const sourceFrame = sourceFrameId
    ? nodes.find((node) => node.id === sourceFrameId)
    : undefined;
  if (
    !sourceFrameId ||
    !targetFrameId ||
    targetFrameId === sourceFrameId ||
    !readFrameGridConfig(sourceFrame)
  ) {
    return { reflow: [], targetFramePosition: currentTargetPosition };
  }

  const sourceLayout = solveStructuredFrameLayout(
    nodes.filter((node) => !draggedIds.has(node.id)),
    sourceFrameId,
    'compact',
    { edges },
  );
  if (!sourceLayout) {
    return { reflow: [], targetFramePosition: currentTargetPosition };
  }

  const reflow = [...sourceLayout.childPositions]
    .filter(([id]) => !draggedIds.has(id))
    .map(([id, position]) => ({ id, ...position }));

  let targetBranch = nodes.find((node) => node.id === targetFrameId);
  while (targetBranch?.parentId && targetBranch.parentId !== sourceFrameId) {
    targetBranch = nodes.find((node) => node.id === targetBranch?.parentId);
  }
  const projectedBranchPosition = targetBranch
    ? sourceLayout.childPositions.get(targetBranch.id)
    : undefined;
  if (
    !currentTargetPosition ||
    targetBranch?.parentId !== sourceFrameId ||
    !projectedBranchPosition
  ) {
    return { reflow, targetFramePosition: currentTargetPosition };
  }

  return {
    reflow,
    targetFramePosition: {
      x:
        currentTargetPosition.x +
        projectedBranchPosition.x -
        targetBranch.position.x,
      y:
        currentTargetPosition.y +
        projectedBranchPosition.y -
        targetBranch.position.y,
    },
  };
}
