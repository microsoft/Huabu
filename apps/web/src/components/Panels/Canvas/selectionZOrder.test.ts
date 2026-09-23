// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  assignNodeZIndices,
  edgeZIndex,
  indexById,
} from '@huabu/shared/canvas-engine';

import { applyNodeGeometryPreviews } from './applyNodeGeometryPreview';
import { selectionZOrder, withoutNodeStyleZIndex } from './selectionZOrder';

import type { CanvasNode } from '@/components/Nodes/types';
import type { NestableNode } from '@huabu/shared/canvas-engine';
import type { CSSProperties } from 'react';

function node(id: string, overrides: Partial<NestableNode> = {}): NestableNode {
  return {
    id,
    type: 'note',
    position: { x: 0, y: 0 },
    data: {},
    ...overrides,
  };
}

const forest = () => [
  node('frame', { type: 'frame' }),
  node('nested', { type: 'frame', parentId: 'frame' }),
  node('child', { parentId: 'nested' }),
  node('sibling', { parentId: 'frame' }),
  node('cover'),
  node('later-frame', { type: 'frame' }),
  node('later-child', { parentId: 'later-frame' }),
];

function select(nodes: NestableNode[], ...ids: string[]) {
  return nodes.map((n) => ({ ...n, selected: ids.includes(n.id) }));
}

describe('selectionZOrder', () => {
  it('returns the base map by identity for empty, unselected and multi-selected scenes', () => {
    for (const nodes of [
      [],
      forest(),
      select(forest(), 'child', 'cover'),
      select(forest(), 'frame', 'child'),
    ]) {
      const base = assignNodeZIndices(nodes);
      expect(selectionZOrder(nodes, base)).toBe(base);
    }
  });

  it('raises a sole top-level node above all other subtrees', () => {
    const nodes = select(forest(), 'cover');
    const base = assignNodeZIndices(nodes);
    const z = selectionZOrder(nodes, base);
    expect(z.get('cover')).toBeGreaterThan(Math.max(...base.values()));
    for (const n of nodes.filter((n) => n.id !== 'cover')) {
      expect(z.get(n.id)).toBe(base.get(n.id));
    }
  });

  it('raises a deeply nested child without raising its ancestors or siblings', () => {
    const nodes = select(forest(), 'child');
    const base = assignNodeZIndices(nodes);
    const z = selectionZOrder(nodes, base);
    expect(z.get('child')).toBeGreaterThan(Math.max(...base.values()));
    for (const n of nodes.filter((n) => n.id !== 'child')) {
      expect(z.get(n.id)).toBe(base.get(n.id));
    }
  });

  it.each(['frame', 'nested'])(
    'raises selected %s with descendants in forest order',
    (id) => {
      const nodes = select(forest(), id);
      const base = assignNodeZIndices(nodes);
      const z = selectionZOrder(nodes, base);
      const raised =
        id === 'frame'
          ? ['frame', 'nested', 'child', 'sibling']
          : ['nested', 'child'];
      const offset = (z.get(id) ?? 0) - (base.get(id) ?? 0);
      for (const nodeId of raised) {
        expect(z.get(nodeId)).toBe((base.get(nodeId) ?? 0) + offset);
        expect(z.get(nodeId)).toBeGreaterThan(Math.max(...base.values()));
      }
      for (const n of nodes.filter((n) => !raised.includes(n.id))) {
        expect(z.get(n.id)).toBe(base.get(n.id));
      }
    },
  );

  it('restores exactly on deselect, selection transfer and entry into multiselect', () => {
    const nodes = forest();
    const base = assignNodeZIndices(nodes);
    const first = selectionZOrder(select(nodes, 'child'), base);
    expect(first).not.toEqual(base);
    const transferred = selectionZOrder(select(nodes, 'cover'), base);
    expect(transferred.get('child')).toBe(base.get('child'));
    expect(selectionZOrder(select(nodes), base)).toBe(base);
    expect(selectionZOrder(select(nodes, 'child', 'cover'), base)).toBe(base);
    expect(selectionZOrder(select(nodes, 'child'), base)).toEqual(first);
  });

  it('never mutates source order, saved z, style, topology or the base map', () => {
    const nodes = select(forest(), 'frame').map((n) =>
      Object.freeze({
        ...n,
        zIndex: -1,
        style: Object.freeze({ zIndex: 9999 }),
      }),
    );
    Object.freeze(nodes);
    const snapshot = JSON.stringify(nodes);
    const base = assignNodeZIndices(nodes);
    const baseSnapshot = [...base];
    selectionZOrder(nodes, base);
    expect(JSON.stringify(nodes)).toBe(snapshot);
    expect([...base]).toEqual(baseSnapshot);
  });

  it('uses canonical forest order even when array order interleaves a subtree', () => {
    const nodes = [
      node('frame', { type: 'frame', selected: true }),
      node('cover'),
      node('child', { parentId: 'frame' }),
    ];
    const base = assignNodeZIndices(nodes);
    const z = selectionZOrder(nodes, base);
    expect(z.get('child')).toBe((z.get('frame') ?? 0) + 1);
    expect(z.get('cover')).toBe(base.get('cover'));
  });

  it('treats an orphan like a top-level node and does not use a fixed elevation ceiling', () => {
    const nodes = Array.from({ length: 1100 }, (_, i) => node(String(i)));
    nodes[0] = node('0', { parentId: 'missing', selected: true });
    const base = assignNodeZIndices(nodes);
    expect(selectionZOrder(nodes, base).get('0')).toBe(1100);
  });

  it('keeps framed edges above an elevated Frame background through the shared edge policy', () => {
    const nodes = select(forest(), 'frame');
    const z = selectionZOrder(nodes, assignNodeZIndices(nodes));
    const byId = indexById(nodes);
    expect(edgeZIndex(z, byId, 'child', 'sibling')).toBeGreaterThan(
      z.get('frame') ?? 0,
    );
    expect(edgeZIndex(z, byId, 'cover', 'later-frame')).toBe(0);
  });
});

describe('withoutNodeStyleZIndex', () => {
  it('preserves identity when no inline z-index override exists', () => {
    const style = { width: 400, height: 200 };
    expect(withoutNodeStyleZIndex(undefined)).toBeUndefined();
    expect(withoutNodeStyleZIndex(style)).toBe(style);
  });

  it.each([-1, 9999, 'auto', undefined])(
    'removes inline z-index %s without mutating other styles and caches the result',
    (zIndex) => {
      const style = Object.freeze({
        zIndex,
        width: 400,
        opacity: 0.8,
      }) as CSSProperties;
      const result = withoutNodeStyleZIndex(style);
      expect(result).toEqual({ width: 400, opacity: 0.8 });
      expect(result).not.toHaveProperty('zIndex');
      expect(withoutNodeStyleZIndex(style)).toBe(result);
      expect(style).toHaveProperty('zIndex', zIndex);
      // React Flow's actual spread order must leave internals.z authoritative.
      expect({ zIndex: 50, ...result }.zIndex).toBe(50);
    },
  );

  it('retains transient geometry and source-style restoration without defeating the wrapper cache', () => {
    const sourceStyle = Object.freeze({ width: 400, height: 200, zIndex: -1 });
    const nodes = [
      node('child', { selected: true, style: sourceStyle }),
    ] as CanvasNode[];
    const geometry = {
      position: { x: 40, y: 50 },
      style: { width: 600, height: 300, zIndex: -1 },
      measured: { width: 600, height: 300 },
    };
    const previews = new Map([['child', geometry]]);
    const previewed = applyNodeGeometryPreviews(nodes, previews)[0];
    const style = withoutNodeStyleZIndex(previewed.style);
    expect(style).toEqual({ width: 600, height: 300 });
    expect(previewed.position).toBe(geometry.position);
    expect(previewed.measured).toBe(geometry.measured);
    expect(
      withoutNodeStyleZIndex(
        applyNodeGeometryPreviews(nodes, previews)[0].style,
      ),
    ).toBe(style);
    const restored = withoutNodeStyleZIndex(
      applyNodeGeometryPreviews(nodes, null)[0].style,
    );
    expect(restored).toEqual({ width: 400, height: 200 });
    expect(withoutNodeStyleZIndex(sourceStyle)).toBe(restored);
    expect(nodes[0].style).toBe(sourceStyle);
  });
});
