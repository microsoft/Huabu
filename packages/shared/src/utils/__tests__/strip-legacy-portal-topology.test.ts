// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, expectTypeOf, it } from 'vitest';

import { stripLegacyPortalTopology } from '../../index.js';

interface TestNode {
  id: string;
  type?: string;
  parentId?: string;
  position?: { x: number; y: number };
  extent?: 'parent';
  data?: { content?: string; target?: { nodeId: string } };
}

describe('stripLegacyPortalTopology', () => {
  it('preserves normal topology, unknown types, order and object identity', () => {
    const nodes: TestNode[] = [
      { id: 'frame', type: 'frame', position: { x: 100, y: 200 } },
      { id: 'note', type: 'note', parentId: 'frame', position: { x: 5, y: 6 } },
      { id: 'preview', type: 'spacePreview' },
      { id: 'unknown', type: 'future-type' },
      { id: 'untyped' },
      { id: 'similar', type: 'CanvasRef' },
    ];
    const edges = [
      { source: 'note', target: 'preview', label: 'kept' },
      {
        source: 'unknown',
        target: 'missing',
        label: 'unrelated dangling edge',
      },
    ];
    const result = stripLegacyPortalTopology(nodes, edges);
    expect(result).toEqual({ nodes, edges });
    result.nodes.forEach((node, index) => expect(node).toBe(nodes[index]));
    result.edges.forEach((edge, index) => expect(edge).toBe(edges[index]));
    expectTypeOf(result.nodes).toEqualTypeOf<TestNode[]>();
    expectTypeOf(result.edges).toEqualTypeOf<typeof edges>();
  });

  it('drops all three exact legacy types and incident edges, never source nodes', () => {
    const source: TestNode = {
      id: 'source',
      type: 'note',
      data: { content: 'Keep authored content' },
    };
    const nodes: TestNode[] = [
      { id: 'portal', type: 'canvasRef' },
      {
        id: 'frame-ref',
        type: 'frameRef',
        parentId: 'portal',
        data: { target: { nodeId: 'frame' } },
      },
      {
        id: 'node-ref',
        type: 'nodeRef',
        parentId: 'frame-ref',
        data: { target: { nodeId: 'source' } },
      },
      { id: 'frame', type: 'frame' },
      source,
      { id: 'preview', type: 'spacePreview' },
    ];
    const retained = {
      source: 'source',
      target: 'frame',
      label: 'source edge',
    };
    const edges = [
      { source: 'portal', target: 'preview' },
      { source: 'source', target: 'frame-ref' },
      { source: 'node-ref', target: 'node-ref' },
      { source: 'frame-ref', target: 'node-ref' },
      retained,
    ];
    const result = stripLegacyPortalTopology(nodes, edges);
    expect(result.nodes.map((node) => node.id)).toEqual([
      'frame',
      'source',
      'preview',
    ]);
    expect(result.nodes[1]).toBe(source);
    expect(result.edges).toEqual([retained]);
    expect(result.edges[0]).toBe(retained);
  });

  it('detaches survivors without mutation and preserves their subtree world positions', () => {
    const nodes: TestNode[] = [
      { id: 'outer', type: 'frame', position: { x: 100, y: -200 } },
      {
        id: 'portal',
        type: 'canvasRef',
        parentId: 'outer',
        position: { x: 20, y: 30 },
      },
      {
        id: 'ref',
        type: 'frameRef',
        parentId: 'portal',
        position: { x: -5, y: 10 },
      },
      {
        id: 'survivor',
        type: 'frame',
        parentId: 'ref',
        extent: 'parent',
        position: { x: 7, y: 8 },
        data: { content: 'preserved' },
      },
      {
        id: 'child',
        type: 'note',
        parentId: 'survivor',
        position: { x: 2, y: 3 },
      },
    ];
    const edges = [{ source: 'survivor', target: 'child', label: 'kept' }];
    const before = structuredClone({ nodes, edges });
    for (const node of nodes) {
      if (node.position) Object.freeze(node.position);
      if (node.data) Object.freeze(node.data);
      Object.freeze(node);
    }
    edges.forEach(Object.freeze);
    const result = stripLegacyPortalTopology(
      Object.freeze(nodes),
      Object.freeze(edges),
    );
    expect({ nodes, edges }).toEqual(before);
    expect(result.nodes[1]).toEqual({
      id: 'survivor',
      type: 'frame',
      position: { x: 122, y: -152 },
      data: { content: 'preserved' },
    });
    expect(result.nodes[1]?.data).toBe(nodes[3]?.data);
    expect(result.nodes[2]).toBe(nodes[4]);
    expect(result.edges).toEqual(edges);
    expect(stripLegacyPortalTopology(result.nodes, result.edges)).toEqual(
      result,
    );
  });

  it('accepts minimal structural data without inventing geometry', () => {
    const nodes = [
      { id: 'old', type: 'nodeRef' },
      { id: 'kept', parentId: 'old', value: 42 },
    ];
    const result = stripLegacyPortalTopology(nodes, [
      { source: 'kept', target: 'missing', weight: 3 },
    ]);
    expect(result.nodes).toEqual([{ id: 'kept', value: 42 }]);
    expectTypeOf(result.nodes).toEqualTypeOf<typeof nodes>();
    result.nodes.push({ id: 'new', type: 'note' });
    result.edges.push({ source: 'new', target: 'kept', weight: 2 });
  });

  it('stops at missing ancestors and treats missing positions as zero', () => {
    const result = stripLegacyPortalTopology<TestNode, never>(
      [
        { id: 'old', type: 'canvasRef', parentId: 'missing' },
        { id: 'kept', type: 'note', parentId: 'old', position: { x: 5, y: 6 } },
      ],
      [],
    );
    expect(result.nodes).toEqual([
      { id: 'kept', type: 'note', position: { x: 5, y: 6 } },
    ]);
  });

  it('bounds cyclic ancestor walks without double-counting the surviving node', () => {
    const result = stripLegacyPortalTopology<TestNode, never>(
      [
        {
          id: 'old',
          type: 'canvasRef',
          parentId: 'kept',
          position: { x: 10, y: 20 },
        },
        { id: 'kept', type: 'note', parentId: 'old', position: { x: 5, y: 6 } },
      ],
      [],
    );
    expect(result.nodes).toEqual([
      { id: 'kept', type: 'note', position: { x: 15, y: 26 } },
    ]);
  });

  it('handles empty and entirely legacy topology', () => {
    expect(stripLegacyPortalTopology([], [])).toEqual({ nodes: [], edges: [] });
    expect(
      stripLegacyPortalTopology(
        [{ id: 'old', type: 'nodeRef' }],
        [{ source: 'old', target: 'old' }],
      ),
    ).toEqual({ nodes: [], edges: [] });
  });
});
