// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  describeStructuredDropZone,
  executeCanvasCommands,
  solveStructuredFrameLayout,
} from '@huabu/shared/canvas-engine';

import { resolveUiIntent } from '../../uiIntent';

import type { Node } from '@xyflow/react';

describe.each(['column', 'row'] as const)(
  'resolveNodeDragStop %s preview agreement',
  (axis) => {
    const column = axis === 'column';
    const field = column ? 'frameColumn' : 'frameRow';
    const along = column ? 'y' : 'x';

    function child(id: string, track: number, extent: number): Node {
      const size = column
        ? { width: 120, height: extent }
        : { width: extent, height: 120 };
      return {
        id,
        type: 'note',
        parentId: 'frame',
        position: { x: 0, y: 0 },
        data: { [field]: track },
        style: size,
        measured: size,
      };
    }

    it.each([
      { sizing: 'hug', soleSource: false },
      { sizing: 'manual', soleSource: false },
      { sizing: 'hug', soleSource: true },
      { sizing: 'manual', soleSource: true },
    ])(
      'commits the previewed insertion and peer positions ($sizing, sole source: $soleSource)',
      ({ sizing, soleSource }) => {
        const initial: Node[] = [
          {
            id: 'frame',
            type: 'frame',
            position: { x: 100, y: 200 },
            data: { layoutMode: axis, gridCount: 2, sizing },
            style: { width: 800, height: 800 },
            measured: { width: 800, height: 800 },
          },
          ...(soleSource ? [] : [child('source-peer', 0, 240)]),
          child('dragged', 0, 60),
          child('before', 1, 60),
          child('after', 1, 90),
          child('last', 1, 60),
        ];
        const layout = solveStructuredFrameLayout(initial, 'frame', 'compact');
        if (!layout) throw new Error('Missing fixture layout');
        const laidOut = initial.map((node) => ({
          ...node,
          position: layout.childPositions.get(node.id) ?? node.position,
        }));
        const before = layout.childPositions.get('before');
        const after = layout.childPositions.get('after');
        if (!before || !after) throw new Error('Missing target track peers');
        const position = {
          ...before,
          [along]: (before[along] + after[along]) / 2,
        };
        const nodes = laidOut.map((node) =>
          node.id === 'dragged' ? { ...node, position } : node,
        );
        const pointer = {
          x: position.x + (column ? 60 : 20),
          y: position.y + (column ? 20 : 60),
        };
        const size = column
          ? { width: 120, height: 60 }
          : { width: 60, height: 120 };
        const preview = describeStructuredDropZone(
          nodes,
          'frame',
          pointer,
          axis,
          2,
          { id: 'dragged', ...position, ...size },
        );
        if (!preview) throw new Error('Missing drop preview');
        expect(preview.kind).toBe('into-existing');

        const resolution = resolveUiIntent(
          {
            type: 'NODE_DRAG_STOP',
            draggedNodeIds: ['dragged'],
            pointerFlowPosition: {
              x: 100 + pointer.x,
              y: 200 + pointer.y,
            },
            cachedDecisions: new Map([
              ['dragged', { unframe: false, enterFrameId: null }],
            ]),
          },
          { nodes, edges: [] },
        );
        const committed = executeCanvasCommands(
          { source: 'ui', commands: resolution.commands },
          { nodes, edges: [], canvasId: 'canvas' },
        ).writeResult.nodes;
        const dropped = committed.find((node) => node.id === 'dragged');
        if (!dropped) throw new Error('Missing committed node');
        expect(dropped.position).toEqual({ x: preview.x, y: preview.y });
        for (const peer of preview.reflow) {
          expect(
            committed.find((node) => node.id === peer.id)?.position,
          ).toEqual({ x: peer.x, y: peer.y });
        }
        const ordered = committed
          .filter(
            (node) =>
              node.parentId === 'frame' &&
              node.data[field] === dropped.data[field],
          )
          .sort((a, b) => a.position[along] - b.position[along]);
        expect(ordered.map((node) => node.id)).toEqual([
          'before',
          'dragged',
          'after',
          'last',
        ]);
      },
    );
  },
);
