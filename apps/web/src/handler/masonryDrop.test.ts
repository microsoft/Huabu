// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import {
  describeStructuredDropZone,
  executeCanvasCommands,
  solveStructuredFrameLayout,
} from '@huabu/shared/canvas-engine';

import { resolveUiIntent } from './canvasCommand/uiIntent';
import {
  getGridDragGroup,
  gridDragRequests,
  resolveGridDrop,
  resolveMasonryDrop,
} from './masonryDrop';

import type * as CanvasEngine from '@huabu/shared/canvas-engine';
import type { Node } from '@xyflow/react';

vi.mock('@huabu/shared/canvas-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof CanvasEngine>();
  return {
    ...actual,
    solveStructuredFrameLayout: vi.fn(actual.solveStructuredFrameLayout),
  };
});

describe('Grid pointer gaps', () => {
  function scene() {
    const nodes: Node[] = [
      {
        id: 'frame',
        type: 'frame',
        position: { x: 0, y: 0 },
        data: { layoutMode: 'grid', gridCount: 2, sizing: 'manual' },
        style: { width: 800, height: 800 },
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `child-${index}`,
        type: 'note',
        parentId: 'frame',
        position: { x: 0, y: 0 },
        data: { frameColumn: index % 2, frameRow: Math.floor(index / 2) },
        style: { width: 120, height: 80 },
      })),
    ];
    const layout = solveStructuredFrameLayout(nodes, 'frame');
    if (!layout?.columnTracks || !layout.rowTracks)
      throw new Error('Missing Grid bands');
    return {
      nodes: nodes.map((node) => ({
        ...node,
        position: layout.childPositions.get(node.id) ?? node.position,
      })),
      columns: layout.columnTracks,
      rows: layout.rowTracks,
    };
  }

  it('solves once for both axes and reuses an explicitly supplied layout', () => {
    const { nodes } = scene();
    vi.mocked(solveStructuredFrameLayout).mockClear();
    resolveGridDrop(nodes, 'frame', { x: 30, y: 80 });
    expect(solveStructuredFrameLayout).toHaveBeenCalledTimes(1);
    const layout = solveStructuredFrameLayout(nodes, 'frame');
    vi.mocked(solveStructuredFrameLayout).mockClear();
    resolveGridDrop(nodes, 'frame', { x: 30, y: 80 }, { layout });
    expect(solveStructuredFrameLayout).not.toHaveBeenCalled();
  });

  it('keeps row-group columns relative to the actual anchor and clamps the whole span', () => {
    const { nodes } = scene();
    const group = getGridDragGroup(nodes, 'frame', ['child-0', 'child-1']);
    expect(group).not.toBeNull();
    if (!group) throw new Error('Missing row group');
    const requests = gridDragRequests(
      group,
      'child-1',
      {
        target: { kind: 'into-existing', slot: 0 },
        rowTarget: { kind: 'insert-new', slot: 2 },
      },
      2,
    );
    expect(requests.map((request) => request.target.slot)).toEqual([0, 1]);
    expect(requests.map((request) => request.rowTarget?.slot)).toEqual([2, 2]);
    expect(
      getGridDragGroup(nodes, 'frame', ['child-0', 'child-2']),
    ).toHaveLength(2);
    expect(getGridDragGroup(nodes, 'other', ['child-0', 'child-1'])).toBeNull();
  });

  it.each([
    { slot: 2, kind: 'into-existing', expected: [1, 2] },
    { slot: 0, kind: 'into-existing', expected: [0, 1] },
    { slot: 2, kind: 'insert-new', expected: [2, 3] },
  ] as const)(
    'preserves diagonal row offsets with $kind targeting',
    ({ slot, kind, expected }) => {
      const { nodes } = scene();
      const group = getGridDragGroup(nodes, 'frame', ['child-0', 'child-3']);
      if (!group) throw new Error('Missing Grid group');
      const requests = gridDragRequests(
        group,
        'child-3',
        {
          target: { kind: 'into-existing', slot: 0 },
          rowTarget: { kind, slot },
        },
        2,
      );
      expect(requests.map((request) => request.target.slot)).toEqual([0, 1]);
      expect(requests.map((request) => request.rowTarget?.slot)).toEqual(
        expected,
      );
      expect(
        getGridDragGroup(nodes, 'frame', ['child-0', 'child-0']),
      ).toBeNull();
    },
  );

  it('offers only row gaps for a row group, including at intersections', () => {
    const { nodes, columns, rows } = scene();
    const x = (columns[0].left + columns[0].width + columns[1].left) / 2;
    const y = (rows[0].top + rows[0].height + rows[1].top) / 2;
    expect(
      resolveGridDrop(nodes, 'frame', { x, y }, { insertAxis: 'row' }).gap
        ?.axis,
    ).toBe('row');
    expect(
      resolveGridDrop(
        nodes,
        'frame',
        { x, y: rows[0].top + 20 },
        { insertAxis: 'row' },
      ).gap,
    ).toBeNull();
  });

  it.each([0.5, 1, 2])(
    'uses narrow real gaps on both axes at zoom %s',
    (zoom) => {
      const { nodes, columns, rows } = scene();
      const x = (columns[0].left + columns[0].width + columns[1].left) / 2;
      const y = (rows[0].top + rows[0].height + rows[1].top) / 2;
      for (const axis of ['column', 'row'] as const) {
        const result = resolveGridDrop(
          nodes,
          'frame',
          axis === 'column'
            ? { x, y: rows[0].top + 20 }
            : { x: columns[0].left + 20, y },
          { zoom },
        );
        expect(result.target.kind).toBe('into-existing');
        expect(result.rowTarget.kind).toBe('into-existing');
        expect(result.gap?.axis).toBe(axis);
        if (!result.gap) throw new Error('Missing gap');
        expect(
          (axis === 'column' ? result.gap.width : result.gap.height) * zoom,
        ).toBeLessThanOrEqual(24);
      }
      const intersection = resolveGridDrop(nodes, 'frame', { x, y }, { zoom });
      expect(intersection.gap?.axis).toBe('column');
      expect(
        resolveGridDrop(
          nodes,
          'frame',
          { x, y },
          {
            zoom,
            previous: {
              ...intersection,
              gap: intersection.gap && { ...intersection.gap, axis: 'row' },
            },
          },
        ).gap?.axis,
      ).toBe('row');
      expect(
        resolveGridDrop(nodes, 'frame', { x, y }, { allowInsert: false }).gap,
      ).toBeNull();
      expect(
        resolveGridDrop(nodes, 'frame', { x: 790, y: 790 }).gap,
      ).toBeNull();
      for (const y of [
        rows[1].top,
        rows[1].top + 1,
        rows[1].top + rows[1].height - 1,
        rows[1].top + rows[1].height,
      ]) {
        const result = resolveGridDrop(nodes, 'frame', {
          x: columns[0].left + 20,
          y,
        });
        expect(result.rowTarget).toEqual({ kind: 'into-existing', slot: 1 });
        expect(result.gap).toBeNull();
      }
    },
  );

  it('keeps empty Grid rows addressable and uses edge-aware gaps', () => {
    const { nodes: initial } = scene();
    const nodes = initial.map((node) =>
      node.parentId === 'frame'
        ? {
            ...node,
            data: { ...node.data, frameRow: Number(node.data.frameRow) * 2 },
          }
        : node,
    );
    const edges = [
      {
        id: 'edge',
        source: 'child-0',
        target: 'child-1',
        data: { edgeStyle: { label: 'A wide internal connection label' } },
      },
    ];
    const layout = solveStructuredFrameLayout(nodes, 'frame', 'compact', {
      edges,
    });
    const row = layout?.rowTracks?.[1];
    const column = layout?.columnTracks?.[1];
    if (!row || !column) throw new Error('Missing empty row');
    const result = resolveGridDrop(
      nodes,
      'frame',
      {
        x: column.left + 20,
        y: row.top + row.height / 2,
      },
      { edges },
    );
    expect(result.target).toEqual({ kind: 'into-existing', slot: 1 });
    expect(result.rowTarget).toEqual({ kind: 'into-existing', slot: 1 });
    expect(result.gap).toBeNull();
    const first = layout.columnTracks?.[0];
    if (!first) throw new Error('Missing first column');
    expect(column.left - first.left - first.width).toBeGreaterThan(24);
    const gap = resolveGridDrop(
      nodes,
      'frame',
      {
        x: (first.left + first.width + column.left) / 2,
        y: row.top + row.height / 2,
      },
      { edges },
    ).gap;
    expect(gap?.axis).toBe('column');
    expect(gap?.width).toBe(24);
  });

  it('does not apply the column-count limit to Grid row insertion', () => {
    const { nodes: initial } = scene();
    const nodes = [
      initial[0],
      ...Array.from({ length: 26 }, (_, index) => ({
        ...initial[1],
        id: `child-${index}`,
        data: { frameColumn: index % 2, frameRow: Math.floor(index / 2) },
      })),
    ];
    const rows = solveStructuredFrameLayout(nodes, 'frame')?.rowTracks;
    if (!rows) throw new Error('Missing rows');
    expect(rows).toHaveLength(13);
    expect(
      resolveGridDrop(nodes, 'frame', {
        x: 50,
        y: (rows[0].top + rows[0].height + rows[1].top) / 2,
      }).gap?.axis,
    ).toBe('row');
  });

  it('ignores a cached armed gap during a multi-node drop', () => {
    const { nodes, columns, rows } = scene();
    const intent = {
      type: 'NODE_DRAG_STOP' as const,
      draggedNodeIds: ['child-4', 'child-5'],
      pointerFlowPosition: {
        x: (columns[0].left + columns[0].width + columns[1].left) / 2,
        y: (rows[0].top + rows[0].height + rows[1].top) / 2,
      },
      cachedDecisions: new Map(
        ['child-4', 'child-5'].map((id) => [
          id,
          { unframe: false, enterFrameId: null },
        ]),
      ),
    };
    const state = { nodes, edges: [] };
    expect(
      resolveUiIntent(
        {
          ...intent,
          masonryDrop: {
            nodeId: 'child-4',
            frameId: 'frame',
            target: { kind: 'insert-new', slot: 1 },
            rowTarget: { kind: 'insert-new', slot: 1 },
          },
        },
        state,
      ).commands,
    ).toEqual(resolveUiIntent(intent, state).commands);
  });

  it.each(['column', 'row'] as const)(
    'matches preview and release for a quick or armed %s drop',
    (axis) => {
      for (const armed of [false, true]) {
        const { nodes, columns, rows } = scene();
        const point = {
          x:
            axis === 'column'
              ? (columns[0].left + columns[0].width + columns[1].left) / 2
              : columns[0].left + 20,
          y:
            axis === 'row'
              ? (rows[0].top + rows[0].height + rows[1].top) / 2
              : rows[0].top + 20,
        };
        const picked = resolveGridDrop(nodes, 'frame', point);
        const target =
          armed && axis === 'column'
            ? { kind: 'insert-new' as const, slot: 1 }
            : picked.target;
        const rowTarget =
          armed && axis === 'row'
            ? { kind: 'insert-new' as const, slot: 1 }
            : picked.rowTarget;
        const dragged = nodes.find((node) => node.id === 'child-5');
        if (!dragged) throw new Error('Missing dragged child');
        const zone = describeStructuredDropZone(
          nodes,
          'frame',
          point,
          'grid',
          2,
          {
            id: dragged.id,
            x: dragged.position.x,
            y: dragged.position.y,
            width: 120,
            height: 80,
          },
          { target, rowTarget },
        );
        if (!zone) throw new Error('Missing preview');
        const resolution = resolveUiIntent(
          {
            type: 'NODE_DRAG_STOP',
            draggedNodeIds: [dragged.id],
            pointerFlowPosition: point,
            ...(armed
              ? {
                  masonryDrop: {
                    nodeId: dragged.id,
                    frameId: 'frame',
                    target,
                    rowTarget,
                  },
                }
              : {}),
            cachedDecisions: new Map([
              [dragged.id, { unframe: false, enterFrameId: null }],
            ]),
          },
          { nodes, edges: [] },
        );
        const committed = executeCanvasCommands(
          { source: 'ui', commands: resolution.commands },
          { nodes, edges: [], canvasId: 'canvas' },
        ).writeResult.nodes;
        expect(
          committed.find((node) => node.id === dragged.id)?.position,
        ).toEqual({ x: zone.x, y: zone.y });
        for (const peer of zone.reflow) {
          expect(
            committed.find((node) => node.id === peer.id)?.position,
          ).toEqual({ x: peer.x, y: peer.y });
        }
        expect(
          committed.find((node) => node.id === 'frame')?.data.gridCount,
        ).toBe(armed && axis === 'column' ? 3 : 2);
      }
    },
  );
});

describe.each(['column', 'row'] as const)('%s gap insertion', (axis) => {
  const field = axis === 'column' ? 'frameColumn' : 'frameRow';
  function scene(count = 2): Node[] {
    const nodes: Node[] = [
      {
        id: 'frame',
        type: 'frame',
        position: { x: 0, y: 0 },
        data: { layoutMode: axis, gridCount: count, sizing: 'hug' },
        style: { width: 800, height: 800 },
      },
      ...Array.from({ length: count * 2 }, (_, index) => ({
        id: `child-${index}`,
        type: 'note',
        parentId: 'frame',
        position: { x: index * 100, y: index * 80 },
        data: { [field]: Math.floor(index / 2) },
        style: { width: 120, height: 80 },
        measured: { width: 120, height: 80 },
      })),
    ];
    const layout = solveStructuredFrameLayout(nodes, 'frame', 'compact');
    if (!layout) throw new Error('Missing layout');
    return nodes.map((node) => ({
      ...node,
      position: layout.childPositions.get(node.id) ?? node.position,
    }));
  }
  const gapPoint = (slot: number) =>
    axis === 'column'
      ? { x: [10, 152, 294][slot], y: 120 }
      : { x: 120, y: [56, 156, 258][slot] };

  it.each([0.5, 1, 2])(
    'detects narrow internal gaps without arming them at zoom %s',
    (zoom) => {
      const nodes = scene();
      for (const slot of [0, 1, 2]) {
        const result = resolveMasonryDrop(
          nodes,
          'frame',
          axis,
          gapPoint(slot),
          { zoom },
        );
        expect(result.gap?.slot).toBe(slot);
        expect(result.target.kind).toBe('into-existing');
        if (!result.gap) throw new Error('Missing gap');
        expect(
          (axis === 'column' ? result.gap.width : result.gap.height) * zoom,
        ).toBeLessThanOrEqual(24);
      }
      for (const point of [
        { x: 1000, y: 1000 },
        { x: -10, y: 100 },
        { x: 100, y: -10 },
        { x: 100, y: 100 },
      ]) {
        expect(
          resolveMasonryDrop(nodes, 'frame', axis, point, { zoom }).gap,
        ).toBeNull();
      }
    },
  );

  it('retains the previous existing track in a gutter but clears insertion intent', () => {
    const nodes = scene();
    const point = gapPoint(1);
    expect(
      resolveMasonryDrop(nodes, 'frame', axis, point, {
        previous: { kind: 'into-existing', slot: 1 },
      }).target,
    ).toEqual({ kind: 'into-existing', slot: 1 });
    expect(
      resolveMasonryDrop(nodes, 'frame', axis, point, {
        previous: { kind: 'insert-new', slot: 1 },
      }).target.kind,
    ).toBe('into-existing');
  });

  it.each([0, 1])(
    'chooses the nearest boundary when track %s is wider or taller',
    (largerTrack) => {
      const dimension = axis === 'column' ? 'width' : 'height';
      const nodes = scene().map((node) => {
        if (node.parentId !== 'frame') return node;
        const size = {
          ...node.measured,
          [dimension]: node.data[field] === largerTrack ? 400 : 120,
        };
        return { ...node, style: { ...node.style, ...size }, measured: size };
      });
      const layout = solveStructuredFrameLayout(nodes, 'frame');
      const bands =
        axis === 'column'
          ? layout?.columnTracks?.map((track) => ({
              start: track.left,
              extent: track.width,
            }))
          : layout?.rowTracks?.map((track) => ({
              start: track.top,
              extent: track.height,
            }));
      if (!bands || bands.length !== 2)
        throw new Error('Missing fixture tracks');
      const end = bands[0].start + bands[0].extent;
      for (const [coordinate, slot] of [
        [bands[0].start - 1, 0],
        [end, 0],
        [end + 1, 0],
        [(end + bands[1].start) / 2, 0],
        [bands[1].start - 1, 1],
        [bands[1].start, 1],
        [bands[1].start + bands[1].extent + 1, 1],
      ]) {
        const point =
          axis === 'column'
            ? { x: coordinate, y: 100 }
            : { x: 100, y: coordinate };
        expect(resolveMasonryDrop(nodes, 'frame', axis, point).target).toEqual({
          kind: 'into-existing',
          slot,
        });
      }
    },
  );

  it('does not offer insertion for multiple nodes or at the track limit', () => {
    expect(
      resolveMasonryDrop(scene(), 'frame', axis, gapPoint(1), {
        allowInsert: false,
      }).gap,
    ).toBeNull();
    expect(
      resolveMasonryDrop(scene(12), 'frame', axis, gapPoint(1)).gap,
    ).toBeNull();
  });

  it.each([0.5, 1, 2])(
    'clips gaps to overflowing manual Frame bounds at zoom %s',
    (zoom) => {
      const original = scene();
      const point = gapPoint(1);
      const full = resolveMasonryDrop(original, 'frame', axis, point, {
        zoom,
      }).gap;
      if (!full) throw new Error('Missing internal gap');
      const size = { width: point.x + 2, height: point.y + 2 };
      const nodes = original.map((node) =>
        node.id === 'frame'
          ? {
              ...node,
              data: { ...node.data, sizing: 'manual' },
              style: size,
              measured: size,
            }
          : node,
      );
      const clipped = resolveMasonryDrop(nodes, 'frame', axis, point, {
        zoom,
      }).gap;
      expect(clipped).toEqual({
        ...full,
        width: Math.min(full.x + full.width, size.width) - full.x,
        height: Math.min(full.y + full.height, size.height) - full.y,
      });
      for (const outside of [
        gapPoint(2),
        { x: size.width, y: point.y },
        { x: point.x, y: size.height },
        { x: size.width + 1, y: point.y },
        { x: point.x, y: size.height + 1 },
      ]) {
        expect(
          resolveMasonryDrop(nodes, 'frame', axis, outside, { zoom }).gap,
        ).toBeNull();
      }
    },
  );

  it.each([
    { cachedSlot: 0, releaseSlot: 1, gutter: false },
    { cachedSlot: 1, releaseSlot: 0, gutter: false },
    { cachedSlot: 0, releaseSlot: 0, gutter: true },
    { cachedSlot: 1, releaseSlot: 1, gutter: true },
  ])(
    'rechecks release coordinates with cached track $cachedSlot (gutter: $gutter)',
    ({ cachedSlot, releaseSlot, gutter }) => {
      const nodes = scene();
      const peer = nodes.find((node) => node.id === `child-${releaseSlot * 2}`);
      if (!peer) throw new Error('Missing track peer');
      const point = gutter
        ? gapPoint(1)
        : { x: peer.position.x + 40, y: peer.position.y + 30 };
      const result = resolveUiIntent(
        {
          type: 'NODE_DRAG_STOP',
          draggedNodeIds: ['child-1'],
          pointerFlowPosition: point,
          cachedDecisions: new Map([
            ['child-1', { unframe: false, enterFrameId: null }],
          ]),
          masonryDrop: {
            nodeId: 'child-1',
            frameId: 'frame',
            target: { kind: 'into-existing', slot: cachedSlot },
          },
        },
        { nodes, edges: [] },
      );
      const committed = executeCanvasCommands(
        { source: 'ui', commands: result.commands },
        { nodes, edges: [], canvasId: 'canvas' },
      ).writeResult.nodes;
      expect(committed.find((node) => node.id === 'child-1')?.data[field]).toBe(
        releaseSlot,
      );
    },
  );

  it.each(
    [0, 1, 2].flatMap((slot) =>
      [true, false].map((cached) => ({ slot, cached })),
    ),
  )(
    'creates track $slot only with an armed preview (armed: $cached)',
    ({ slot, cached }) => {
      const original = scene();
      const point = gapPoint(slot);
      const position = { x: point.x - 30, y: point.y - 8 };
      const nodes = original.map((node) =>
        node.id === 'child-1' ? { ...node, position } : node,
      );
      const target = cached
        ? { kind: 'insert-new' as const, slot }
        : resolveMasonryDrop(nodes, 'frame', axis, point).target;
      const zone = describeStructuredDropZone(
        nodes,
        'frame',
        point,
        axis,
        2,
        { id: 'child-1', ...position, width: 120, height: 80 },
        { target },
      );
      if (!zone) throw new Error('Missing preview');
      const result = resolveUiIntent(
        {
          type: 'NODE_DRAG_STOP',
          draggedNodeIds: ['child-1'],
          pointerFlowPosition: point,
          cachedDecisions: new Map([
            ['child-1', { unframe: false, enterFrameId: null }],
          ]),
          masonryDrop: cached
            ? { nodeId: 'child-1', frameId: 'frame', target }
            : undefined,
        },
        { nodes, edges: [] },
      );
      const committed = executeCanvasCommands(
        { source: 'ui', commands: result.commands },
        { nodes, edges: [], canvasId: 'canvas' },
      ).writeResult.nodes;
      expect(
        committed.find((node) => node.id === 'frame')?.data.gridCount,
      ).toBe(cached ? 3 : 2);
      expect(committed.find((node) => node.id === 'child-1')?.position).toEqual(
        { x: zone.x, y: zone.y },
      );
      if (cached)
        expect(
          committed.find((node) => node.id === 'child-1')?.data[field],
        ).toBe(slot);
      for (const peer of zone.reflow) {
        expect(committed.find((node) => node.id === peer.id)?.position).toEqual(
          { x: peer.x, y: peer.y },
        );
      }
    },
  );
});
