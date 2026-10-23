// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { FRAME_GRID_MAX_COUNT } from '@huabu/shared';
import {
  FRAME_LAYOUT_CONFIG,
  getNodeSize,
  solveStructuredFrameLayout,
  type FrameAxis,
  type StructuredDropTarget,
} from '@huabu/shared/canvas-engine';

import type { Edge, Node } from '@xyflow/react';

export interface TrackDropGap {
  slot: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isPointInTrackGap(
  gap: TrackDropGap,
  point: { x: number; y: number },
) {
  return (
    point.x >= gap.x &&
    point.x < gap.x + gap.width &&
    point.y >= gap.y &&
    point.y < gap.y + gap.height
  );
}

/** Gap detection never arms insertion; the preview owns the dwell timer. */
export function resolveMasonryDrop(
  nodes: Node[],
  frameId: string,
  axis: FrameAxis,
  point: { x: number; y: number },
  {
    edges = [],
    zoom = 1,
    allowInsert = true,
    previous,
  }: {
    edges?: readonly Edge[];
    zoom?: number;
    allowInsert?: boolean;
    previous?: StructuredDropTarget;
  } = {},
): { target: StructuredDropTarget; gap: TrackDropGap | null } {
  const layout = solveStructuredFrameLayout(nodes, frameId, 'compact', {
    edges,
  });
  const column = axis === 'column';
  const bands = column
    ? (layout?.columnTracks ?? []).map((track) => ({
        start: track.left,
        extent: track.width,
      }))
    : (layout?.rowTracks ?? []).map((track) => ({
        start: track.top,
        extent: track.height,
      }));
  if (!bands.length || !layout)
    return { target: { kind: 'into-existing', slot: 0 }, gap: null };

  const { headerInset, contentSpacing } = FRAME_LAYOUT_CONFIG.metrics;
  const frame = nodes.find((node) => node.id === frameId);
  if (!frame) return { target: { kind: 'into-existing', slot: 0 }, gap: null };
  const frameSize = getNodeSize(frame);
  let gap: TrackDropGap | null = null;
  if (allowInsert && bands.length < FRAME_GRID_MAX_COUNT) {
    for (let slot = 0; slot <= bands.length; slot++) {
      const before = bands[slot - 1];
      const after = bands[slot];
      const start = before
        ? before.start + before.extent
        : column
          ? 0
          : headerInset - 16;
      const end = after ? after.start : start + contentSpacing;
      const width = Math.min(end - start, 24 / zoom);
      const candidate: TrackDropGap = {
        slot,
        x: column ? (start + end - width) / 2 : contentSpacing,
        y: column ? headerInset : (start + end - width) / 2,
        width: column ? width : layout.frameSize.width - 2 * contentSpacing,
        height: column
          ? layout.frameSize.height - headerInset - contentSpacing
          : width,
      };
      const x = Math.max(0, candidate.x);
      const y = Math.max(0, candidate.y);
      const clipped = {
        ...candidate,
        x,
        y,
        width: Math.min(frameSize.width, candidate.x + candidate.width) - x,
        height: Math.min(frameSize.height, candidate.y + candidate.height) - y,
      };
      if (
        clipped.width > 0 &&
        clipped.height > 0 &&
        isPointInTrackGap(clipped, point)
      ) {
        gap = clipped;
        break;
      }
    }
  }
  const coordinate = column ? point.x : point.y;
  const inside = bands.findIndex(
    (band) =>
      coordinate >= band.start && coordinate <= band.start + band.extent,
  );
  if (inside >= 0)
    return { target: { kind: 'into-existing', slot: inside }, gap };
  if (
    previous?.kind === 'into-existing' &&
    previous.slot < bands.length &&
    coordinate >= bands[0].start &&
    coordinate <= bands[bands.length - 1].start + bands[bands.length - 1].extent
  ) {
    return { target: previous, gap };
  }
  let slot = 0;
  let distance = Infinity;
  bands.forEach((band, index) => {
    const next = Math.max(
      band.start - coordinate,
      coordinate - (band.start + band.extent),
      0,
    );
    if (next < distance) {
      slot = index;
      distance = next;
    }
  });
  return { target: { kind: 'into-existing', slot }, gap };
}
