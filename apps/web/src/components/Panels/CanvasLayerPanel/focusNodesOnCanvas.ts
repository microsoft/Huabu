// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  getViewportForBounds,
  type ReactFlowInstance,
  type Viewport,
} from '@xyflow/react';

import { MAX_ZOOM, MIN_ZOOM } from '@/config/canvas';

type NodeBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ViewportSize = { width: number; height: number };
type VisibleArea = ViewportSize & { x: number; y: number };

export function getCanvasVisibleArea(wrapper: HTMLElement): VisibleArea {
  const style = wrapper instanceof Element ? getComputedStyle(wrapper) : null;
  const left =
    Number.parseFloat(style?.getPropertyValue('--canvas-inset-left') ?? '') ||
    0;
  const right =
    Number.parseFloat(style?.getPropertyValue('--canvas-inset-right') ?? '') ||
    0;
  return {
    x: left,
    y: 0,
    width: Math.max(0, wrapper.clientWidth - left - right),
    height: wrapper.clientHeight,
  };
}

/** Keep the same flow-space point at the centre when the canvas is resized. */
export const anchorViewportCentre = (
  viewport: Viewport,
  previousSize: ViewportSize,
  nextSize: ViewportSize,
): Viewport => ({
  x: viewport.x + (nextSize.width - previousSize.width) / 2,
  y: viewport.y + (nextSize.height - previousSize.height) / 2,
  zoom: viewport.zoom,
});

/**
 * Reveal flow-space bounds with the smallest screen-space pan possible.
 * Oversized bounds align their leading edge without zooming.
 */
export const revealBoundsInViewport = (
  viewport: Viewport,
  viewportSize: VisibleArea,
  bounds: NodeBounds,
  padding = 24,
): Viewport => {
  const originX = viewportSize.x;
  const originY = viewportSize.y;
  const safeWidth = Math.max(0, viewportSize.width - padding * 2);
  const safeHeight = Math.max(0, viewportSize.height - padding * 2);
  const left = bounds.x * viewport.zoom + viewport.x;
  const top = bounds.y * viewport.zoom + viewport.y;
  const right = left + bounds.width * viewport.zoom;
  const bottom = top + bounds.height * viewport.zoom;
  const safeLeft = originX + padding;
  const safeTop = originY + padding;
  const safeRight = originX + viewportSize.width - padding;
  const safeBottom = originY + viewportSize.height - padding;

  let dx = 0;
  if (right - left > safeWidth) {
    dx = safeLeft - left;
  } else if (left < safeLeft) {
    dx = safeLeft - left;
  } else if (right > safeRight) {
    dx = safeRight - right;
  }

  let dy = 0;
  if (bottom - top > safeHeight) {
    dy = safeTop - top;
  } else if (top < safeTop) {
    dy = safeTop - top;
  } else if (bottom > safeBottom) {
    dy = safeBottom - bottom;
  }

  if (dx === 0 && dy === 0) return viewport;
  return { x: viewport.x + dx, y: viewport.y + dy, zoom: viewport.zoom };
};

/** Resolve bounds even when `onlyRenderVisibleElements` left nodes unmeasured. */
export const getReliableNodeBounds = (
  rfInstance: ReactFlowInstance,
  nodeIds: string[],
): NodeBounds | null => {
  if (nodeIds.length === 0) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const nodeId of nodeIds) {
    const internal = rfInstance.getInternalNode(nodeId);
    if (!internal || internal.hidden) continue;
    const width =
      internal.measured.width ??
      internal.width ??
      internal.initialWidth ??
      (typeof internal.style?.width === 'number' ? internal.style.width : 0);
    const height =
      internal.measured.height ??
      internal.height ??
      internal.initialHeight ??
      (typeof internal.style?.height === 'number' ? internal.style.height : 0);
    const x = internal.internals.positionAbsolute.x;
    const y = internal.internals.positionAbsolute.y;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + width > maxX) maxX = x + width;
    if (y + height > maxY) maxY = y + height;
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
};

/** Fit a set of nodes using reliable bounds rather than React Flow measurements. */
export const fitNodesOnCanvas = (
  rfInstance: ReactFlowInstance,
  nodeIds: string[],
  padding = 0.15,
): Promise<boolean> => {
  const bounds = getReliableNodeBounds(rfInstance, nodeIds);
  if (!bounds) return Promise.resolve(false);
  const wrapper = document.querySelector<HTMLElement>(
    '[data-overlay-layout] [data-canvas-root]',
  );
  if (wrapper) {
    const area = getCanvasVisibleArea(wrapper);
    const viewport = getViewportForBounds(
      bounds,
      area.width,
      area.height,
      MIN_ZOOM,
      MAX_ZOOM,
      padding,
    );
    return rfInstance.setViewport({
      ...viewport,
      x: viewport.x + area.x,
    });
  }
  return rfInstance.fitBounds(bounds, { padding });
};

export const fitCanvasContent = (
  rfInstance: ReactFlowInstance,
  scope: 'all' | 'selection',
): Promise<boolean> =>
  fitNodesOnCanvas(
    rfInstance,
    rfInstance
      .getNodes()
      .filter((node) => !node.hidden && (scope === 'all' || node.selected))
      .map((node) => node.id),
  );

const pendingReveals = new WeakMap<HTMLElement, object>();

/** Reveal after layout commits, preserving zoom and only the latest request. */
export const revealNodesOnCanvas = (
  rfInstance: ReactFlowInstance,
  canvasWrapper: HTMLElement,
  nodeIds: string[],
  duration = 400,
): void => {
  const request = {};
  const targets = [...nodeIds];
  pendingReveals.set(canvasWrapper, request);
  requestAnimationFrame(() => {
    if (pendingReveals.get(canvasWrapper) !== request) return;
    pendingReveals.delete(canvasWrapper);
    if (!canvasWrapper.isConnected) return;
    const bounds = getReliableNodeBounds(rfInstance, targets);
    if (!bounds) return;
    const area = getCanvasVisibleArea(canvasWrapper);
    if (area.width <= 0 || area.height <= 0) return;
    const currentViewport = rfInstance.getViewport();
    const nextViewport = revealBoundsInViewport(currentViewport, area, bounds);
    if (nextViewport === currentViewport) return;
    void rfInstance.setViewport(nextViewport, {
      duration,
      interpolate: 'linear',
      ease: (progress) => (1 - Math.cos(Math.PI * progress)) / 2,
    });
  });
};
