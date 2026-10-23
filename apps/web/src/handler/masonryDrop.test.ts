// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  describeStructuredDropZone,
  executeCanvasCommands,
  solveStructuredFrameLayout,
} from '@huabu/shared/canvas-engine';

import { resolveUiIntent } from './canvasCommand/uiIntent';
import { resolveMasonryDrop } from './masonryDrop';

import type { Node } from '@xyflow/react';

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
