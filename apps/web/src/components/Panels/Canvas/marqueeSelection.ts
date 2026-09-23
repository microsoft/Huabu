// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  createAbsolutePositionGetter,
  getNodeSize,
  indexById,
} from '@huabu/shared/canvas-engine';

import {
  closestNodeElement,
  isEmptyPaneTarget,
  isPanelTarget,
} from './canvasInputPolicy';

import type { Node, Rect, XYPosition } from '@xyflow/react';

/** Controls and descendants retain first refusal; only blank Frame body is a start surface. */
export function marqueeStartTarget(
  target: EventTarget | null,
  nodes: Node[],
): { frameId: string | null } | null {
  if (!(target instanceof Element) || isPanelTarget(target)) return null;
  if (
    target.closest(
      '.react-flow__handle, .react-flow__resize-control, .react-flow__nodesselection, .react-flow__nodesselection-rect, .nodrag, .nokey, input, textarea, select, button, a, [contenteditable="true"], [role="button"], [data-keyboard-interactive]',
    )
  )
    return null;
  const element = closestNodeElement(target);
  if (!element) return isEmptyPaneTarget(target) ? { frameId: null } : null;
  const node = nodes.find((entry) => entry.id === element.dataset.id);
  return node?.type === 'frame' &&
    !node.selected &&
    !node.hidden &&
    node.selectable !== false
    ? { frameId: node.id }
    : null;
}

export function rectangleBetween(start: XYPosition, end: XYPosition): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

/** Frames require full containment; other nodes require positive-area intersection. */
export function nodesInMarquee(nodes: Node[], rect: Rect): string[] {
  // This is the indexed implementation used by getAbsolutePosition, shared across the scan.
  const absolutePosition = createAbsolutePositionGetter(indexById(nodes));
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return nodes
    .filter((node) => {
      if (node.hidden || node.selectable === false) return false;
      const position = absolutePosition(node.id);
      const size = getNodeSize(node);
      if (!position || size.width <= 0 || size.height <= 0) return false;
      if (node.type === 'frame') {
        return (
          position.x >= rect.x &&
          position.y >= rect.y &&
          position.x + size.width <= right &&
          position.y + size.height <= bottom
        );
      }
      return (
        position.x < right &&
        position.x + size.width > rect.x &&
        position.y < bottom &&
        position.y + size.height > rect.y
      );
    })
    .map((node) => node.id);
}
