// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { keysBetween } from '../orderKey.js';
import {
  orderByPaintKeys,
  readPaintKey,
  settlePaintOrder,
} from './paintOrder.js';

import type { NestableNode } from './tree.js';

const [K1, K2, K3] = keysBetween(undefined, undefined, 3);

function node(id: string, key?: string, parentId?: string): NestableNode {
  return {
    id,
    type: parentId === undefined && id.startsWith('f') ? 'frame' : 'note',
    position: { x: 0, y: 0 },
    ...(parentId ? { parentId } : {}),
    data: key === undefined ? {} : { paintKey: key },
  } as NestableNode;
}
const ids = (nodes: readonly NestableNode[]) => nodes.map((n) => n.id);
const keys = (nodes: readonly NestableNode[]) =>
  Object.fromEntries(nodes.map((n) => [n.id, readPaintKey(n)]));

describe('orderByPaintKeys', () => {
  it('orders siblings by key and equal keys by id', () => {
    const nodes = [node('c', K2), node('b', K2), node('a', K3), node('d', K1)];
    expect(ids(orderByPaintKeys(nodes))).toEqual(['d', 'b', 'c', 'a']);
  });

  it('returns the same array when it is already in order', () => {
    const nodes = [node('a', K1), node('b', K2)];
    expect(orderByPaintKeys(nodes)).toBe(nodes);
  });

  it('orders each parent on its own, every node followed by its subtree', () => {
    const nodes = [
      node('f1', K2),
      node('x', K3, 'f1'),
      node('y', K1, 'f1'),
      node('f2', K1),
      node('z', K2, 'f2'),
      node('a', K3),
    ];
    // A child ranks only among its own parent's children, and a Frame moves
    // with its whole subtree: no node ends up before its parent or between
    // another Frame's children.
    expect(ids(orderByPaintKeys(nodes))).toEqual([
      'f2',
      'z',
      'f1',
      'y',
      'x',
      'a',
    ]);
  });

  it('lays a node whose parent is missing out as a root, and keeps a cycle', () => {
    const orphan = node('o', K1, 'gone');
    const loopA = { ...node('la', K1, 'lb'), type: 'frame' } as NestableNode;
    const loopB = { ...node('lb', K1, 'la'), type: 'frame' } as NestableNode;
    const ordered = orderByPaintKeys([node('a', K2), orphan, loopA, loopB]);
    expect(ids(ordered).sort()).toEqual(['a', 'la', 'lb', 'o']);
  });

  it('keeps a node without a key behind the sibling it follows', () => {
    const nodes = [node('a', K3), node('new'), node('b', K1)];
    expect(ids(orderByPaintKeys(nodes))).toEqual(['b', 'a', 'new']);
  });
});

describe('settlePaintOrder', () => {
  it('keys a Space that has no keys in its array order, the same every time', () => {
    const nodes = [node('f'), node('a', undefined, 'f'), node('b'), node('c')];
    const settled = settlePaintOrder(nodes);
    expect(ids(settled)).toEqual(ids(nodes));
    expect(keys(settled)).toEqual({
      f: K1,
      a: keysBetween(undefined, undefined, 1)[0],
      b: K2,
      c: K3,
    });
    expect(keys(settlePaintOrder(nodes))).toEqual(keys(settled));
  });

  it('is idempotent and returns the same array when nothing is missing', () => {
    const settled = settlePaintOrder([node('a'), node('b')]);
    expect(settlePaintOrder(settled)).toBe(settled);
  });

  it('keys only the node that has none, for the place it stands in', () => {
    const nodes = [node('a', K1), node('new'), node('b', K3)];
    const settled = settlePaintOrder(nodes);
    expect(ids(settled)).toEqual(['a', 'new', 'b']);
    const key = readPaintKey(settled[1]) as string;
    expect(K1 < key && key < K3).toBe(true);
    expect(settled[0]).toBe(nodes[0]);
    expect(settled[2]).toBe(nodes[2]);
  });

  it('puts an appended node in front and a prepended node at the back', () => {
    const settled = settlePaintOrder([
      node('first'),
      node('a', K2),
      node('last'),
    ]);
    const k = keys(settled);
    expect((k.first as string) < K2 && K2 < (k.last as string)).toBe(true);
  });

  it('re-keys a node that changed parent and still carries its old key', () => {
    const before = [node('f', K1), node('a', K3), node('b', K2, 'f')];
    // `a` moved into the Frame, behind `b` in the array.
    const after = [before[0], before[2], node('a', K3, 'f')];
    const settled = settlePaintOrder(after, before);
    expect(ids(settled)).toEqual(['f', 'b', 'a']);
    expect((readPaintKey(settled[2]) as string) > K2).toBe(true);
    expect(settled[1]).toBe(before[2]);
  });

  it('keeps the key a command wrote for the new parent', () => {
    const before = [node('f', K1), node('a', K3), node('b', K2, 'f')];
    const after = [before[0], before[2], node('a', K1, 'f')];
    const settled = settlePaintOrder(after, before);
    expect(ids(settled)).toEqual(['f', 'a', 'b']);
    expect(readPaintKey(settled[1])).toBe(K1);
  });

  it('makes room when a node lands between two equal keys', () => {
    const settled = settlePaintOrder([
      node('a', K2),
      node('new'),
      node('b', K2),
    ]);
    const k = keys(settled) as Record<string, string>;
    expect(ids(settled)).toEqual(['a', 'new', 'b']);
    expect(k.a).toBe(K2);
    expect(k.a < k.new && k.new < k.b).toBe(true);
  });

  it('restores a node to the place its own key names', () => {
    // An undone deletion appends the node; its key says where it paints.
    const settled = settlePaintOrder([
      node('a', K1),
      node('c', K3),
      node('b', K2),
    ]);
    expect(ids(settled)).toEqual(['a', 'b', 'c']);
    expect(keys(settled)).toEqual({ a: K1, b: K2, c: K3 });
  });
});
