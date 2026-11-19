// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  executeCanvasCommands,
  solveStructuredFrameLayout,
} from '@huabu/shared/canvas-engine';

import { resolveUiIntent } from '../../uiIntent';

import type { Node } from '@xyflow/react';

describe('resolveNodeDragStop multi-node drop in a column Frame', () => {
  function frame(id: string, x: number, order: string[]): Node {
    return {
      id,
      type: 'frame',
      position: { x, y: 0 },
      data: {
        layoutMode: 'column',
        gridCount: 1,
        sizing: 'hug',
        layoutOrder: [order],
      },
      style: { width: 400, height: 800 },
      measured: { width: 400, height: 800 },
    };
  }

  function child(id: string, parentId: string): Node {
    const size = { width: 120, height: 60 };
    return {
      id,
      type: 'note',
      parentId,
      position: { x: 0, y: 0 },
      data: { frameColumn: 0 },
      style: size,
      measured: size,
    };
  }

  it('keeps the dropped nodes adjacent instead of interleaving old members', () => {
    let nodes: Node[] = [
      frame('source', 0, ['a', 'spacer-1', 'spacer-2', 'b']),
      child('a', 'source'),
      child('spacer-1', 'source'),
      child('spacer-2', 'source'),
      child('b', 'source'),
      frame('target', 1000, ['t1', 't2', 't3', 't4']),
      child('t1', 'target'),
      child('t2', 'target'),
      child('t3', 'target'),
      child('t4', 'target'),
    ];
    for (const frameId of ['source', 'target']) {
      const layout = solveStructuredFrameLayout(nodes, frameId, 'compact');
      if (!layout) throw new Error('Missing fixture layout');
      nodes = nodes.map((node) => ({
        ...node,
        position: layout.childPositions.get(node.id) ?? node.position,
      }));
    }
    const at = (id: string) => {
      const node = nodes.find((candidate) => candidate.id === id);
      if (!node) throw new Error(`Missing ${id}`);
      return node.position;
    };
    // Drag both across by the same delta: `a` lands between t1 and t2, and
    // `b` keeps its source offset, which puts it below t3.
    const delta = { x: 1000, y: (at('t1').y + at('t2').y) / 2 - at('a').y };
    const dragged = nodes.map((node) =>
      node.id === 'a' || node.id === 'b'
        ? {
            ...node,
            position: {
              x: node.position.x + delta.x,
              y: node.position.y + delta.y,
            },
          }
        : node,
    );
    expect(at('b').y + delta.y).toBeGreaterThan(at('t3').y);

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: ['a', 'b'],
        pointerFlowPosition: {
          x: at('a').x + delta.x + 20,
          y: at('a').y + delta.y + 20,
        },
        cachedDecisions: new Map([
          ['a', { unframe: true, enterFrameId: 'target' }],
          ['b', { unframe: true, enterFrameId: 'target' }],
        ]),
      },
      { nodes: dragged, edges: [] },
    );
    const committed = executeCanvasCommands(
      { source: 'ui', commands: resolution.commands },
      { nodes: dragged, edges: [], canvasId: 'canvas' },
    ).writeResult.nodes;

    const expected = ['t1', 'a', 'b', 't2', 't3', 't4'];
    expect(
      committed.find((node) => node.id === 'target')?.data.layoutOrder,
    ).toEqual([expected]);
    expect(
      committed
        .filter((node) => node.parentId === 'target')
        .sort((x, y) => x.position.y - y.position.y)
        .map((node) => node.id),
    ).toEqual(expected);
  });

  it('gathers nodes dragged together within one Frame', () => {
    let nodes: Node[] = [
      frame('target', 0, ['a', 't1', 'b', 't2', 't3', 't4']),
      ...['a', 't1', 'b', 't2', 't3', 't4'].map((id) => child(id, 'target')),
    ];
    const layout = solveStructuredFrameLayout(nodes, 'target', 'compact');
    if (!layout) throw new Error('Missing fixture layout');
    nodes = nodes.map((node) => ({
      ...node,
      position: layout.childPositions.get(node.id) ?? node.position,
    }));
    const at = (id: string) => {
      const node = nodes.find((candidate) => candidate.id === id);
      if (!node) throw new Error(`Missing ${id}`);
      return node.position;
    };
    // `a` lands between t2 and t3; `b` keeps its offset and lands below t3.
    const dy = (at('t2').y + at('t3').y) / 2 - at('a').y;
    const dragged = nodes.map((node) =>
      node.id === 'a' || node.id === 'b'
        ? { ...node, position: { x: node.position.x, y: node.position.y + dy } }
        : node,
    );
    expect(at('b').y + dy).toBeGreaterThan(at('t3').y);

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: ['a', 'b'],
        pointerFlowPosition: { x: at('a').x + 20, y: at('a').y + dy + 20 },
        cachedDecisions: new Map([
          ['a', { unframe: false, enterFrameId: null }],
          ['b', { unframe: false, enterFrameId: null }],
        ]),
      },
      { nodes: dragged, edges: [] },
    );
    const committed = executeCanvasCommands(
      { source: 'ui', commands: resolution.commands },
      { nodes: dragged, edges: [], canvasId: 'canvas' },
    ).writeResult.nodes;

    const expected = ['t1', 't2', 'a', 'b', 't3', 't4'];
    expect(
      committed.find((node) => node.id === 'target')?.data.layoutOrder,
    ).toEqual([expected]);
    expect(
      committed
        .filter((node) => node.parentId === 'target')
        .sort((x, y) => x.position.y - y.position.y)
        .map((node) => node.id),
    ).toEqual(expected);
  });

  it('leaves the order alone when a nudge moves nothing to a new place', () => {
    const ids = ['a', 't1', 'b', 't2'];
    let nodes: Node[] = [
      frame('target', 0, ids),
      ...ids.map((id) => child(id, 'target')),
    ];
    const layout = solveStructuredFrameLayout(nodes, 'target', 'compact');
    if (!layout) throw new Error('Missing fixture layout');
    nodes = nodes.map((node) => ({
      ...node,
      position: layout.childPositions.get(node.id) ?? node.position,
    }));
    const dragged = nodes.map((node) =>
      node.id === 'a' || node.id === 'b'
        ? { ...node, position: { x: node.position.x, y: node.position.y + 5 } }
        : node,
    );
    const a = dragged.find((node) => node.id === 'a');
    if (!a) throw new Error('Missing a');

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: ['a', 'b'],
        pointerFlowPosition: { x: a.position.x + 20, y: a.position.y + 20 },
        cachedDecisions: new Map([
          ['a', { unframe: false, enterFrameId: null }],
          ['b', { unframe: false, enterFrameId: null }],
        ]),
      },
      { nodes: dragged, edges: [] },
    );
    const committed = executeCanvasCommands(
      { source: 'ui', commands: resolution.commands },
      { nodes: dragged, edges: [], canvasId: 'canvas' },
    ).writeResult.nodes;

    expect(
      committed.find((node) => node.id === 'target')?.data.layoutOrder,
    ).toEqual([ids]);
    for (const node of nodes.filter((node) => node.parentId === 'target')) {
      expect(
        committed.find((candidate) => candidate.id === node.id)?.position,
      ).toEqual(node.position);
    }
  });
});
