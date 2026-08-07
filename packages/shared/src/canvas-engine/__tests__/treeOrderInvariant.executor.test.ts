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

import { executeCanvasCommands } from '../index.js';

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
