// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { FRAME_GRID_MAX_COUNT } from '@huabu/shared';
import {
  FRAME_LAYOUT_CONFIG,
  getNodeSize,
  readFrameGridConfig,
  readFrameGridRow,
  readFrameTrack,
  solveStructuredFrameLayout,
  type FrameAxis,
  type StructuredDropTarget,
  type StructuredDropRequest,
} from '@huabu/shared/canvas-engine';

import type { Edge, Node } from '@xyflow/react';

export interface TrackDropGap {
  axis?: FrameAxis;
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
    layout = solveStructuredFrameLayout(nodes, frameId, 'compact', { edges }),
  }: {
    edges?: readonly Edge[];
    zoom?: number;
    allowInsert?: boolean;
    previous?: StructuredDropTarget;
    layout?: ReturnType<typeof solveStructuredFrameLayout>;
  } = {},
): { target: StructuredDropTarget; gap: TrackDropGap | null } {
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
  const gridRow = axis === 'row' && readFrameGridConfig(frame)?.axis === 'grid';
  if (allowInsert && (gridRow || bands.length < FRAME_GRID_MAX_COUNT)) {
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
    return { target: { kind: 'into-existing', slot: inside }, gap: null };
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

/** Grid shares the same narrow gaps and nearest-boundary targets on both axes. */
export function resolveGridDrop(
  nodes: Node[],
  frameId: string,
  point: { x: number; y: number },
  options: {
    edges?: readonly Edge[];
    zoom?: number;
    allowInsert?: boolean;
    layout?: ReturnType<typeof solveStructuredFrameLayout>;
    insertAxis?: FrameAxis;
    previous?: {
      target: StructuredDropTarget;
      rowTarget?: StructuredDropTarget;
      gap?: TrackDropGap | null;
    };
  } = {},
) {
  const layout =
    options.layout === undefined
      ? solveStructuredFrameLayout(nodes, frameId, 'compact', {
          edges: options.edges,
        })
      : options.layout;
  const column = resolveMasonryDrop(nodes, frameId, 'column', point, {
    ...options,
    layout,
    allowInsert: options.allowInsert !== false && options.insertAxis !== 'row',
    previous: options.previous?.target,
  });
  const row = resolveMasonryDrop(nodes, frameId, 'row', point, {
    ...options,
    layout,
    allowInsert:
      options.allowInsert !== false && options.insertAxis !== 'column',
    previous: options.previous?.rowTarget,
  });
  // Keep the chosen axis at intersections; a fresh intersection prefers columns.
  const gap: TrackDropGap | null =
    row.gap && (!column.gap || options.previous?.gap?.axis === 'row')
      ? { ...row.gap, axis: 'row' }
      : column.gap
        ? { ...column.gap, axis: 'column' }
        : null;
  return { target: column.target, rowTarget: row.target, gap };
}

/** A selection within one Grid moves in cell space, independently of rendered sizes. */
export function getGridDragGroup(
  nodes: Node[],
  frameId: string,
  ids: readonly string[],
): Node[] | null {
  if (
    ids.length < 2 ||
    readFrameGridConfig(nodes.find((node) => node.id === frameId))?.axis !==
      'grid'
  )
    return null;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const group: Node[] = [];
  for (const id of ids) {
    const node = byId.get(id);
    if (
      !node ||
      node.parentId !== frameId ||
      readFrameGridRow(node) === undefined ||
      readFrameTrack(node, 'column') === undefined
    )
      return null;
    group.push(node);
  }
  return new Set(
    group.map(
      (node) => `${readFrameTrack(node, 'column')}:${readFrameGridRow(node)}`,
    ),
  ).size === group.length
    ? group
    : null;
}

export function gridDragRequests(
  group: Node[],
  anchorId: string,
  drop: { target: StructuredDropTarget; rowTarget: StructuredDropTarget },
  count: number,
): StructuredDropRequest[] {
  const columns = group.map((node) => readFrameTrack(node, 'column') ?? 0);
  const rows = group.map((node) => readFrameGridRow(node) ?? 0);
  const anchor = group.findIndex((node) => node.id === anchorId);
  const shift = Math.max(
    -Math.min(...columns),
    Math.min(
      count - 1 - Math.max(...columns),
      drop.target.slot - columns[Math.max(0, anchor)],
    ),
  );
  // A gap names the top of the whole block; a cell names the grabbed member.
  const rowShift = Math.max(
    -Math.min(...rows),
    drop.rowTarget.slot -
      (drop.rowTarget.kind === 'insert-new'
        ? Math.min(...rows)
        : rows[Math.max(0, anchor)]),
  );
  return group.map((node, index) => ({
    nodeId: node.id,
    target: { kind: 'into-existing', slot: columns[index] + shift },
    rowTarget: { ...drop.rowTarget, slot: rows[index] + rowShift },
  }));
}
