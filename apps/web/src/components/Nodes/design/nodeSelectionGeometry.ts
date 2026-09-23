// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { NODE_SELECTION_CHROME } from '@/config/nodeInteractionChrome';

import { nodeMetricsForSize } from './nodeDesign';
import { frameVisualMetricsForSize } from '../frame/frameDesign';

export const SELECTION_OUTLINE_WIDTH = NODE_SELECTION_CHROME.width;

export function selectionOutlineRadius(
  type: string | undefined,
  width: number,
  height: number,
): number {
  return type === 'frame'
    ? frameVisualMetricsForSize(width, height).borderRadius
    : nodeMetricsForSize(width, height).radius;
}

/** Screen-space inset of a square grip's center from the bounding-box corner. */
export function resizeCornerInset(
  type: string | undefined,
  width: number,
  height: number,
  zoom: number,
  gripSize: number,
): number {
  // CSS clamps the shell radius on small rectangles. The outer outline edge
  // is concentric and one outline width farther out. The grip's inward corner
  // touches that edge at 45 degrees, without covering the arc or leaving a gap.
  const radius =
    Math.min(
      selectionOutlineRadius(type, width, height),
      width / 2,
      height / 2,
    ) * zoom;
  return (
    radius - (radius + SELECTION_OUTLINE_WIDTH) * Math.SQRT1_2 - gripSize / 2
  );
}
