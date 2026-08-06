// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Tests for `assignNodeZIndices` / `edgeZIndex` — the explicit
 * manual-mode stacking derivation that makes forest/array order the sole
 * z-order authority (later in the forest = painted on top), replacing
 * React Flow's `auto`-mode heuristics that force framed subtrees above
 * unframed siblings.
 */

import { describe, it, expect } from 'vitest';

import { indexById, type NestableNode } from '../tree.js';
import { assignNodeZIndices, edgeZIndex } from '../zorder.js';

function node(id: string, overrides: Partial<NestableNode> = {}): NestableNode {
  return {
    id,
    type: 'note',
    position: { x: 0, y: 0 },
    data: {},
    ...overrides,
  } as NestableNode;
}

function frame(
  id: string,
  overrides: Partial<NestableNode> = {},
): NestableNode {
  return node(id, { type: 'frame', ...overrides });
}

describe('assignNodeZIndices', () => {
  it('assigns contiguous z in array order for a flat list', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const z = assignNodeZIndices(nodes);
    expect(z.get('a')).toBe(0);
    expect(z.get('b')).toBe(1);
    expect(z.get('c')).toBe(2);
  });

  it('places children immediately above their parent frame (child covers frame)', () => {
    // Forest order: frame f, then its children c1, c2.
    const nodes = [
      frame('f'),
      node('c1', { parentId: 'f' }),
      node('c2', { parentId: 'f' }),
    ];
    const z = assignNodeZIndices(nodes);
    expect(z.get('f')).toBe(0);
    expect(z.get('c1')).toBe(1);
    expect(z.get('c2')).toBe(2);
    // Every child paints above its own frame.
    expect(z.get('c1')! > z.get('f')!).toBe(true);
    expect(z.get('c2')! > z.get('f')!).toBe(true);
  });

  it('lets a node ordered after a frame cover the ENTIRE frame subtree', () => {
    // The regression: `loose` sits after frame `f` in array order and must
    // out-rank the frame AND all of its children.
    const nodes = [
      frame('f'),
      node('c1', { parentId: 'f' }),
      node('c2', { parentId: 'f' }),
      node('loose'),
    ];
    const z = assignNodeZIndices(nodes);
    expect(z.get('loose')!).toBeGreaterThan(z.get('f')!);
    expect(z.get('loose')!).toBeGreaterThan(z.get('c1')!);
    expect(z.get('loose')!).toBeGreaterThan(z.get('c2')!);
  });

  it('conversely, a node ordered BEFORE a frame is covered by the frame subtree', () => {
    const nodes = [node('loose'), frame('f'), node('c1', { parentId: 'f' })];
    const z = assignNodeZIndices(nodes);
    expect(z.get('loose')!).toBeLessThan(z.get('f')!);
    expect(z.get('loose')!).toBeLessThan(z.get('c1')!);
  });

  it('keeps each frame subtree contiguous with nested frames', () => {
    // f1 { c1, f2 { c2 } }, then top-level loose.
    const nodes = [
      frame('f1'),
      node('c1', { parentId: 'f1' }),
      frame('f2', { parentId: 'f1' }),
      node('c2', { parentId: 'f2' }),
      node('loose'),
    ];
    const z = assignNodeZIndices(nodes);
    // DFS contiguous: f1(0) c1(1) f2(2) c2(3) loose(4)
    expect(z.get('f1')).toBe(0);
    expect(z.get('c1')).toBe(1);
    expect(z.get('f2')).toBe(2);
    expect(z.get('c2')).toBe(3);
    expect(z.get('loose')).toBe(4);
    // Deepest child still above all its ancestors.
    expect(z.get('c2')!).toBeGreaterThan(z.get('f2')!);
    expect(z.get('c2')!).toBeGreaterThan(z.get('f1')!);
  });

  it('treats a dangling parentId as a root (no crash, still assigns z)', () => {
    const nodes = [node('orphan', { parentId: 'missing' }), node('b')];
    const z = assignNodeZIndices(nodes);
    expect(z.get('orphan')).toBeDefined();
    expect(z.get('b')).toBeDefined();
    expect(z.size).toBe(2);
  });

  it('assigns a z to every node even under a parent cycle', () => {
    const nodes = [node('x', { parentId: 'y' }), node('y', { parentId: 'x' })];
    const z = assignNodeZIndices(nodes);
    expect(z.size).toBe(2);
    expect(z.get('x')).toBeDefined();
    expect(z.get('y')).toBeDefined();
  });
});

describe('edgeZIndex', () => {
  it('is 0 for an edge between two top-level (unframed) nodes', () => {
    const nodes = [node('a'), node('b')];
    const z = assignNodeZIndices(nodes);
    const byId = indexById(nodes);
    expect(edgeZIndex(z, byId, 'a', 'b')).toBe(0);
  });

  it('floats to the framed endpoint z so it paints above the frame background', () => {
    const nodes = [frame('f'), node('c', { parentId: 'f' }), node('top')];
    const z = assignNodeZIndices(nodes);
    const byId = indexById(nodes);
    // Endpoint `c` is framed → edge rides at c's z; `top` unframed → 0.
    expect(edgeZIndex(z, byId, 'c', 'top')).toBe(z.get('c'));
  });

  it('takes the max of two framed endpoints', () => {
    const nodes = [
      frame('f1'),
      node('c1', { parentId: 'f1' }),
      frame('f2'),
      node('c2', { parentId: 'f2' }),
    ];
    const z = assignNodeZIndices(nodes);
    const byId = indexById(nodes);
    expect(edgeZIndex(z, byId, 'c1', 'c2')).toBe(
      Math.max(z.get('c1')!, z.get('c2')!),
    );
  });

  it('treats a dangling-parent endpoint as top-level (contributes 0)', () => {
    // Matches `assignNodeZIndices`, which treats a node whose `parentId`
    // does not resolve as a root. `edgeZIndex` must agree so a mid-delete
    // dangling parent never spuriously lifts the edge.
    const nodes = [node('orphan', { parentId: 'missing' }), node('b')];
    const z = assignNodeZIndices(nodes);
    const byId = indexById(nodes);
    expect(edgeZIndex(z, byId, 'orphan', 'b')).toBe(0);
  });
});
