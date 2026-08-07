// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { EDGE_LABEL_MAX_INVERSE_SCALE } from '../../../types/canvas/edge.js';
import { executeCanvasCommands } from '../../executor.js';
import {
  applyColumnLayout,
  applyGridLayout,
  applyRowLayout,
} from '../gridLayout.js';

import type {
  CanvasCommand,
  CanvasNodeId,
} from '../../../types/canvas/command.js';
import type { Edge, Node } from '@xyflow/react';

function frame(layoutMode: 'column' | 'row' | 'grid' = 'column'): Node {
  return {
    id: 'frame',
    type: 'frame',
    position: { x: 0, y: 0 },
    data: { layoutMode, gridCount: 3 },
  } as Node;
}

/**
 * A framed child pinned to an explicit cell. Each mode addresses only
 * the axes it has, so the caller names them rather than passing a
 * mode-dependent "slot".
 */
function child(
  id: string,
  cell: { column?: number; row?: number },
  at = { x: (cell.column ?? 0) * 120, y: (cell.row ?? 0) * 100 },
): Node {
  return {
    id,
    type: 'text',
    parentId: 'frame',
    position: at,
    measured: { width: 100, height: 60 },
    data: {
      ...(cell.column === undefined ? {} : { frameColumn: cell.column }),
      ...(cell.row === undefined ? {} : { frameRow: cell.row }),
    },
  } as Node;
}

describe('structured edge gutters', () => {
  it('expands only the crossed column gutter for an edge label', () => {
    const LABEL = 'depends on';
    const edge = {
      id: 'edge-ab',
      source: 'a',
      target: 'b',
      data: { edgeStyle: { label: LABEL } },
    } as Edge;

    const result = applyColumnLayout(
      [
        frame(),
        child('a', { column: 0 }),
        child('b', { column: 1 }),
        child('c', { column: 2 }),
      ],
      'frame',
      3,
      'fill',
      { edges: [edge] },
    );

    expect(result).not.toBeNull();
    expect(result?.gutters).toHaveLength(2);
    // Only the gutter the edge crosses is widened, and it is widened to
    // the label's bounded extent plus clearance at the renderer's
    // maximum inverse scale.
    const labelledGutter = result?.gutters[0];
    // Char width 6 + horizontal inset 14, then clearance 32 at the
    // renderer's maximum inverse scale.
    const labelExtent = LABEL.length * 6 + 14;
    expect(labelledGutter?.requiredSize).toBe(
      (labelExtent + 32) * EDGE_LABEL_MAX_INVERSE_SCALE,
    );
    expect(labelledGutter?.finalSize).toBe(labelledGutter?.requiredSize);
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
      [
        frame('row'),
        child('a', { row: 0 }),
        child('b', { row: 1 }),
        child('c', { row: 2 }),
      ],
      'frame',
      3,
      'fill',
      { edges: [edge] },
    );

    expect(result?.gutters.map((gutter) => gutter.axis)).toEqual(['y', 'y']);
    // The edge spans both row boundaries, so both are widened.
    expect(
      result?.gutters.every((gutter) => gutter.requiredSize > gutter.baseSize),
    ).toBe(true);
  });

  it('plans both column and row-band gutters in grid mode', () => {
    const nodes = [
      frame('grid'),
      child('a', { column: 0, row: 0 }),
      child('b', { column: 1, row: 0 }),
      child('c', { column: 0, row: 1 }),
      child('d', { column: 1, row: 1 }),
    ];
    const edges = [
      { id: 'horizontal', source: 'a', target: 'b' } as Edge,
      { id: 'vertical', source: 'a', target: 'c' } as Edge,
    ];
    const result = applyGridLayout(nodes, 'frame', 2, 'compact', { edges });

    expect(result?.gutters.some((gutter) => gutter.axis === 'x')).toBe(true);
    expect(result?.gutters.some((gutter) => gutter.axis === 'y')).toBe(true);
  });

  it('assigns a diagonal Grid edge label to the X gutter only', () => {
    const nodes = [
      frame('grid'),
      child('a', { column: 0, row: 0 }),
      child('b', { column: 1, row: 1 }),
    ];
    const edge = {
      id: 'diagonal',
      source: 'a',
      target: 'b',
      data: { edgeStyle: { label: 'diagonal relationship' } },
    } as Edge;
    const result = applyGridLayout(nodes, 'frame', 2, 'compact', {
      edges: [edge],
    });
    const xGutter = result?.gutters.find((gutter) => gutter.axis === 'x');
    const yGutter = result?.gutters.find((gutter) => gutter.axis === 'y');

    expect(xGutter?.finalSize).toBeGreaterThan(xGutter?.baseSize ?? Infinity);
    expect(yGutter?.finalSize).toBe(yGutter?.baseSize);
    expect(yGutter?.requiredSize).toBe(yGutter?.baseSize);
  });

  it('uses frozen gutter sizes instead of recomputing label demand', () => {
    const edge = {
      id: 'edge-ab',
      source: 'a',
      target: 'b',
      data: { edgeStyle: { label: 'a much longer relationship label' } },
    } as Edge;
    const result = applyColumnLayout(
      [frame(), child('a', { column: 0 }), child('b', { column: 1 })],
      'frame',
      2,
      'fill',
      { edges: [edge], frozenGutters: { x: [40] } },
    );

    expect(result?.gutters[0].requiredSize).toBeGreaterThan(40);
    expect(result?.gutters[0].finalSize).toBe(40);
  });

  it('relayouts and reroutes immediately when an internal edge label changes', () => {
    const nodes = [
      frame(),
      child('a', { column: 0 }),
      child('b', { column: 1 }),
    ];
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

  it('leaves a free frame alone when an internal edge changes', () => {
    // A `free` frame has no gutters to recompute, so reporting it as
    // affected would only put it through the end-of-batch fit pass —
    // turning an edge restyle into a frame resize that saves, broadcasts
    // and shares the restyle's undo step.
    const nodes = [
      { ...frame(), data: { layoutMode: 'free', sizing: 'hug' } } as Node,
      child('a', {}, { x: 40, y: 40 }),
      child('b', {}, { x: 400, y: 300 }),
    ];
    const edge = { id: 'edge-ab', source: 'a', target: 'b' } as Edge;

    const { writeResult } = executeCanvasCommands(
      {
        commands: [
          {
            type: 'SET_EDGE_STYLE',
            edges: [{ edge: 'edge-ab', style: { label: 'relates to' } }],
          } as CanvasCommand,
        ],
      },
      { nodes, edges: [edge], canvasId: 'canvas' },
    );

    expect(writeResult.nodes.find((node) => node.id === 'frame')).toEqual(
      nodes[0],
    );
  });

  it('preserves edge-aware X gutters when Grid drag geometry resizes the frame', () => {
    const nodes = [
      frame('grid'),
      child('a', { column: 0 }),
      child('b', { column: 1 }),
    ];
    const edge = {
      id: 'edge-ab',
      source: 'a',
      target: 'b',
      data: { edgeStyle: { label: 'a wide relationship label' } },
    } as Edge;
    const expected = applyGridLayout(nodes, 'frame', 3, 'compact', {
      edges: [edge],
    });
    const command = {
      type: 'SET_NODE_GEOMETRY',
      items: [
        {
          nodeId: 'frame' as CanvasNodeId,
          size: { width: 300, height: 180 },
        },
        {
          nodeId: 'b' as CanvasNodeId,
          position: { x: 120, y: 0 },
        },
      ],
    } as CanvasCommand;

    const { writeResult } = executeCanvasCommands(
      { commands: [command] },
      { nodes, edges: [edge], canvasId: 'canvas' },
    );
    const moved = writeResult.nodes.find((node) => node.id === 'b');

    expect(moved?.position.x).toBe(expected?.childPositions.get('b')?.x);
    expect(moved?.position.x).toBeGreaterThan(120);
  });
});
