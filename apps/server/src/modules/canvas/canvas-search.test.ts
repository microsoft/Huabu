/**
 * Tests for the per-canvas search scanner.
 *
 * Covers the pure {@link runCanvasSearch} driver (no Fastify, no disk):
 * the route layer is a thin NDJSON adapter so the interesting behaviour
 * — tiered emission order, field filtering, snippet construction,
 * limits, abort semantics — all lives here and is easy to test in
 * memory.
 */

import { describe, expect, it } from 'vitest';

import {
  extractSearchableNodes,
  extractSearchableEdges,
  runCanvasSearch,
  type SearchableEdge,
  type SearchableNode,
} from './canvas-search.js';

import type { NodeContent } from '../storage/canvas-store.js';
import type { CanvasSearchEvent } from '@sediment/shared';

function mkNode(id: string, type: string): SearchableNode {
  return { id, type };
}

function mkContent(
  id: string,
  type: string,
  fields: Partial<NodeContent>,
): NodeContent {
  return {
    nodeId: id,
    type,
    label: fields.label ?? null,
    content: typeof fields.content === 'string' ? fields.content : '',
    ...fields,
  };
}

function mkEdge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  label: string | null,
): SearchableEdge {
  return { id, sourceNodeId, targetNodeId, label };
}

function collect(
  nodes: SearchableNode[],
  contents: NodeContent[],
  request: Parameters<typeof runCanvasSearch>[0]['request'],
  signal?: AbortSignal,
  edges?: SearchableEdge[],
): CanvasSearchEvent[] {
  const map = new Map(contents.map((c) => [c.nodeId, c]));
  const events: CanvasSearchEvent[] = [];
  runCanvasSearch({
    nodes,
    edges,
    contentByNodeId: map,
    request,
    signal,
    emit: (e) => events.push(e),
  });
  return events;
}

describe('runCanvasSearch — tiered emission', () => {
  it('emits metadata-tier matches before content-tier matches', () => {
    const nodes = [mkNode('n1', 'note'), mkNode('n2', 'text')];
    const contents = [
      mkContent('n1', 'note', { label: 'banana split', content: 'apple pie' }),
      mkContent('n2', 'text', { label: 'pie chart', content: 'banana bread' }),
    ];

    const events = collect(nodes, contents, { query: 'banana' });

    const matches = events.filter((e) => e.type === 'match');
    expect(matches.map((m) => m.type === 'match' && m.tier)).toEqual([
      'meta',
      'content',
    ]);
    expect(matches.map((m) => m.type === 'match' && m.match.field)).toEqual([
      'label',
      'content',
    ]);
  });

  it('always emits a meta-done progress frame between tiers', () => {
    const events = collect(
      [mkNode('n1', 'note')],
      [mkContent('n1', 'note', { label: 'hello', content: 'world' })],
      { query: 'zzz' },
    );
    const progress = events.filter(
      (e) => e.type === 'progress' && e.phase === 'meta-done',
    );
    expect(progress).toHaveLength(1);
  });

  it('emits a final done frame with the total emitted count', () => {
    const events = collect(
      [mkNode('n1', 'note'), mkNode('n2', 'note')],
      [
        mkContent('n1', 'note', { label: 'foo', content: 'foo' }),
        mkContent('n2', 'note', { label: 'bar', content: 'foo' }),
      ],
      { query: 'foo' },
    );
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    if (done?.type !== 'done') throw new Error('unreachable');
    expect(done.total).toBe(3);
    expect(done.truncated).toBe(false);
  });
});

describe('runCanvasSearch — field filtering', () => {
  it('omitting `content` from fields skips body scan entirely', () => {
    const events = collect(
      [mkNode('n1', 'note')],
      [
        mkContent('n1', 'note', {
          label: 'note',
          content: 'the needle is here',
        }),
      ],
      { query: 'needle', fields: ['label', 'summary', 'keywords'] },
    );
    const matches = events.filter((e) => e.type === 'match');
    expect(matches).toHaveLength(0);
  });

  it('finds matches in summary and keywords frontmatter', () => {
    const events = collect(
      [mkNode('n1', 'note')],
      [
        mkContent('n1', 'note', {
          label: 'untitled',
          summary: 'this note discusses needles',
          keywords: ['thread', 'needle'],
          content: '',
        }),
      ],
      { query: 'needle' },
    );
    const matchFields = events
      .filter((e) => e.type === 'match')
      .map((m) => (m.type === 'match' ? m.match.field : ''));
    expect(matchFields).toContain('summary');
    expect(matchFields).toContain('keywords');
  });
});

describe('runCanvasSearch — node filtering', () => {
  it('nodeTypes filter restricts scan to matching types', () => {
    const events = collect(
      [mkNode('n1', 'note'), mkNode('n2', 'pdf')],
      [
        mkContent('n1', 'note', { label: 'hit-1', content: '' }),
        mkContent('n2', 'pdf', { label: 'hit-2', content: '' }),
      ],
      { query: 'hit', nodeTypes: ['note'] },
    );
    const ids = events
      .filter((e) => e.type === 'match')
      .map((m) => (m.type === 'match' ? m.match.nodeId : ''));
    expect(ids).toEqual(['n1']);
  });

  it('nodeId filter restricts scan to a single node', () => {
    const events = collect(
      [mkNode('n1', 'note'), mkNode('n2', 'note')],
      [
        mkContent('n1', 'note', { label: 'foo', content: 'foo' }),
        mkContent('n2', 'note', { label: 'foo', content: 'foo' }),
      ],
      { query: 'foo', nodeId: 'n2' },
    );
    const ids = new Set(
      events
        .filter((e) => e.type === 'match')
        .map((m) => (m.type === 'match' ? m.match.nodeId : '')),
    );
    expect(ids).toEqual(new Set(['n2']));
  });
});

describe('runCanvasSearch — snippet construction', () => {
  it('returns the full label as the snippet for label hits', () => {
    const events = collect(
      [mkNode('n1', 'note')],
      [mkContent('n1', 'note', { label: 'My Banana Plan', content: '' })],
      { query: 'banana' },
    );
    const m = events.find((e) => e.type === 'match');
    if (m?.type !== 'match') throw new Error('expected match');
    expect(m.match.snippet).toBe('My Banana Plan');
    expect(m.match.matchStart).toBe(3);
    expect(m.match.matchLength).toBe(6);
  });

  it('adds ellipses when snippet is clipped at both ends', () => {
    const long = 'a'.repeat(200) + ' the needle is here ' + 'b'.repeat(200);
    const events = collect(
      [mkNode('n1', 'note')],
      [mkContent('n1', 'note', { label: 'doc', content: long })],
      { query: 'needle', fields: ['content'] },
    );
    const m = events.find((e) => e.type === 'match');
    if (m?.type !== 'match') throw new Error('expected match');
    expect(m.match.snippet.startsWith('…')).toBe(true);
    expect(m.match.snippet.endsWith('…')).toBe(true);
    // Sanity: matchStart points at "needle" in the snippet
    expect(
      m.match.snippet.slice(m.match.matchStart, m.match.matchStart + 6),
    ).toBe('needle');
  });

  it('collapses whitespace runs (incl. newlines) inside the snippet', () => {
    const events = collect(
      [mkNode('n1', 'note')],
      [
        mkContent('n1', 'note', {
          label: 'doc',
          content: 'line one\n\n\nfind\tme here\n\n  next',
        }),
      ],
      { query: 'find', fields: ['content'] },
    );
    const m = events.find((e) => e.type === 'match');
    if (m?.type !== 'match') throw new Error('expected match');
    expect(m.match.snippet).not.toContain('\n');
    expect(m.match.snippet).not.toContain('\t');
    expect(m.match.snippet).not.toMatch(/  +/);
  });
});

describe('runCanvasSearch — case insensitivity', () => {
  it('matches ignoring case', () => {
    const events = collect(
      [mkNode('n1', 'note')],
      [mkContent('n1', 'note', { label: 'Hello WORLD', content: '' })],
      { query: 'hello world' },
    );
    const matches = events.filter((e) => e.type === 'match');
    expect(matches).toHaveLength(1);
  });
});

describe('runCanvasSearch — limit + truncation', () => {
  it('stops emitting after `limit` matches and reports truncated', () => {
    const nodes: SearchableNode[] = [];
    const contents: NodeContent[] = [];
    for (let i = 0; i < 30; i++) {
      nodes.push(mkNode(`n${i}`, 'note'));
      contents.push(mkContent(`n${i}`, 'note', { label: 'hit', content: '' }));
    }
    const events = collect(nodes, contents, { query: 'hit', limit: 10 });
    const matches = events.filter((e) => e.type === 'match');
    expect(matches).toHaveLength(10);
    const done = events.find((e) => e.type === 'done');
    if (done?.type !== 'done') throw new Error('expected done');
    expect(done.truncated).toBe(true);
    expect(done.total).toBe(10);
  });

  it('emits every hit within a single field — no per-field cap', () => {
    // A body containing 12 occurrences of the needle. Prior to the
    // cap removal, only the first 3 would have been emitted.
    const body = Array.from({ length: 12 }).fill('foo').join(' bar ');
    const events = collect(
      [mkNode('n1', 'note')],
      [mkContent('n1', 'note', { label: 'doc', content: body })],
      { query: 'foo', limit: 50 },
    );
    const contentMatches = events.filter(
      (e) => e.type === 'match' && e.match.field === 'content',
    );
    expect(contentMatches).toHaveLength(12);
    const done = events.find((e) => e.type === 'done');
    if (done?.type !== 'done') throw new Error('expected done');
    expect(done.truncated).toBe(false);
  });
});

describe('runCanvasSearch — occurrenceIndex', () => {
  it('stamps a monotonic 0-based ordinal per (nodeId, field)', () => {
    const body = 'foo bar foo baz foo qux foo';
    const events = collect(
      [mkNode('n1', 'note')],
      [
        mkContent('n1', 'note', {
          label: 'foo doc with foo and foo',
          content: body,
        }),
      ],
      { query: 'foo', limit: 50 },
    );
    const matches = events.filter((e) => e.type === 'match');
    // Group by field and check each is 0..N-1 in order.
    const byField = new Map<string, number[]>();
    for (const m of matches) {
      if (m.type !== 'match') continue;
      const arr = byField.get(m.match.field) ?? [];
      arr.push(m.match.occurrenceIndex);
      byField.set(m.match.field, arr);
    }
    for (const [, arr] of byField) {
      for (let i = 0; i < arr.length; i++) expect(arr[i]).toBe(i);
    }
    // And the counters per field are independent — content has 4, label has 3.
    expect(byField.get('content')).toEqual([0, 1, 2, 3]);
    expect(byField.get('label')).toEqual([0, 1, 2]);
  });
});

describe('runCanvasSearch — abort', () => {
  it('breaks out of meta scan when the signal aborts mid-scan', () => {
    const nodes: SearchableNode[] = [];
    const contents: NodeContent[] = [];
    for (let i = 0; i < 100; i++) {
      nodes.push(mkNode(`n${i}`, 'note'));
      contents.push(mkContent(`n${i}`, 'note', { label: 'hit', content: '' }));
    }
    const ctrl = new AbortController();
    const events: CanvasSearchEvent[] = [];
    const map = new Map(contents.map((c) => [c.nodeId, c]));
    runCanvasSearch({
      nodes,
      contentByNodeId: map,
      request: { query: 'hit' },
      signal: ctrl.signal,
      emit: (e) => {
        events.push(e);
        if (events.length === 5) ctrl.abort();
      },
    });
    // Scan should bail before processing all 100; no done frame either
    // because we return early on abort.
    expect(events.length).toBeLessThan(100);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });
});

describe('extractSearchableNodes', () => {
  it('pulls id + type from a canvas state.nodes array', () => {
    const got = extractSearchableNodes({
      nodes: [
        { id: 'a', type: 'note' },
        { id: 'b', type: 'pdf' },
        { id: 'c' /* missing type */ },
        { /* missing id */ type: 'web' },
        null,
        'not-an-object',
      ],
    });
    expect(got).toEqual([
      { id: 'a', type: 'note' },
      { id: 'b', type: 'pdf' },
      { id: 'c', type: '' },
    ]);
  });

  it('returns empty array for missing / malformed state', () => {
    expect(extractSearchableNodes(null)).toEqual([]);
    expect(extractSearchableNodes({})).toEqual([]);
    expect(extractSearchableNodes({ nodes: 'oops' })).toEqual([]);
  });
});

describe('extractSearchableEdges', () => {
  it('reads id + endpoints + edgeStyle.label off the canvas state', () => {
    const got = extractSearchableEdges({
      edges: [
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          data: { edgeStyle: { label: 'blocks' } },
        },
        // No label — kept (label = null) so the scanner can still
        // skip it cheaply without re-querying state.
        { id: 'e2', source: 'b', target: 'c', data: { edgeStyle: {} } },
        // Missing data entirely.
        { id: 'e3', source: 'c', target: 'a' },
        // Malformed entries dropped.
        { id: 'bad-no-source', target: 'a' },
        null,
      ],
    });
    expect(got).toEqual([
      { id: 'e1', sourceNodeId: 'a', targetNodeId: 'b', label: 'blocks' },
      { id: 'e2', sourceNodeId: 'b', targetNodeId: 'c', label: null },
      { id: 'e3', sourceNodeId: 'c', targetNodeId: 'a', label: null },
    ]);
  });

  it('returns empty array for missing / malformed state', () => {
    expect(extractSearchableEdges(null)).toEqual([]);
    expect(extractSearchableEdges({})).toEqual([]);
    expect(extractSearchableEdges({ edges: 'oops' })).toEqual([]);
  });
});

describe('runCanvasSearch — edge labels', () => {
  it('emits edge label matches in the meta tier with kind="edge"', () => {
    const events = collect(
      [mkNode('a', 'note'), mkNode('b', 'note')],
      [
        mkContent('a', 'note', { label: 'A', content: '' }),
        mkContent('b', 'note', { label: 'B', content: '' }),
      ],
      { query: 'blocks' },
      undefined,
      [mkEdge('e1', 'a', 'b', 'A blocks B')],
    );
    const matches = events.filter((e) => e.type === 'match');
    expect(matches).toHaveLength(1);
    const m = matches[0];
    if (m.type !== 'match') throw new Error('unreachable');
    expect(m.tier).toBe('meta');
    expect(m.match.kind).toBe('edge');
    expect(m.match.nodeId).toBe('e1');
    expect(m.match.nodeType).toBe('edge');
    expect(m.match.field).toBe('label');
    expect(m.match.sourceNodeId).toBe('a');
    expect(m.match.targetNodeId).toBe('b');
    expect(m.match.label).toBe('A blocks B');
  });

  it('skips edges with empty / missing labels', () => {
    const events = collect(
      [mkNode('a', 'note')],
      [mkContent('a', 'note', { label: 'A', content: '' })],
      { query: 'foo' },
      undefined,
      [mkEdge('e1', 'a', 'a', null), mkEdge('e2', 'a', 'a', '')],
    );
    expect(events.filter((e) => e.type === 'match')).toHaveLength(0);
  });

  it('does not scan edges when the request is scoped to a single nodeId', () => {
    // Per-node search asks about that node's content, not its
    // surrounding connections.
    const events = collect(
      [mkNode('a', 'note'), mkNode('b', 'note')],
      [
        mkContent('a', 'note', { label: 'A', content: '' }),
        mkContent('b', 'note', { label: 'B', content: '' }),
      ],
      { query: 'edge', nodeId: 'a' },
      undefined,
      [mkEdge('e1', 'a', 'b', 'edge label hit')],
    );
    expect(events.filter((e) => e.type === 'match')).toHaveLength(0);
  });

  it('does not scan edges when `label` is excluded from the fields filter', () => {
    const events = collect(
      [mkNode('a', 'note')],
      [mkContent('a', 'note', { label: 'A', content: '' })],
      { query: 'edge', fields: ['content'] },
      undefined,
      [mkEdge('e1', 'a', 'a', 'edge label hit')],
    );
    expect(events.filter((e) => e.type === 'match')).toHaveLength(0);
  });

  it('only keeps edges with at least one endpoint matching `nodeTypes`', () => {
    const events = collect(
      [
        mkNode('note-a', 'note'),
        mkNode('text-b', 'text'),
        mkNode('text-c', 'text'),
      ],
      [
        mkContent('note-a', 'note', { label: 'A', content: '' }),
        mkContent('text-b', 'text', { label: 'B', content: '' }),
        mkContent('text-c', 'text', { label: 'C', content: '' }),
      ],
      { query: 'hit', nodeTypes: ['note'] },
      undefined,
      [
        mkEdge('e1', 'note-a', 'text-b', 'hit edge'),
        mkEdge('e2', 'text-b', 'text-c', 'hit edge'),
      ],
    );
    const edgeMatches = events.filter(
      (e) => e.type === 'match' && e.match.kind === 'edge',
    );
    expect(edgeMatches).toHaveLength(1);
    if (edgeMatches[0].type !== 'match') throw new Error('unreachable');
    expect(edgeMatches[0].match.nodeId).toBe('e1');
  });
});
