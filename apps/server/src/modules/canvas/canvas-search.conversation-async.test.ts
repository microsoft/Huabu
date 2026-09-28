// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The conversation tier once reading a thread became an await.
 *
 * The tier walks candidates in order and stops on the global limit or on
 * abort, and every one of those decisions now straddles a suspension point.
 * The histories below take a real suspension to answer, so a scan that lost a
 * late answer, or let a second thread start before the first was attributed,
 * shows up as a missing or misordered match rather than as a timing flake.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { searchCanvas, type SearchableNode } from './canvas-search.js';
import { createChatSubmission } from '../agent/agenetes/handle.js';

import type { ChatEnvelope } from '../agent/conversation/envelope.js';
import type { NodeContent, NodeSnapshot, Space } from '../storage/index.js';
import type { AgentTurn } from '@agenetes/protocol';
import type { CanvasSearchEvent, CanvasSearchRequest } from '@huabu/shared';

const turnsByThread = vi.hoisted(() => new Map<string, AgentTurn[]>());
/** Threads whose history has been asked for, in the order they were asked. */
const readOrder = vi.hoisted(() => [] as string[]);
/** How many reads were ever in flight together. */
const concurrency = vi.hoisted(() => ({ current: 0, peak: 0 }));

vi.mock('../agent/agenetes/drivers.js', () => ({
  INTERNAL_DRIVER_KIND: 'internal',
  agenetes: {
    history: async (_namespace: unknown, threadId: string) => {
      readOrder.push(threadId);
      concurrency.current += 1;
      concurrency.peak = Math.max(concurrency.peak, concurrency.current);
      await new Promise((resolve) => setImmediate(resolve));
      concurrency.current -= 1;
      return { turns: turnsByThread.get(threadId) ?? [] };
    },
    record: async () => ({ spec: { kind: 'internal' } }),
  },
}));

vi.mock('../workspace/paths.js', async (importActual) => ({
  ...((await importActual()) as Record<string, unknown>),
  canvasAcpNamespace: (canvasId: string) => ({ name: canvasId, root: '' }),
}));

function turn(userText: string, assistantText: string): AgentTurn {
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

function fakeSpace(nodes: readonly SearchableNode[]): Space {
  const contents: NodeContent[] = nodes.map((node) => ({
    nodeId: node.id,
    type: node.type,
    label: node.id.toUpperCase(),
    content: '',
  }));
  return {
    canvasId: 'test-canvas',
    read: async () => ({
      state: {
        nodes: nodes.map((node) => ({
          id: node.id,
          type: node.type,
          ...(node.threadId ? { data: { threadId: node.threadId } } : {}),
        })),
        edges: [],
      },
    }),
    nodes: {
      canvasId: 'test-canvas',
      stream: async (onNode: (snapshot: NodeSnapshot) => void) => {
        const map = new Map<string, NodeSnapshot>();
        for (const record of contents) {
          const snapshot = { record, revision: `rev-${record.nodeId}` };
          map.set(record.nodeId, snapshot);
          onNode(snapshot);
        }
        return map;
      },
    },
  } as unknown as Space;
}

function threadedNodes(count: number): SearchableNode[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `q${index + 1}`,
    type: 'question',
    threadId: `t${index + 1}`,
  }));
}

async function collect(
  nodes: readonly SearchableNode[],
  request: CanvasSearchRequest,
  signal?: AbortSignal,
): Promise<CanvasSearchEvent[]> {
  const events: CanvasSearchEvent[] = [];
  await searchCanvas(fakeSpace(nodes), request, (e) => events.push(e), signal);
  return events;
}

function matchedNodeIds(events: readonly CanvasSearchEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'match' ? [event.match.nodeId] : [],
  );
}

beforeEach(() => {
  turnsByThread.clear();
  readOrder.length = 0;
  concurrency.current = 0;
  concurrency.peak = 0;
});

describe('searchCanvas conversation tier over awaited history', () => {
  it("keeps every thread's match and its candidate order", async () => {
    for (const index of [1, 2, 3]) {
      turnsByThread.set(`t${index}`, [
        turn(`question ${index}`, `deployment answer ${index}`),
      ]);
    }

    const events = await collect(threadedNodes(3), {
      query: 'deployment',
      fields: ['conversation'],
    });

    expect(matchedNodeIds(events)).toEqual(['q1', 'q2', 'q3']);
    expect(readOrder).toEqual(['t1', 't2', 't3']);
    // One thread at a time, so a match is always attributed before the next
    // read begins and the emission order stays the candidate order.
    expect(concurrency.peak).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: 'done', truncated: false });
  });

  it('stops reading threads once the limit is reached', async () => {
    for (const index of [1, 2, 3]) {
      turnsByThread.set(`t${index}`, [
        turn(`question ${index}`, `deployment answer ${index}`),
      ]);
    }

    const events = await collect(threadedNodes(3), {
      query: 'deployment',
      fields: ['conversation'],
      limit: 2,
    });

    expect(matchedNodeIds(events)).toEqual(['q1', 'q2']);
    // The third thread is never read: the limit is checked before the await.
    expect(readOrder).toEqual(['t1', 't2']);
    expect(events.at(-1)).toMatchObject({ type: 'done', truncated: true });
  });

  it('abandons the walk when the request aborts during a read', async () => {
    const controller = new AbortController();
    turnsByThread.set('t1', [turn('first', 'deployment answer one')]);
    turnsByThread.set('t2', [turn('second', 'deployment answer two')]);
    const events: CanvasSearchEvent[] = [];

    await searchCanvas(
      fakeSpace(threadedNodes(2)),
      { query: 'deployment', fields: ['conversation'] },
      (event) => {
        events.push(event);
        if (event.type === 'match') controller.abort();
      },
      controller.signal,
    );

    expect(matchedNodeIds(events)).toEqual(['q1']);
    expect(readOrder).toEqual(['t1']);
    // An abandoned walk never claims to be done.
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });
});
