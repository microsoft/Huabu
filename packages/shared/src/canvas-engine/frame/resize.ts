// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { frameResponsiveMetricsForSize } from './design.js';
import { solveStructuredFrameLayout } from '../autoLayout/gridLayout.js';
import { getNodeSize } from '../utils/nodeSizes.js';

import type { Edge, Node } from '@xyflow/react';

/**
 * Invert the canonical structured layout using gesture-start children and the
 * target box's fixed insets/gutters. Each masonry track contributes a linear
 * constraint; the tallest/widest track may change as the scale changes.
 * A target below the whitespace/minimum-child floor remains content-clamped.
 */
export function structuredFrameResizeScale(
  nodes: Node[],
  edges: readonly Edge[],
  frameId: string,
  width: number,
  height: number,
): { x: number; y: number } | null {
  const metrics = frameResponsiveMetricsForSize(width, height);
  const layout = solveStructuredFrameLayout(nodes, frameId, 'compact', {
    edges,
    responsiveMetrics: metrics,
  });
  if (!layout) return null;
  const frame = nodes.find((node) => node.id === frameId);
  if (!frame) return null;
  const mode = frame.data.layoutMode;
  const children = nodes.filter((node) => node.parentId === frameId);
  const availableWidth = width - metrics.contentSpacing * 2;
  const availableHeight = height - metrics.headerInset - metrics.contentSpacing;
  const gutterSum = (axis: 'x' | 'y') =>
    layout.gutters
      .filter((gutter) => gutter.axis === axis)
      .reduce((sum, gutter) => sum + gutter.finalSize, 0);
  const ratio = (available: number, content: number) =>
    content > 0 ? Math.max(0, available / content) : 1;
  const trackScale = (axis: 'x' | 'y', available: number) => {
    const tracks = new Map<number, { extent: number; count: number }>();
    for (const child of children) {
      const slot = layout.slotAssignments.get(child.id);
      if (slot === undefined) continue;
      const track = tracks.get(slot) ?? { extent: 0, count: 0 };
      const size = getNodeSize(child);
      track.extent += axis === 'x' ? size.width : size.height;
      track.count += 1;
      tracks.set(slot, track);
    }
    return Math.min(
      ...[...tracks.values()].map((track) =>
        ratio(
          available - Math.max(0, track.count - 1) * metrics.contentSpacing,
          track.extent,
        ),
      ),
    );
  };
  return {
    x:
      mode === 'row'
        ? trackScale('x', availableWidth)
        : ratio(
            availableWidth - gutterSum('x'),
            (layout.columnTracks ?? []).reduce(
              (sum, track) => sum + track.width,
              0,
            ),
          ),
    y:
      mode === 'column'
        ? trackScale('y', availableHeight)
        : ratio(
            availableHeight - gutterSum('y'),
            (layout.rowTracks ?? []).reduce(
              (sum, track) => sum + track.height,
              0,
            ),
          ),
  };
}
