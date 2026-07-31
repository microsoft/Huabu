import { describe, expect, it } from 'vitest';

import { EDGE_LABEL_MAX_INVERSE_SCALE } from '../../../types/canvas/edge.js';
import { executeCanvasCommands } from '../../executor.js';
import {
  applyColumnLayout,
  applyGridLayout,
  applyRowLayout,
} from '../gridLayout.js';

import type { CanvasCommand } from '../../../types/canvas/command.js';
import type { Edge, Node } from '@xyflow/react';

function frame(layoutMode: 'column' | 'row' | 'grid' = 'column'): Node {
  return {
    id: 'frame',
    type: 'frame',
    position: { x: 0, y: 0 },
    data: { layoutMode, gridCount: 3 },
  } as Node;
}

function child(id: string, slot: number): Node {
  return {
    id,
    type: 'text',
    parentId: 'frame',
    position: { x: slot * 120, y: 0 },
    measured: { width: 100, height: 60 },
    data: { frameSlot: slot },
  } as Node;
}

describe('structured edge gutters', () => {
  it('expands only the crossed column gutter for an edge label', () => {
    const edge = {
      id: 'edge-ab',
      source: 'a',
      target: 'b',
      data: { edgeStyle: { label: 'depends on' } },
    } as Edge;

    const result = applyColumnLayout(
      [frame(), child('a', 0), child('b', 1), child('c', 2)],
      'frame',
      3,
      'fill',
      { edges: [edge] },
    );

    expect(result).not.toBeNull();
    expect(result?.gutters).toHaveLength(2);
    const labelledGutter = result?.gutters[0];
    expect(labelledGutter?.requiredSize).toBe(
      ((labelledGutter?.lanes[0].labelExtent ?? 0) + 32) *
        EDGE_LABEL_MAX_INVERSE_SCALE,
    );
    expect(result?.gutters[1].finalSize).toBe(result?.gutters[1].baseSize);
    expect(result?.slotAssignments).toEqual(
      new Map([
        ['a', 0],
        ['b', 1],
        ['c', 2],
      ]),
    );
  });

  it('mirrors edge demand onto row gutters', () => {
    const edge = {
      id: 'edge-ac',
      source: 'a',
      target: 'c',
      data: { edgeStyle: { label: 'blocks' } },
    } as Edge;
    const result = applyRowLayout(
      [frame('row'), child('a', 0), child('b', 1), child('c', 2)],
      'frame',
      3,
      'fill',
      { edges: [edge] },
    );

    expect(result?.gutters.map((gutter) => gutter.axis)).toEqual(['y', 'y']);
    expect(result?.gutters.every((gutter) => gutter.lanes.length === 1)).toBe(
      true,
    );
  });

  it('plans both column and row-band gutters in grid mode', () => {
    const nodes = [
      frame('grid'),
      child('a', 0),
      child('b', 1),
      { ...child('c', 0), position: { x: 0, y: 100 } },
      { ...child('d', 1), position: { x: 120, y: 100 } },
    ];
    const edges = [
      { id: 'horizontal', source: 'a', target: 'b' } as Edge,
      { id: 'vertical', source: 'a', target: 'c' } as Edge,
    ];
    const result = applyGridLayout(nodes, 'frame', 2, 'compact', { edges });

    expect(result?.gutters.some((gutter) => gutter.axis === 'x')).toBe(true);
    expect(result?.gutters.some((gutter) => gutter.axis === 'y')).toBe(true);
  });

  it('uses frozen gutter sizes instead of recomputing label demand', () => {
    const edge = {
      id: 'edge-ab',
      source: 'a',
      target: 'b',
      data: { edgeStyle: { label: 'a much longer relationship label' } },
    } as Edge;
    const result = applyColumnLayout(
      [frame(), child('a', 0), child('b', 1)],
      'frame',
      2,
      'fill',
      { edges: [edge], frozenGutters: { x: [40] } },
    );

    expect(result?.gutters[0].requiredSize).toBeGreaterThan(40);
    expect(result?.gutters[0].finalSize).toBe(40);
  });

  it('relayouts and reroutes immediately when an internal edge label changes', () => {
    const nodes = [frame(), child('a', 0), child('b', 1)];
    const edge = { id: 'edge-ab', source: 'a', target: 'b' } as Edge;
    const before = applyColumnLayout(nodes, 'frame', 2, 'fill', {
      edges: [edge],
    });
    const command = {
      type: 'SET_EDGE_STYLE',
      edges: [
        {
          edge: 'edge-ab',
          style: { label: 'a deliberately wide relationship label' },
        },
      ],
    } as CanvasCommand;

    const { writeResult } = executeCanvasCommands(
      { commands: [command] },
      { nodes, edges: [edge], canvasId: 'canvas' },
    );
    const moved = writeResult.nodes.find((node) => node.id === 'b');

    expect(moved?.position.x).toBeGreaterThan(
      before?.childPositions.get('b')?.x ?? Number.POSITIVE_INFINITY,
    );
    expect(writeResult.requiresEdgeReroute).toBe(true);
  });
});
