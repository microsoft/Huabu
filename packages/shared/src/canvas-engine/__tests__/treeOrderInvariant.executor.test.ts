// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Tests for the executor's authoritative end-of-batch tree-order pass.
 *
 * Individual commands (`CREATE_NODES`, `REORDER_NODES`, `SET_NODE_PARENT`)
 * no longer normalise tree order themselves — the invariant is enforced
 * once, at the single funnel every batch passes through
 * (`executeCanvasCommands`). These tests pin that contract: whatever the
 * commands leave behind, the batch output always lists every parent before
 * its children and gives frame children the frame `zIndex`, so React Flow
 * never throws "Parent node not found".
 */

import { describe, it, expect } from 'vitest';

import {
  executeCanvasCommands,
  admitSiblingReorder,
  assignNodeZIndices,
  applyOrderedDeltas,
  diffCanvasState,
  invertDeltas,
  solveStructuredFrameLayout,
} from '../index.js';

import type { CanvasCommand } from '../../types/canvas/index.js';
import type { CanvasNode, CanvasEdge } from '../interfaces.js';

function node(
  id: string,
  type = 'note',
  overrides: Partial<CanvasNode> = {},
): CanvasNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { type, label: id },
    ...overrides,
  } as CanvasNode;
}

function run(commands: unknown[], startNodes: CanvasNode[]) {
  return executeCanvasCommands(
    { source: 'ui', commands: commands as CanvasCommand[] },
    { nodes: startNodes, edges: [] as CanvasEdge[], canvasId: 'c1' },
  ).writeResult.nodes;
}

function indexOfId(nodes: CanvasNode[], id: string): number {
  return nodes.findIndex((n) => n.id === id);
}

describe('executeCanvasCommands: tree-order invariant', () => {
  it('reparents a node that sits before its new frame and repairs order + zIndex', () => {
    // `child` starts at index 0, the frame at index 1. `SET_NODE_PARENT`
    // keeps the child in its old slot, so without the end-of-batch pass the
    // child would remain ahead of its parent frame.
    const start = [node('child'), node('frame', 'frame')];
    const out = run(
      [{ type: 'SET_NODE_PARENT', nodeIds: ['child'], parentId: 'frame' }],
      start,
    );

    expect(indexOfId(out, 'frame')).toBeLessThan(indexOfId(out, 'child'));
    expect(out.find((n) => n.id === 'child')?.zIndex).toBe(-1);
  });

  describe('sibling reorder admission and render order', () => {
    const frame = (id: string, parentId?: string) =>
      node(id, 'frame', {
        ...(parentId ? { parentId, zIndex: -1 } : {}),
        data: { sizing: 'manual', layoutMode: 'free' },
        style: { width: 400, height: 400 },
      });
    const child = (id: string, parentId: string) =>
      node(id, 'note', { parentId, zIndex: -1 });

    it('moves a Frame subtree as one band without changing descendant sibling order', () => {
      const start = [
        frame('f'),
        child('f1', 'f'),
        frame('g'),
        child('g1', 'g'),
        node('a'),
      ];
      const out = run(
        [{ type: 'REORDER_NODES', nodeIds: ['f'], to: 'top' }],
        start,
      );
      expect(out.map((n) => n.id)).toEqual(['g', 'g1', 'a', 'f', 'f1']);
      expect([...assignNodeZIndices(out).keys()]).toEqual(out.map((n) => n.id));
      expect(out.find((n) => n.id === 'f1')).toBe(start[1]);
      const before = { nodes: start, edges: [] };
      const after = { nodes: out, edges: [] };
      const deltas = diffCanvasState(before, after, { orderVersion: 1 });
      expect(applyOrderedDeltas(before, deltas)).toEqual(after);
      expect(applyOrderedDeltas(after, invertDeltas(deltas))).toEqual(before);
    });

    it('keeps group order from the live siblings, not the request', () => {
      const start = [node('a'), node('b'), node('c')];
      const out = run(
        [{ type: 'REORDER_NODES', nodeIds: ['b', 'a'], to: { after: 'c' } }],
        start,
      );
      expect(out.map((n) => n.id)).toEqual(['c', 'a', 'b']);
    });

    it('supports legacy expanded subtree operands while strict admission rejects them', () => {
      const start = [frame('f'), child('c', 'f'), node('a')];
      expect(admitSiblingReorder(start, ['f', 'c'], 'top').valid).toBe(false);
      expect(
        run(
          [{ type: 'REORDER_NODES', nodeIds: ['f', 'c'], to: 'top' }],
          start,
        ).map((n) => n.id),
      ).toEqual(['a', 'f', 'c']);
    });

    it.each([
      { ids: ['a', 'missing'], to: 'top' },
      { ids: ['a', 'a'], to: 'top' },
      { ids: ['a', 'c'], to: 'top' },
      { ids: ['a'], to: { before: 'missing' } },
      { ids: ['a'], to: { after: 'c' } },
      { ids: ['a'], to: { after: 'a' } },
      { ids: ['f'], to: { after: 'c' } },
    ])('rejects invalid groups or stale/moved anchors: %j', ({ ids, to }) => {
      const nodes = [node('a'), frame('f'), child('c', 'f')];
      const output = executeCanvasCommands(
        {
          commands: [
            { type: 'REORDER_NODES', nodeIds: ids, to } as CanvasCommand,
          ],
        },
        { nodes, edges: [], canvasId: 'c1' },
      );
      expect(output.commandResults[0].applied).toBe(false);
      expect(output.writeResult.nodes).toBe(nodes);
      expect(output.writeResult.snapshotNeeded).toBe(false);
    });

    it('rechecks locks on source ancestors and destination ancestors', () => {
      const nodes = [
        frame('outer'),
        frame('inner', 'outer'),
        child('a', 'inner'),
        child('b', 'inner'),
        node('root'),
      ];
      nodes[0] = { ...nodes[0], data: { ...nodes[0].data, locked: true } };
      for (const command of [
        { type: 'REORDER_NODES', nodeIds: ['a'], to: 'top' },
        { type: 'SET_NODE_PARENT', nodeIds: ['a'], parentId: null },
        { type: 'SET_NODE_PARENT', nodeIds: ['root'], parentId: 'inner' },
      ]) {
        const result = executeCanvasCommands(
          { commands: [command as CanvasCommand] },
          { nodes, edges: [], canvasId: 'c1' },
        );
        expect(result.commandResults[0].applied).toBe(false);
        expect(result.writeResult.nodes).toBe(nodes);
      }
    });

    it('does not record an unchanged reorder', () => {
      const nodes = [node('node-a'), node('node-b')];
      const output = executeCanvasCommands(
        {
          commands: [{ type: 'REORDER_NODES', nodeIds: ['node-b'], to: 'top' }],
        },
        { nodes, edges: [], canvasId: 'c1' },
      );
      expect(output.commandResults[0]).toMatchObject({
        applied: false,
        reason: 'no-op',
      });
      expect(output.writeResult.snapshotNeeded).toBe(false);
      expect(
        diffCanvasState({ nodes, edges: [] }, output.writeResult, {
          orderVersion: 2,
        }),
      ).toEqual([]);
    });

    it('serializes consecutive insertions after the same live anchor', () => {
      let nodes = [node('a'), node('z')];
      for (const id of ['b', 'c']) {
        nodes = run(
          [
            {
              type: 'CREATE_NODES',
              nodes: [{ id, nodeType: 'note', position: { x: 0, y: 0 } }],
            },
            { type: 'REORDER_NODES', nodeIds: [id], to: { after: 'a' } },
          ],
          nodes,
        );
      }
      expect(nodes.map((n) => n.id)).toEqual(['a', 'c', 'b', 'z']);
    });

    it('reparents and orders in one replay/inverse without changing nested world geometry', () => {
      const nodes = [
        frame('f'),
        frame('nested', 'f'),
        child('inside', 'nested'),
        frame('g'),
        child('target', 'g'),
        node('root'),
      ];
      const out = run(
        [
          { type: 'SET_NODE_PARENT', nodeIds: ['nested'], parentId: 'g' },
          {
            type: 'REORDER_NODES',
            nodeIds: ['nested'],
            to: { after: 'target' },
          },
        ],
        nodes,
      );
      const before = { nodes, edges: [] };
      const after = { nodes: out, edges: [] };
      const deltas = diffCanvasState(before, after, { orderVersion: 2 });
      expect(applyOrderedDeltas(before, deltas)).toEqual(after);
      expect(applyOrderedDeltas(after, invertDeltas(deltas))).toEqual(before);
      expect(out.find((n) => n.id === 'inside')).toBe(nodes[2]);
      expect(out.map((n) => n.id)).toEqual([
        'f',
        'g',
        'target',
        'nested',
        'inside',
        'root',
      ]);
    });

    it.each(['column', 'row', 'grid'])(
      'keeps %s reading geometry and cells independent from paint order',
      (layoutMode) => {
        const nodes = [
          {
            ...frame('f'),
            data: { sizing: 'manual', layoutMode, gridCount: 1 },
          },
          {
            ...child('a', 'f'),
            position: { x: 30, y: 80 },
            data: { frameColumn: 0, frameRow: 0 },
            style: { width: 100, height: 100 },
          },
          {
            ...child('b', 'f'),
            position: { x: 180, y: 230 },
            data: { frameColumn: 0, frameRow: 1 },
            style: { width: 100, height: 100 },
          },
        ];
        const beforeLayout = solveStructuredFrameLayout(nodes, 'f');
        const out = run(
          [{ type: 'REORDER_NODES', nodeIds: ['a'], to: 'top' }],
          nodes,
        );
        expect(out.map((n) => n.id)).toEqual(['f', 'b', 'a']);
        expect(out.find((n) => n.id === 'a')).toBe(nodes[1]);
        expect(out.find((n) => n.id === 'b')).toBe(nodes[2]);
        const afterLayout = solveStructuredFrameLayout(out, 'f');
        expect(afterLayout).toEqual(beforeLayout);
      },
    );

    it('rejects reparent duplicates and cycles without partially moving members', () => {
      const nodes = [frame('f'), frame('g', 'f'), node('a')];
      for (const command of [
        { type: 'SET_NODE_PARENT', nodeIds: ['a', 'a'], parentId: 'g' },
        { type: 'SET_NODE_PARENT', nodeIds: ['a', 'missing'], parentId: 'g' },
        { type: 'SET_NODE_PARENT', nodeIds: ['a', 'f'], parentId: 'g' },
      ]) {
        const result = executeCanvasCommands(
          { commands: [command as CanvasCommand] },
          { nodes, edges: [], canvasId: 'c1' },
        );
        expect(result.commandResults[0].applied).toBe(false);
        expect(result.writeResult.nodes).toBe(nodes);
      }
    });
  });

  it('orders a frame ahead of a child created in the same batch', () => {
    // The child is listed BEFORE the frame in the create payload; the
    // executor must still emit the frame first so the child can nest.
    const out = run(
      [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'c' as never,
              nodeType: 'note',
              position: { x: 10, y: 10 },
              parentId: 'f' as never,
            },
            {
              id: 'f' as never,
              nodeType: 'frame',
              position: { x: 0, y: 0 },
            },
          ],
        },
      ],
      [],
    );

    expect(indexOfId(out, 'f')).toBeGreaterThanOrEqual(0);
    expect(indexOfId(out, 'c')).toBeGreaterThanOrEqual(0);
    expect(indexOfId(out, 'f')).toBeLessThan(indexOfId(out, 'c'));
    expect(out.find((n) => n.id === 'c')?.zIndex).toBe(-1);
  });

  it('keeps every parent ahead of its children across a multi-command batch', () => {
    // Reparent two children under a frame in one batch, then reorder one of
    // them to the top of the z-stack. The final array must still satisfy the
    // parent-before-child invariant no matter what the intermediate
    // command outputs looked like.
    const start = [node('a'), node('b'), node('frame', 'frame')];
    const out = run(
      [
        {
          type: 'SET_NODE_PARENT',
          nodeIds: ['a', 'b'],
          parentId: 'frame',
        },
        { type: 'REORDER_NODES', nodeIds: ['a'], to: 'top' },
      ],
      start,
    );

    const frameIdx = indexOfId(out, 'frame');
    expect(frameIdx).toBeLessThan(indexOfId(out, 'a'));
    expect(frameIdx).toBeLessThan(indexOfId(out, 'b'));
    expect(out.find((n) => n.id === 'a')?.zIndex).toBe(-1);
    expect(out.find((n) => n.id === 'b')?.zIndex).toBe(-1);
  });
});
