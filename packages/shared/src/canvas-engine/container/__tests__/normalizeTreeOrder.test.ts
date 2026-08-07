// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Tests for `normalizeTreeOrder` — the tree-order invariant enforcer
 * React Flow depends on: parents must precede their children in the array,
 * frame children carry `zIndex === -1`, dangling parent links are dropped,
 * and cycles are broken.
 *
 * The executor now runs this once per applied batch (see the end-of-batch
 * pass in `executor.ts`), so the "already valid" fast path is load-bearing
 * for performance. These tests pin two things:
 *   1. the fast path and the full repair pass agree on what "valid" means
 *      (a repaired output must be recognised as already-valid — proven by
 *      the function returning the SAME reference on a second pass); and
 *   2. every documented invariant is actually repaired.
 */

import { describe, it, expect } from 'vitest';

import { isContainerNode } from '../policy.js';
import { normalizeTreeOrder, type NestableNode } from '../tree.js';

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

/**
 * Independent re-implementation of the invariants the function guarantees,
 * used to assert repaired output is genuinely valid regardless of how it
 * was produced. Kept deliberately separate from the production code so a
 * regression in either surface is caught by disagreement.
 */
function isValid(nodes: NestableNode[]): boolean {
  const index = new Map(nodes.map((n, i) => [n.id, i] as const));
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n.parentId) {
      if (n.type !== 'frame' && n.zIndex === -1) return false;
      continue;
    }
    const parentIndex = index.get(n.parentId);
    // Parent must be present and strictly before the child.
    if (parentIndex === undefined || parentIndex >= i) return false;
    if (!isContainerNode(byId.get(n.parentId))) return false;
    if (byId.get(n.parentId)?.type === 'frame' && n.zIndex !== -1) return false;
  }
  return true;
}

describe('normalizeTreeOrder — fast path (already valid)', () => {
  it('returns the SAME array reference for a valid flat list', () => {
    const nodes = [node('a'), node('b'), node('c')];
    expect(normalizeTreeOrder(nodes)).toBe(nodes);
  });

  it('returns the SAME reference when a frame precedes its zIndexed children', () => {
    const nodes = [
      frame('f'),
      node('c1', { parentId: 'f', zIndex: -1 }),
      node('c2', { parentId: 'f', zIndex: -1 }),
    ];
    expect(normalizeTreeOrder(nodes)).toBe(nodes);
  });

  it('accepts a top-level frame that carries zIndex === -1', () => {
    // A top-level frame is allowed to keep the frame zIndex; only
    // top-level NON-frame nodes must not.
    const nodes = [frame('f', { zIndex: -1 }), node('a')];
    expect(normalizeTreeOrder(nodes)).toBe(nodes);
  });

  it('accepts a nested frame child that also carries zIndex === -1', () => {
    const nodes = [
      frame('outer'),
      frame('inner', { parentId: 'outer', zIndex: -1 }),
      node('leaf', { parentId: 'inner', zIndex: -1 }),
    ];
    expect(normalizeTreeOrder(nodes)).toBe(nodes);
  });
});

describe('normalizeTreeOrder — repair pass', () => {
  it('reorders a child that appears before its parent', () => {
    const nodes = [node('c', { parentId: 'f', zIndex: -1 }), frame('f')];
    const out = normalizeTreeOrder(nodes);
    expect(out).not.toBe(nodes);
    const ids = out.map((n) => n.id);
    expect(ids.indexOf('f')).toBeLessThan(ids.indexOf('c'));
    expect(isValid(out)).toBe(true);
  });

  it('drops a dangling parentId (parent not present)', () => {
    const nodes = [node('a', { parentId: 'ghost' })];
    const out = normalizeTreeOrder(nodes);
    expect(out).not.toBe(nodes);
    expect(out[0].parentId).toBeUndefined();
    expect(isValid(out)).toBe(true);
  });

  it('drops a parentId that points to a non-Container node', () => {
    const nodes = [
      node('parent', { position: { x: 100, y: 50 } }),
      node('child', {
        parentId: 'parent',
        position: { x: 20, y: 30 },
      }),
    ];
    const out = normalizeTreeOrder(nodes);
    expect(out).not.toBe(nodes);
    const child = out.find((candidate) => candidate.id === 'child');
    expect(child?.parentId).toBeUndefined();
    expect(child?.position).toEqual({ x: 120, y: 80 });
    expect(isValid(out)).toBe(true);
  });

  it('assigns zIndex === -1 to a frame child missing it', () => {
    const nodes = [frame('f'), node('c', { parentId: 'f' })];
    const out = normalizeTreeOrder(nodes);
    expect(out).not.toBe(nodes);
    expect(out.find((n) => n.id === 'c')?.zIndex).toBe(-1);
    expect(isValid(out)).toBe(true);
  });

  it('strips the frame zIndex from a top-level non-frame node', () => {
    const nodes = [node('a', { zIndex: -1 })];
    const out = normalizeTreeOrder(nodes);
    expect(out).not.toBe(nodes);
    expect(out[0].zIndex).toBeUndefined();
    expect(isValid(out)).toBe(true);
  });

  it('breaks a parent/child cycle without looping forever', () => {
    // a -> b -> a : rule "parent before child" is unsatisfiable, so the
    // repair pass must fall through and break the cycle defensively.
    const nodes = [node('a', { parentId: 'b' }), node('b', { parentId: 'a' })];
    const out = normalizeTreeOrder(nodes);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((n) => n.id))).toEqual(new Set(['a', 'b']));
    expect(isValid(out)).toBe(true);
  });
});

describe('normalizeTreeOrder — fast path / repair parity', () => {
  const invalidCases: Array<{ name: string; nodes: NestableNode[] }> = [
    {
      name: 'child before parent',
      nodes: [node('c', { parentId: 'f', zIndex: -1 }), frame('f')],
    },
    {
      name: 'dangling parent',
      nodes: [node('a', { parentId: 'ghost' }), node('b')],
    },
    {
      name: 'frame child missing zIndex',
      nodes: [frame('f'), node('c', { parentId: 'f' })],
    },
    {
      name: 'stray frame zIndex on top-level node',
      nodes: [node('a', { zIndex: -1 }), node('b')],
    },
    {
      name: 'cycle',
      nodes: [node('a', { parentId: 'b' }), node('b', { parentId: 'a' })],
    },
  ];

  for (const { name, nodes } of invalidCases) {
    it(`repaired output is idempotent and fast-path-valid: ${name}`, () => {
      const once = normalizeTreeOrder(nodes);
      // The repaired output must satisfy every invariant...
      expect(isValid(once)).toBe(true);
      // ...and the fast path must AGREE it is valid, proven by returning
      // the exact same reference on a second pass (no re-allocation).
      expect(normalizeTreeOrder(once)).toBe(once);
    });
  }
});
