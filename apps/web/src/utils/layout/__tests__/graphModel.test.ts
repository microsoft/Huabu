/**
 * @file Tests for buildLayoutGraph — canvas data → LayoutGraph conversion.
 */

import { describe, it, expect } from 'vitest';

import { buildLayoutGraph } from '../graphModel';

import type { LayoutEdge } from '../types';
import type { Node, Edge } from '@xyflow/react';

// ── Helpers ────────────────────────────────────────────────────────────

/** Minimal node factory — only the fields that buildLayoutGraph reads. */
function makeNode(
  id: string,
  overrides: Partial<Node> & { data?: Record<string, unknown> } = {},
): Node {
  return {
    id,
    type: 'default',
    position: { x: 0, y: 0 },
    data: {},
    ...overrides,
  } as Node;
}

/** Minimal edge factory. */
function makeEdge(source: string, target: string): Edge {
  return { id: `${source}->${target}`, source, target } as Edge;
}

/** Find a layout edge between two node IDs (direction-agnostic). */
function findEdge(
  edges: LayoutEdge[],
  a: string,
  b: string,
): LayoutEdge | undefined {
  return edges.find(
    (e) =>
      (e.source === a && e.target === b) || (e.source === b && e.target === a),
  );
}

// ── 1. Node Mapping ────────────────────────────────────────────────────

describe('buildLayoutGraph — Node Mapping', () => {
  it('returns empty graph for empty input', () => {
    const result = buildLayoutGraph([], []);
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
    expect(result.groups).toHaveLength(0);
  });

  it('maps a single node with correct id, position, and default size', () => {
    const nodes = [makeNode('a', { position: { x: 10, y: 20 } })];
    const result = buildLayoutGraph(nodes, []);

    expect(result.nodes).toHaveLength(1);
    const ln = result.nodes[0];
    expect(ln.id).toBe('a');
    expect(ln.position).toEqual({ x: 10, y: 20 });
    // Default fallback: 200 × 100
    expect(ln.width).toBe(200);
    expect(ln.height).toBe(100);
    expect(ln.fixed).toBe(false);
  });

  it('prefers style.width/height over measured and defaults', () => {
    const nodes = [
      makeNode('a', {
        style: { width: 300, height: 150 },
        measured: { width: 250, height: 120 },
      }),
    ];
    const result = buildLayoutGraph(nodes, []);
    expect(result.nodes[0].width).toBe(300);
    expect(result.nodes[0].height).toBe(150);
  });

  it('falls back to measured.width/height when style has no numeric size', () => {
    const nodes = [
      makeNode('a', {
        measured: { width: 250, height: 120 },
      }),
    ];
    const result = buildLayoutGraph(nodes, []);
    expect(result.nodes[0].width).toBe(250);
    expect(result.nodes[0].height).toBe(120);
  });

  it('marks nodes in fixedNodeIds as fixed', () => {
    const nodes = [makeNode('a'), makeNode('b')];
    const result = buildLayoutGraph(nodes, [], {
      fixedNodeIds: new Set(['a']),
    });

    const fixed = result.nodes.find((n) => n.id === 'a');
    const free = result.nodes.find((n) => n.id === 'b');
    expect(fixed?.fixed).toBe(true);
    expect(free?.fixed).toBe(false);
  });
});

// ── 2. Edge Aggregation ────────────────────────────────────────────────

describe('buildLayoutGraph — Edge Aggregation', () => {
  it('creates edges from explicit user connections with weight 1.0', () => {
    const nodes = [makeNode('a'), makeNode('b')];
    const edges = [makeEdge('a', 'b')];
    const result = buildLayoutGraph(nodes, edges);

    expect(result.edges).toHaveLength(1);
    const edge = findEdge(result.edges, 'a', 'b');
    expect(edge).toBeDefined();
    expect(edge!.weight).toBe(1.0);
  });

  it('skips user edges referencing nodes not in the graph', () => {
    const nodes = [makeNode('a')];
    const edges = [makeEdge('a', 'missing')];
    const result = buildLayoutGraph(nodes, edges);

    expect(result.edges).toHaveLength(0);
  });

  it('creates edges from research.relatedNodeIds with weight 0.6', () => {
    const nodes = [
      makeNode('synthesis', {
        data: { research: { relatedNodeIds: ['src1', 'src2'] } },
      }),
      makeNode('src1'),
      makeNode('src2'),
    ];
    const result = buildLayoutGraph(nodes, []);

    const e1 = findEdge(result.edges, 'synthesis', 'src1');
    const e2 = findEdge(result.edges, 'synthesis', 'src2');
    expect(e1?.weight).toBe(0.6);
    expect(e2?.weight).toBe(0.6);
  });

  it('skips relatedNodeIds that reference missing nodes', () => {
    const nodes = [
      makeNode('synthesis', {
        data: { research: { relatedNodeIds: ['missing'] } },
      }),
    ];
    const result = buildLayoutGraph(nodes, []);
    expect(result.edges).toHaveLength(0);
  });

  it('creates edge from captured node to its source node with weight 0.4', () => {
    // origin.sourceId is a knowledge-base sourceId (data.sourceId), not a node ID
    const nodes = [
      makeNode('source-node', { data: { sourceId: 'kb-src-1' } }),
      makeNode('c1', {
        data: {
          origin: { type: 'user-drag-capture', sourceId: 'kb-src-1' },
        },
      }),
      makeNode('c2', {
        data: {
          origin: { type: 'user-drag-capture', sourceId: 'kb-src-1' },
        },
      }),
    ];
    const result = buildLayoutGraph(nodes, []);

    // Each captured node links to its source — 2 edges
    expect(result.edges).toHaveLength(2);
    expect(findEdge(result.edges, 'c1', 'source-node')?.weight).toBe(0.4);
    expect(findEdge(result.edges, 'c2', 'source-node')?.weight).toBe(0.4);
    // No edge between c1 and c2
    expect(findEdge(result.edges, 'c1', 'c2')).toBeUndefined();
  });

  it('creates chain edges for same research.threadId with weight 0.3', () => {
    const nodes = [
      makeNode('r1', { data: { research: { threadId: 't1' } } }),
      makeNode('r2', { data: { research: { threadId: 't1' } } }),
      makeNode('r3', { data: { research: { threadId: 't1' } } }),
    ];
    const result = buildLayoutGraph(nodes, []);

    // Chain: r1-r2, r2-r3 (not r1-r3)
    expect(result.edges).toHaveLength(2);
    expect(findEdge(result.edges, 'r1', 'r2')?.weight).toBe(0.3);
    expect(findEdge(result.edges, 'r2', 'r3')?.weight).toBe(0.3);
    expect(findEdge(result.edges, 'r1', 'r3')).toBeUndefined();
  });

  it('creates chain edges for same origin.threadId (chat) with weight 0.3', () => {
    const nodes = [
      makeNode('m1', {
        data: { origin: { type: 'user-drag-chat', threadId: 'chat-1' } },
      }),
      makeNode('m2', {
        data: { origin: { type: 'user-drag-chat', threadId: 'chat-1' } },
      }),
      makeNode('m3', {
        data: { origin: { type: 'user-drag-chat', threadId: 'chat-1' } },
      }),
    ];
    const result = buildLayoutGraph(nodes, []);

    expect(result.edges).toHaveLength(2);
    expect(findEdge(result.edges, 'm1', 'm2')?.weight).toBe(0.3);
    expect(findEdge(result.edges, 'm2', 'm3')?.weight).toBe(0.3);
  });

  it('upsertEdge keeps max weight for the same node pair', () => {
    // Node 'a' and 'b' connected by a user edge (1.0) AND relatedNodeIds (0.6)
    const nodes = [
      makeNode('a', { data: { research: { relatedNodeIds: ['b'] } } }),
      makeNode('b'),
    ];
    const edges = [makeEdge('a', 'b')];
    const result = buildLayoutGraph(nodes, edges);

    expect(result.edges).toHaveLength(1);
    expect(findEdge(result.edges, 'a', 'b')?.weight).toBe(1.0);
  });

  it('normalises edge direction — (A,B) and (B,A) produce one edge', () => {
    // Two user edges in opposite directions
    const nodes = [makeNode('a'), makeNode('b')];
    const edges = [makeEdge('a', 'b'), makeEdge('b', 'a')];
    const result = buildLayoutGraph(nodes, edges);

    expect(result.edges).toHaveLength(1);
  });
});

// ── 3. Group Construction ──────────────────────────────────────────────

describe('buildLayoutGraph — Group Construction', () => {
  it('creates a group for a frame with children', () => {
    const nodes = [
      makeNode('frame-1', { type: 'frame' }),
      makeNode('child-a', { parentId: 'frame-1' }),
      makeNode('child-b', { parentId: 'frame-1' }),
    ];
    const result = buildLayoutGraph(nodes, []);

    expect(result.groups).toHaveLength(1);
    const group = result.groups[0];
    expect(group.id).toBe('frame-1');
    expect(group.children).toEqual(
      expect.arrayContaining(['child-a', 'child-b']),
    );
    expect(group.children).toHaveLength(2);
    expect(group.padding).toBeUndefined();
  });

  it('does not create a group for a frame with no children', () => {
    const nodes = [makeNode('frame-empty', { type: 'frame' })];
    const result = buildLayoutGraph(nodes, []);
    expect(result.groups).toHaveLength(0);
  });

  it('frame node itself also appears in layoutNodes', () => {
    const nodes = [
      makeNode('frame-1', { type: 'frame' }),
      makeNode('child', { parentId: 'frame-1' }),
    ];
    const result = buildLayoutGraph(nodes, []);

    const frameNode = result.nodes.find((n) => n.id === 'frame-1');
    expect(frameNode).toBeDefined();
  });
});

// ── 4. Scope Filtering ─────────────────────────────────────────────────

describe('buildLayoutGraph — Scope Filtering', () => {
  const nodes = [
    makeNode('root-1'),
    makeNode('frame-a', { type: 'frame' }),
    makeNode('fa-child-1', { parentId: 'frame-a' }),
    makeNode('fa-child-2', { parentId: 'frame-a' }),
    makeNode('root-2'),
  ];

  it('only includes descendant nodes when scopeFrameId is set', () => {
    const result = buildLayoutGraph(nodes, [], {
      scopeFrameId: 'frame-a',
    });

    const ids = result.nodes.map((n) => n.id);
    expect(ids).toContain('fa-child-1');
    expect(ids).toContain('fa-child-2');
    expect(ids).not.toContain('root-1');
    expect(ids).not.toContain('root-2');
  });

  it('excludes the scope frame itself from layoutNodes', () => {
    const result = buildLayoutGraph(nodes, [], {
      scopeFrameId: 'frame-a',
    });

    const ids = result.nodes.map((n) => n.id);
    expect(ids).not.toContain('frame-a');
  });

  it('scoped edges only include scope-internal connections', () => {
    const allEdges = [
      makeEdge('fa-child-1', 'fa-child-2'),
      makeEdge('fa-child-1', 'root-1'), // crosses scope boundary
    ];
    const result = buildLayoutGraph(nodes, allEdges, {
      scopeFrameId: 'frame-a',
    });

    expect(result.edges).toHaveLength(1);
    expect(findEdge(result.edges, 'fa-child-1', 'fa-child-2')).toBeDefined();
  });

  it('recursively collects nested frame descendants', () => {
    const nested = [
      makeNode('outer', { type: 'frame' }),
      makeNode('inner', { type: 'frame', parentId: 'outer' }),
      makeNode('deep-child', { parentId: 'inner' }),
      makeNode('outside'),
    ];
    const result = buildLayoutGraph(nested, [], {
      scopeFrameId: 'outer',
    });

    const ids = result.nodes.map((n) => n.id);
    expect(ids).toContain('inner');
    expect(ids).toContain('deep-child');
    expect(ids).not.toContain('outer');
    expect(ids).not.toContain('outside');
  });

  it('builds groups within scope, excluding the scope frame itself', () => {
    const nested = [
      makeNode('outer', { type: 'frame' }),
      makeNode('inner', { type: 'frame', parentId: 'outer' }),
      makeNode('deep-child', { parentId: 'inner' }),
    ];
    const result = buildLayoutGraph(nested, [], {
      scopeFrameId: 'outer',
    });

    // 'inner' is a frame inside scope → should have a group
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].id).toBe('inner');
    expect(result.groups[0].children).toContain('deep-child');
  });
});

// ── 5. Integration — mixed signals ─────────────────────────────────────

describe('buildLayoutGraph — Integration', () => {
  it('handles a realistic mix of nodes, edges, and metadata', () => {
    const nodes = [
      makeNode('frame-1', {
        type: 'frame',
        style: { width: 800, height: 600 },
      }),
      makeNode('note-1', {
        parentId: 'frame-1',
        position: { x: 10, y: 10 },
        measured: { width: 220, height: 140 },
        data: {
          research: { threadId: 'thread-r1', relatedNodeIds: ['note-2'] },
        },
      }),
      makeNode('note-2', {
        parentId: 'frame-1',
        position: { x: 300, y: 10 },
        data: { research: { threadId: 'thread-r1' } },
      }),
      makeNode('card-ext', {
        position: { x: 500, y: 500 },
        data: {
          origin: { type: 'user-drag-chat', threadId: 'chat-1' },
        },
      }),
      makeNode('card-ext-2', {
        position: { x: 700, y: 500 },
        data: {
          origin: { type: 'user-drag-chat', threadId: 'chat-1' },
        },
      }),
    ];
    const edges = [makeEdge('note-1', 'card-ext')];

    const result = buildLayoutGraph(nodes, edges, {
      fixedNodeIds: new Set(['card-ext']),
    });

    // All 5 nodes mapped
    expect(result.nodes).toHaveLength(5);

    // card-ext is fixed
    expect(result.nodes.find((n) => n.id === 'card-ext')?.fixed).toBe(true);

    // note-1 uses measured size (no style.width)
    expect(result.nodes.find((n) => n.id === 'note-1')?.width).toBe(220);

    // frame-1 uses style size
    expect(result.nodes.find((n) => n.id === 'frame-1')?.width).toBe(800);

    // Edges:
    // - user edge: note-1 → card-ext (1.0)
    // - relatedNodeIds: note-1 → note-2 (0.6)
    // - same research thread: note-1 → note-2 (0.3, but upserted to 0.6)
    // - same chat thread: card-ext → card-ext-2 (0.3)
    expect(findEdge(result.edges, 'note-1', 'card-ext')?.weight).toBe(1.0);
    expect(findEdge(result.edges, 'note-1', 'note-2')?.weight).toBe(0.6);
    expect(findEdge(result.edges, 'card-ext', 'card-ext-2')?.weight).toBe(0.3);

    // Group: frame-1 → [note-1, note-2]
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].children).toEqual(
      expect.arrayContaining(['note-1', 'note-2']),
    );
  });
});
