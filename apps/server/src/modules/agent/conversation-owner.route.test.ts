// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  content: vi.fn(),
  releaseLease: vi.fn(),
  workspaceKey: 'test',
}));
vi.mock('../workspace.js', async (original) => ({
  ...(await original<typeof Workspace>()),
  acquireWorkspaceOperationLease: () => ({
    workspaceKey: mocks.workspaceKey,
    release: mocks.releaseLease,
  }),
  getWorkspaceKey: () => mocks.workspaceKey,
}));
vi.mock('../storage/index.js', async (original) => ({
  ...(await original<typeof Storage>()),
  space: () => ({ read: mocks.read, nodes: { read: mocks.content } }),
}));
vi.mock('../canvas/canvas-executor.js', async (original) => ({
  ...(await original<typeof Executor>()),
  hydrateCanvasNodes: (_records: unknown, nodes: unknown[]) => nodes,
}));

import agentRoutes from './agent.route.js';
import { publishCanvasUpdate } from '../canvas/canvas-sync.js';
import { withCanvasMutex } from '../canvas/write-coordinator.js';

import type * as Executor from '../canvas/canvas-executor.js';
import type * as Storage from '../storage/index.js';
import type * as Workspace from '../workspace.js';
import type { AgentConversationOwnerEvent } from '@huabu/shared';

let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.workspaceKey = 'test';
  mocks.read.mockResolvedValue({
    title: 'Child Space',
    state: {
      nodes: [
        {
          id: 'agent',
          type: 'question',
          data: {
            threadId: 'thread',
            label: 'Original task',
            status: 'done',
            viewed: false,
            content: 'Private body not needed for ownership',
          },
        },
      ],
    },
  });
  mocks.content.mockResolvedValue({ record: {} });
  app = Fastify();
  await app.register(agentRoutes, { prefix: '/agent' });
});
afterEach(async () => {
  await app.close();
});

it('returns the canonical owner and only the bounded presentation/configuration fields', async () => {
  const result = await app.inject('/agent/owner/thread?canvasId=child');
  expect(result.statusCode).toBe(200);
  expect(result.headers['cache-control']).toBe('no-store');
  expect(result.json()).toEqual({
    observation: { epoch: expect.any(String), revision: expect.any(Number) },
    canvasId: 'child',
    nodeId: 'agent',
    threadId: 'thread',
    spaceTitle: 'Child Space',
    source: {
      hasAuthoredContent: true,
      label: 'Original task',
      status: 'done',
      viewed: false,
      agentBinding: { kind: 'internal' },
    },
  });
  expect(mocks.read).toHaveBeenCalledOnce();
});

it('validates the scope before resolving or reading any owner', async () => {
  const result = await app.inject('/agent/owner/thread');
  expect(result.statusCode).toBe(400);
  expect(mocks.read).not.toHaveBeenCalled();
});

it('does not substitute another conversation when its owner is missing', async () => {
  mocks.read.mockResolvedValue({ title: 'Child', state: { nodes: [] } });
  const result = await app.inject('/agent/owner/thread?canvasId=child');
  expect(result.statusCode).toBe(404);
  expect(result.json().code).toBe('conversation_owner_missing');
});

it('rejects duplicate thread associations using the canonical resolver', async () => {
  const canvas = await mocks.read();
  mocks.read.mockResolvedValue({
    ...canvas,
    state: {
      nodes: [
        ...canvas.state.nodes,
        { ...canvas.state.nodes[0], id: 'duplicate' },
      ],
    },
  });
  const result = await app.inject('/agent/owner/thread?canvasId=child');
  expect(result.statusCode).toBe(409);
  expect(result.json().code).toBe('duplicate_thread');
});

async function openStream() {
  if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.listeningOrigin;
  const controller = new AbortController();
  const response = await fetch(
    `${address}/agent/owner/thread/stream?canvasId=child`,
    { signal: controller.signal },
  );
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing conversation state stream');
  let buffer = '';
  return {
    close: () => controller.abort(),
    next: async (): Promise<AgentConversationOwnerEvent> => {
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const type = frame.match(/^event: (.+)$/m)?.[1];
          const data = frame.match(/^data: (.+)$/m)?.[1];
          if (type && data)
            return {
              type,
              data: JSON.parse(data),
            } as AgentConversationOwnerEvent;
        } else {
          const chunk = await reader.read();
          if (chunk.done)
            throw new Error('State stream ended before the next frame');
          buffer += new TextDecoder().decode(chunk.value);
        }
      }
    },
  };
}

it('pushes complete ordered states through running, removal and restoration without client queries', async () => {
  const stream = await openStream();
  try {
    const first = await stream.next();
    expect(first).toMatchObject({
      type: 'snapshot',
      data: {
        revision: 1,
        value: { state: 'ready', owner: { source: { status: 'done' } } },
      },
    });
    const canvas = await mocks.read();
    mocks.read.mockResolvedValue({
      ...canvas,
      state: {
        nodes: [
          {
            ...canvas.state.nodes[0],
            data: {
              ...canvas.state.nodes[0].data,
              status: 'running',
              invocationToken: 'run',
            },
          },
        ],
      },
    });
    publishCanvasUpdate('child', {
      type: 'invalidate',
      data: { nodeIds: ['agent'] },
    });
    expect(await stream.next()).toMatchObject({
      type: 'snapshot',
      data: {
        revision: 2,
        value: {
          state: 'ready',
          owner: { source: { status: 'running', invocationToken: 'run' } },
        },
      },
    });
    mocks.read.mockResolvedValue({ ...canvas, state: { nodes: [] } });
    publishCanvasUpdate('child', { type: 'invalidate', data: {} });
    expect(await stream.next()).toMatchObject({
      type: 'snapshot',
      data: {
        revision: 3,
        value: {
          state: 'unavailable',
          error: { code: 'conversation_owner_missing' },
        },
      },
    });
    mocks.read.mockResolvedValue(canvas);
    publishCanvasUpdate('child', { type: 'invalidate', data: {} });
    expect(await stream.next()).toMatchObject({
      type: 'snapshot',
      data: { revision: 4, value: { state: 'ready' } },
    });
    const reads = mocks.read.mock.calls.length;
    publishCanvasUpdate('child', {
      type: 'invalidate',
      data: { nodeIds: ['unrelated'] },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.read).toHaveBeenCalledTimes(reads);
  } finally {
    stream.close();
  }
});

it('subscribes before the initial read and discards a baseline invalidated while being read', async () => {
  let finish!: (value: unknown) => void;
  mocks.content.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const stream = await openStream();
  try {
    await vi.waitFor(() => expect(mocks.content).toHaveBeenCalledOnce());
    mocks.read.mockResolvedValue({ title: 'Child', state: { nodes: [] } });
    publishCanvasUpdate('child', { type: 'invalidate', data: {} });
    finish({ record: {} });
    expect(await stream.next()).toMatchObject({
      type: 'snapshot',
      data: { revision: 1, value: { state: 'unavailable' } },
    });
  } finally {
    finish({ record: {} });
    stream.close();
  }
});

it('emits explicit transport errors and releases observation after failed state reads', async () => {
  mocks.content.mockRejectedValueOnce(new Error('Storage unavailable'));
  const stream = await openStream();
  try {
    expect(await stream.next()).toMatchObject({
      type: 'error',
      data: { status: 503 },
    });
    const reads = mocks.read.mock.calls.length;
    publishCanvasUpdate('child', { type: 'invalidate', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.read).toHaveBeenCalledTimes(reads);
  } finally {
    stream.close();
  }
});

it('validates stream addresses before subscribing', async () => {
  const response = await app.inject('/agent/owner/thread/stream');
  expect(response.statusCode).toBe(400);
  expect(mocks.read).not.toHaveBeenCalled();
});

it('does not read another Workspace after activation changes its scope', async () => {
  const stream = await openStream();
  try {
    await stream.next();
    const reads = mocks.read.mock.calls.length;
    mocks.workspaceKey = 'different';
    publishCanvasUpdate('child', { type: 'invalidate', data: {} });
    expect(await stream.next()).toMatchObject({
      type: 'error',
      data: { status: 503 },
    });
    expect(mocks.read).toHaveBeenCalledTimes(reads);
  } finally {
    stream.close();
  }
});

it('releases coordination at the deadline and refuses duplicate abandoned storage reads', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let finish!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  mocks.content.mockImplementationOnce(() => {
    entered();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const stream = await openStream();
  try {
    await started;
    await vi.advanceTimersByTimeAsync(9999);
    expect(mocks.releaseLease).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await stream.next()).toMatchObject({
      type: 'error',
      data: { status: 408 },
    });
    expect(mocks.releaseLease).toHaveBeenCalledOnce();
    await expect(
      withCanvasMutex('child', async () => 'write admitted'),
    ).resolves.toBe('write admitted');
    const retry = await app.inject('/agent/owner/thread?canvasId=child');
    expect(retry.statusCode).toBe(503);
    expect(mocks.content).toHaveBeenCalledOnce();
    mocks.workspaceKey = 'other';
    finish({ record: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.content).toHaveBeenCalledOnce();
  } finally {
    finish({ record: {} });
    stream.close();
    vi.useRealTimers();
  }
});

it('bounds ordinary HTTP reads and releases their coordination at ten seconds', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let finish!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  mocks.read.mockImplementationOnce(() => {
    entered();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const request = (async () =>
    await app.inject('/agent/owner/thread?canvasId=child'))();
  try {
    await started;
    await vi.advanceTimersByTimeAsync(9999);
    expect(mocks.releaseLease).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await request).statusCode).toBe(408);
    expect(mocks.releaseLease).toHaveBeenCalledOnce();
    await expect(withCanvasMutex('child', async () => true)).resolves.toBe(
      true,
    );
    mocks.workspaceKey = 'other';
    finish({ title: 'Old', state: { nodes: [] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.content).not.toHaveBeenCalled();
  } finally {
    finish(null);
    vi.useRealTimers();
  }
});

it('cancels a disconnected read and releases its lease before storage finishes', async () => {
  let finish!: (value: unknown) => void;
  mocks.content.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const stream = await openStream();
  try {
    await vi.waitFor(() => expect(mocks.content).toHaveBeenCalledOnce());
    stream.close();
    await vi.waitFor(() => expect(mocks.releaseLease).toHaveBeenCalledOnce());
    await expect(withCanvasMutex('child', async () => true)).resolves.toBe(
      true,
    );
  } finally {
    finish({ record: {} });
  }
});

it('does not acquire a lease or read storage after timing out behind a writer', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let release!: () => void;
  const writer = withCanvasMutex(
    'child',
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  const stream = await openStream();
  try {
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await stream.next()).toMatchObject({
      type: 'error',
      data: { status: 408 },
    });
    release();
    await writer;
    await withCanvasMutex('child', async () => {});
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.releaseLease).not.toHaveBeenCalled();
  } finally {
    release();
    stream.close();
    vi.useRealTimers();
  }
});

it('orders successful and missing observations across HTTP and SSE', async () => {
  const stream = await openStream();
  try {
    const initial = await stream.next();
    if (initial.type !== 'snapshot' || initial.data.value.state !== 'ready')
      throw new Error('Expected ready snapshot');
    const first = initial.data.value.owner.observation;
    const response = await app.inject('/agent/owner/thread?canvasId=child');
    const second = response.json().observation;
    expect(second.epoch).toBe(first?.epoch);
    expect(second.revision).toBeGreaterThan(first?.revision ?? 0);
    mocks.read.mockResolvedValue({ title: 'Child', state: { nodes: [] } });
    publishCanvasUpdate('child', { type: 'invalidate', data: {} });
    const removed = await stream.next();
    if (
      removed.type !== 'snapshot' ||
      removed.data.value.state !== 'unavailable'
    )
      throw new Error('Expected unavailable snapshot');
    const third = removed.data.value.error.details?.observation;
    expect(third?.epoch).toBe(second.epoch);
    expect(third?.revision).toBeGreaterThan(second.revision);
  } finally {
    stream.close();
  }
});
