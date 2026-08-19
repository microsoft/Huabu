// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tests for the per-canvas search scanner.
 *
 * Covers the streaming {@link searchCanvas} driver. The route layer is
 * a thin NDJSON adapter, so the interesting behaviour — tiered emission
 * order, field filtering, snippet construction, limits, abort semantics
 * — all lives here and is exercised against a fake `Space` whose
 * `streamAllNodes` walks an in-memory snapshot. Production reads sidecars
 * off disk, but the scanner takes a callback so the two are wire-compatible.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  extractSearchableNodes,
  extractSearchableEdges,
  searchCanvas,
  type SearchableEdge,
  type SearchableNode,
} from './canvas-search.js';
import { createChatSubmission } from '../agent/agenetes/handle.js';

import type { ChatEnvelope } from '../agent/conversation/envelope.js';
import type { NodeContent, NodeSnapshot, Space } from '../storage/index.js';
import type { AgentTurn } from '@agenetes/protocol';
import type { CanvasSearchEvent, CanvasSearchRequest } from '@huabu/shared';

/**
 * In-memory chat-thread registry backing the mocked `agenetes.history`.
 * Keyed by `threadId`; the conversation tier reads it instead of disk so
 * the scanner can be exercised without writing `chat_v2/` fixtures.
 */
const turnsByThread = vi.hoisted(() => new Map<string, AgentTurn[]>());

vi.mock('../agent/agenetes/drivers.js', () => ({
  agenetes: {
    history: (_ns: unknown, threadId: string) => ({
      turns: turnsByThread.get(threadId) ?? [],
    }),
  },
}));

vi.mock('../workspace/paths.js', async (importActual) => ({
  ...((await importActual()) as Record<string, unknown>),
  canvasAcpNamespace: (canvasId: string) => ({ name: canvasId, root: '' }),
}));

function mkNode(id: string, type: string, threadId?: string): SearchableNode {
  return { id, type, ...(threadId ? { threadId } : {}) };
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

/**
 * Build a duck-typed `Space` that satisfies just the two members
 * `searchCanvas` actually reads from: `read()` (for the static node + edge
 * shape) and `streamAllNodes()` (for the sidecar bodies). The rest of the
 * store surface is irrelevant here, so we cast through `unknown`.
 */
function makeFakeSpace(opts: {
  nodes: readonly SearchableNode[];
  contents: readonly NodeContent[];
  edges?: readonly SearchableEdge[];
}): Space {
  const stateNodes = opts.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    ...(n.threadId ? { data: { threadId: n.threadId } } : {}),
  }));
  const stateEdges = (opts.edges ?? []).map((e) => ({
    id: e.id,
    source: e.sourceNodeId,
    target: e.targetNodeId,
    data:
      e.label !== null ? { edgeStyle: { label: e.label } } : { edgeStyle: {} },
  }));
  const fake = {
    canvasId: 'test-canvas',
    read: async () => ({ state: { nodes: stateNodes, edges: stateEdges } }),
    nodes: {
      canvasId: 'test-canvas',
      stream: async (
        onNode: (snapshot: NodeSnapshot) => void,
        options?: { signal?: { readonly aborted: boolean } },
      ): Promise<Map<string, NodeSnapshot>> => {
        const map = new Map<string, NodeSnapshot>();
        for (const c of opts.contents) {
          if (options?.signal?.aborted) return map;
          const snapshot = { record: c, revision: `rev-${c.nodeId}` };
          map.set(c.nodeId, snapshot);
          onNode(snapshot);
        }
        return map;
      },
    },
  };
  return fake as unknown as Space;
}

async function collect(
  nodes: SearchableNode[],
  contents: NodeContent[],
  request: CanvasSearchRequest,
  signal?: AbortSignal,
  edges?: SearchableEdge[],
): Promise<CanvasSearchEvent[]> {
  const handle = makeFakeSpace({ nodes, contents, edges });
  const events: CanvasSearchEvent[] = [];
  await searchCanvas(handle, request, (e) => events.push(e), signal);
  return events;
}

describe('searchCanvas — tiered emission', () => {
  it('emits metadata-tier matches before content-tier matches', async () => {
    const nodes = [mkNode('n1', 'note'), mkNode('n2', 'text')];
    const contents = [
      mkContent('n1', 'note', { label: 'banana split', content: 'apple pie' }),
      mkContent('n2', 'text', { label: 'pie chart', content: 'banana bread' }),
    ];

    const events = await collect(nodes, contents, { query: 'banana' });

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

  it('always emits a meta-done progress frame between tiers', async () => {
    const events = await collect(
      [mkNode('n1', 'note')],
      [mkContent('n1', 'note', { label: 'hello', content: 'world' })],
      { query: 'zzz' },
    );
    const progress = events.filter(
      (e) => e.type === 'progress' && e.phase === 'meta-done',
    );
    expect(progress).toHaveLength(1);
  });

  it('emits a final done frame with the total emitted count', async () => {
    const events = await collect(
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

describe('searchCanvas — field filtering', () => {
  it('omitting `content` from fields skips body scan entirely', async () => {
    const events = await collect(
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

  it('finds matches in summary and keywords frontmatter', async () => {
    const events = await collect(
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

describe('searchCanvas — node filtering', () => {
  it('nodeTypes filter restricts scan to matching types', async () => {
    const events = await collect(
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

  it('nodeId filter restricts scan to a single node', async () => {
    const events = await collect(
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

describe('searchCanvas — snippet construction', () => {
  it('returns the full label as the snippet for label hits', async () => {
    const events = await collect(
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

  it('adds ellipses when snippet is clipped at both ends', async () => {
    const long = 'a'.repeat(200) + ' the needle is here ' + 'b'.repeat(200);
    const events = await collect(
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

  it('collapses whitespace runs (incl. newlines) inside the snippet', async () => {
    const events = await collect(
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

describe('searchCanvas — case insensitivity', () => {
  it('matches ignoring case', async () => {
    const events = await collect(
      [mkNode('n1', 'note')],
      [mkContent('n1', 'note', { label: 'Hello WORLD', content: '' })],
      { query: 'hello world' },
    );
    const matches = events.filter((e) => e.type === 'match');
    expect(matches).toHaveLength(1);
  });
});

describe('searchCanvas — limit + truncation', () => {
  it('stops emitting after `limit` matches and reports truncated', async () => {
    const nodes: SearchableNode[] = [];
    const contents: NodeContent[] = [];
    for (let i = 0; i < 30; i++) {
      nodes.push(mkNode(`n${i}`, 'note'));
      contents.push(mkContent(`n${i}`, 'note', { label: 'hit', content: '' }));
    }
    const events = await collect(nodes, contents, { query: 'hit', limit: 10 });
    const matches = events.filter((e) => e.type === 'match');
    expect(matches).toHaveLength(10);
    const done = events.find((e) => e.type === 'done');
    if (done?.type !== 'done') throw new Error('expected done');
    expect(done.truncated).toBe(true);
    expect(done.total).toBe(10);
  });

  it('emits every hit within a single field — no per-field cap', async () => {
    // A body containing 12 occurrences of the needle. Prior to the
    // cap removal, only the first 3 would have been emitted.
    const body = Array.from({ length: 12 }).fill('foo').join(' bar ');
    const events = await collect(
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

describe('searchCanvas — occurrenceIndex', () => {
  it('stamps a monotonic 0-based ordinal per (nodeId, field)', async () => {
    const body = 'foo bar foo baz foo qux foo';
    const events = await collect(
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

describe('searchCanvas — abort', () => {
  it('breaks out of meta scan when the signal aborts mid-scan', async () => {
    const nodes: SearchableNode[] = [];
    const contents: NodeContent[] = [];
    for (let i = 0; i < 100; i++) {
      nodes.push(mkNode(`n${i}`, 'note'));
      contents.push(mkContent(`n${i}`, 'note', { label: 'hit', content: '' }));
    }
    const ctrl = new AbortController();
    const events: CanvasSearchEvent[] = [];
    const handle = makeFakeSpace({ nodes, contents });
    await searchCanvas(
      handle,
      { query: 'hit' },
      (e) => {
        events.push(e);
        if (events.length === 5) ctrl.abort();
      },
      ctrl.signal,
    );
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

describe('searchCanvas — edge labels', () => {
  it('emits edge label matches in the meta tier with kind="edge"', async () => {
    const events = await collect(
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

  it('skips edges with empty / missing labels', async () => {
    const events = await collect(
      [mkNode('a', 'note')],
      [mkContent('a', 'note', { label: 'A', content: '' })],
      { query: 'foo' },
      undefined,
      [mkEdge('e1', 'a', 'a', null), mkEdge('e2', 'a', 'a', '')],
    );
    expect(events.filter((e) => e.type === 'match')).toHaveLength(0);
  });

  it('does not scan edges when the request is scoped to a single nodeId', async () => {
    // Per-node search asks about that node's content, not its
    // surrounding connections.
    const events = await collect(
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

  it('does not scan edges when `label` is excluded from the fields filter', async () => {
    const events = await collect(
      [mkNode('a', 'note')],
      [mkContent('a', 'note', { label: 'A', content: '' })],
      { query: 'edge', fields: ['content'] },
      undefined,
      [mkEdge('e1', 'a', 'a', 'edge label hit')],
    );
    expect(events.filter((e) => e.type === 'match')).toHaveLength(0);
  });

  it('only keeps edges with at least one endpoint matching `nodeTypes`', async () => {
    const events = await collect(
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

describe('searchCanvas — conversation tier', () => {
  /** Build a turn with one user message + one assistant text reply. */
  function mkTurn(userText: string, assistantText: string): AgentTurn {
    const envelope = {
      user: { text: userText, attachments: [] },
      skills: { invokedIds: [], resolved: [] },
      focus: {
        selection: {
          refs: [],
          selectedIds: [],
          imageAttachments: [],
          snapshotAttachments: [],
        },
      },
    } as unknown as ChatEnvelope;
    return {
      request: createChatSubmission(envelope),
      transcript: [{ type: 'text', data: { content: assistantText } }],
    };
  }

  it('matches user messages and assistant replies in a thread', async () => {
    turnsByThread.clear();
    turnsByThread.set('t1', [
      mkTurn(
        'how do I deploy the server',
        'you can deploy with docker compose',
      ),
    ]);

    const events = await collect(
      [mkNode('q1', 'question', 't1')],
      [mkContent('q1', 'question', { label: 'Q', content: 'how do I deploy' })],
      { query: 'docker', fields: ['conversation'] },
    );

    const matches = events.filter((e) => e.type === 'match');
    expect(matches).toHaveLength(1);
    if (matches[0].type !== 'match') throw new Error('unreachable');
    expect(matches[0].tier).toBe('conversation');
    expect(matches[0].match.field).toBe('conversation');
    expect(matches[0].match.nodeId).toBe('q1');
  });

  it('excludes tool-call blocks from conversation matches', async () => {
    turnsByThread.clear();
    turnsByThread.set('t1', [
      {
        request: createChatSubmission({
          user: { text: 'run the build', attachments: [] },
          skills: { invokedIds: [], resolved: [] },
          focus: {
            selection: {
              refs: [],
              selectedIds: [],
              imageAttachments: [],
              snapshotAttachments: [],
            },
          },
        } as unknown as ChatEnvelope),
        transcript: [
          { type: 'text', data: { content: 'building now' } },
          {
            type: 'tool_call',
            data: {
              toolCallId: 'tc1',
              title: 'run_build',
              internalToolName: 'run_build',
              rawInput: { secret: 'SECRETTOKEN' },
              rawOutput: 'SECRETTOKEN build output',
            },
          } as unknown as AgentTurn['transcript'][number],
        ],
      },
    ]);

    const hitText = await collect(
      [mkNode('q1', 'question', 't1')],
      [mkContent('q1', 'question', { content: '' })],
      { query: 'building', fields: ['conversation'] },
    );
    expect(hitText.filter((e) => e.type === 'match')).toHaveLength(1);

    const hitTool = await collect(
      [mkNode('q1', 'question', 't1')],
      [mkContent('q1', 'question', { content: '' })],
      { query: 'SECRETTOKEN', fields: ['conversation'] },
    );
    expect(hitTool.filter((e) => e.type === 'match')).toHaveLength(0);
  });

  it('skips the conversation tier for single-node (nodeId) searches', async () => {
    turnsByThread.clear();
    turnsByThread.set('t1', [mkTurn('hello there', 'general kenobi')]);

    const events = await collect(
      [mkNode('q1', 'question', 't1')],
      [mkContent('q1', 'question', { content: '' })],
      { query: 'kenobi', nodeId: 'q1' },
    );
    expect(events.filter((e) => e.type === 'match')).toHaveLength(0);
  });

  it('does not scan threads when the conversation field is not requested', async () => {
    turnsByThread.clear();
    turnsByThread.set('t1', [mkTurn('hello there', 'general kenobi')]);

    const events = await collect(
      [mkNode('q1', 'question', 't1')],
      [mkContent('q1', 'question', { content: '' })],
      { query: 'kenobi', fields: ['content'] },
    );
    expect(events.filter((e) => e.type === 'match')).toHaveLength(0);
  });
});
