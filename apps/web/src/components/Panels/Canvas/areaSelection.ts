// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  createAbsolutePositionGetter,
  getNodeSize,
  indexById,
} from '@huabu/shared/canvas-engine';

import {
  blendedMarkRect,
  useNodeCollapseStore,
} from '@/store/nodeCollapseStore';
import {
  selectionHitsRect,
  type SelectionArea,
} from '@/utils/selectionGeometry';

import type { Node } from '@xyflow/react';

/** Shared policy: visible/selectable nodes overlap; Frames must be fully contained. */
export function nodesInSelection(nodes: Node[], area: SelectionArea): string[] {
  const absolutePosition = createAbsolutePositionGetter(indexById(nodes));
  const marks = useNodeCollapseStore.getState().marks;
  return nodes
    .filter((node) => {
      if (node.hidden || node.selectable === false) return false;
      const position = absolutePosition(node.id);
      if (!position) return false;
      const rect = marks[node.id]
        ? blendedMarkRect(marks[node.id])
        : { ...position, ...getNodeSize(node) };
      return selectionHitsRect(area, rect, node.type === 'frame');
    })
    .map((node) => node.id);
}
