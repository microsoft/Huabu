// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { applyStructuredFrameRelayout } from '../../autoLayout/gridLayout.js';
import { executeCanvasCommands } from '../../executor.js';
import { frameResponsiveMetricsForSize } from '../design.js';
import { structuredFrameResizeScale } from '../resize.js';

import type { CanvasNodeId } from '../../../index.js';
import type { Node, Edge } from '@xyflow/react';

function fixture(mode: string, sizing = 'hug'): Node[] {
  return [
    {
      id: 'f',
      type: 'frame',
      position: { x: 100, y: 100 },
      style: { width: 2400, height: 1800 },
      data: { sizing, layoutMode: mode, gridCount: 2 },
    },
    ...Array.from(
      { length: 5 },
      (_, i): Node => ({
        id: `c${i}`,
        type: 'image',
        parentId: 'f',
        position: { x: (i % 2) * 450, y: Math.floor(i / 2) * 350 },
        style: { width: 300 + i * 30, height: 200 + i * 50 },
        data: { frameColumn: i % 2, frameRow: Math.floor(i / 2) },
      }),
    ),
  ];
}

describe('responsive Frame geometry', () => {
  it.each(['column', 'row', 'grid'])(
    'keeps Manual %s spacing on the actual outer tier',
    (mode) => {
      const initial = fixture(mode, 'manual');
      const result = applyStructuredFrameRelayout(initial, ['f']).nodes;
      expect(result[0].style).toEqual(initial[0].style);
      expect(Math.min(...result.slice(1).map((node) => node.position.y))).toBe(
        152,
      );
      expect(Math.min(...result.slice(1).map((node) => node.position.x))).toBe(
        40,
      );
      expect(result.slice(1).map((node) => node.style)).toEqual(
        initial.slice(1).map((node) => node.style),
      );
    },
  );

  it.each(['column', 'row', 'grid'])(
    'converges %s independently of previous size',
    (mode) => {
      const nodes = fixture(mode);
      nodes[0].data.gridCount = 1;
      nodes.splice(2);
      nodes[1].style = { width: 560, height: 1100 };
      const once = applyStructuredFrameRelayout(nodes, ['f']).nodes;
      const twice = applyStructuredFrameRelayout(once, ['f']).nodes;
      expect(twice).toEqual(once);
      const metrics = frameResponsiveMetricsForSize(
        Number(once[0].style!.width),
        Number(once[0].style!.height),
      );
      expect(once[1].position.y).toBe(metrics.headerInset);
      const small = nodes.map((node) =>
        node.id === 'f'
          ? { ...node, style: { width: 100, height: 100 } }
          : node,
      );
      expect(applyStructuredFrameRelayout(small, ['f']).nodes).toEqual(once);
    },
  );

  it.each(['column', 'row', 'grid'])(
    'resizes %s through the real executor across tiers and release',
    (mode) => {
      const edges: Edge[] = [
        {
          id: 'e',
          source: 'c0',
          target: 'c1',
          data: { edgeStyle: { label: 'depends on' } },
        },
      ];
      const initial = applyStructuredFrameRelayout(
        fixture(mode),
        ['f'],
        undefined,
        { edges },
      ).nodes;
      for (const [width, height] of [
        [850, 700],
        [1400, 1200],
        [2400, 2000],
        [1000, 810],
      ]) {
        const scale = structuredFrameResizeScale(
          initial,
          edges,
          'f',
          width,
          height,
        )!;
        const items = initial.map((node) => ({
          nodeId: node.id as CanvasNodeId,
          position:
            node.id === 'f'
              ? { x: -40, y: -60 }
              : { x: node.position.x * scale.x, y: node.position.y * scale.y },
          size:
            node.id === 'f'
              ? { width, height }
              : {
                  width: Number(node.style!.width) * scale.x,
                  height: Number(node.style!.height) * scale.y,
                },
        }));
        const run = (nodes: Node[]) =>
          executeCanvasCommands(
            { source: 'ui', commands: [{ type: 'SET_NODE_GEOMETRY', items }] },
            { nodes, edges, canvasId: 'test' },
          ).writeResult.nodes;
        const result = run(initial);
        expect(Number(result[0].style!.width)).toBeCloseTo(width, 7);
        expect(Number(result[0].style!.height)).toBeCloseTo(height, 7);
        expect(result[0].position).toEqual({ x: -40, y: -60 });
        const released = executeCanvasCommands(
          {
            source: 'ui',
            commands: [{ type: 'SET_NODE_GEOMETRY', items: [items[0]] }],
          },
          { nodes: result, edges, canvasId: 'test' },
        ).writeResult.nodes;
        expect(released).toEqual(result);
        expect(run(result)).toEqual(result);
      }
    },
  );
});
