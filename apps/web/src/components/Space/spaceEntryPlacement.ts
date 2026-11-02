// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  computeAdjacentNodePlacement,
  getNodeDefaultSize,
} from '@huabu/shared/canvas-engine';

import { viewportCenterAnchor } from '@/handler/canvasCommand/resolvers/resolveAddNodes';
import { i18n } from '@/i18n';
import useCanvasStore from '@/store/canvasStore';
import {
  getCanvasViewportCenter,
  getCanvasVisibleArea,
  getReliableNodeBounds,
} from '@/utils/canvasViewport';

export function getSpaceEntryPosition() {
  const state = useCanvasStore.getState();
  const center = getCanvasViewportCenter(state);
  if (!center) throw new Error(i18n.t('spaceHierarchy.failed'));
  const ideal = viewportCenterAnchor('spacePreview', undefined, center, 0);
  const { rfInstance, canvasWrapper } = state;
  if (!rfInstance || !canvasWrapper) return ideal;
  const defaults = getNodeDefaultSize('spacePreview');
  const size = { width: defaults.width, height: defaults.height || 100 };
  const intersecting = (position: { x: number; y: number }) =>
    rfInstance
      .getIntersectingNodes({ ...position, ...size })
      .filter((node) => !node.hidden && node.type !== 'frame');
  const obstacle = intersecting(ideal)[0];
  if (!obstacle) return ideal;
  const bounds = getReliableNodeBounds(rfInstance, [obstacle.id]);
  if (!bounds) return ideal;
  const rect = canvasWrapper.getBoundingClientRect();
  const area = getCanvasVisibleArea(canvasWrapper);
  const min = rfInstance.screenToFlowPosition({
    x: rect.left + area.x,
    y: rect.top + area.y,
  });
  const max = rfInstance.screenToFlowPosition({
    x: rect.left + area.x + area.width,
    y: rect.top + area.y + area.height,
  });
  const candidates = (['right', 'left', 'bottom', 'top'] as const)
    .map((side) =>
      computeAdjacentNodePlacement({
        nodes: state.nodes,
        source: bounds,
        nodeType: 'spacePreview',
        side,
      }),
    )
    .filter(
      (point) =>
        point.x >= min.x &&
        point.y >= min.y &&
        point.x + size.width <= max.x &&
        point.y + size.height <= max.y &&
        intersecting(point).length === 0,
    )
    .sort(
      (a, b) =>
        Math.hypot(a.x - ideal.x, a.y - ideal.y) -
        Math.hypot(b.x - ideal.x, b.y - ideal.y),
    );
  // A crowded viewport keeps the card visible rather than sending it offscreen.
  return candidates[0] ?? ideal;
}
