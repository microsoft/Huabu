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
  runCanvasSearch,
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

function collect(
  nodes: SearchableNode[],
  contents: NodeContent[],
  request: Parameters<typeof runCanvasSearch>[0]['request'],
  signal?: AbortSignal,
): CanvasSearchEvent[] {
  const map = new Map(contents.map((c) => [c.nodeId, c]));
  const events: CanvasSearchEvent[] = [];
  runCanvasSearch({
    nodes,
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
