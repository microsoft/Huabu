// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  read: vi.fn(),
  content: vi.fn(),
}));
vi.mock('./agent-thread-resolver.js', async (original) => ({
  ...(await original<typeof Resolver>()),
  agentThreadResolver: { resolveAgentNode: mocks.resolve },
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

import type * as Resolver from './agent-thread-resolver.js';
import type * as Executor from '../canvas/canvas-executor.js';
import type * as Storage from '../storage/index.js';

let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({
    canvasId: 'child',
    nodeId: 'agent',
    threadId: 'thread',
    agentBinding: { kind: 'internal' },
  });
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
  expect(mocks.resolve).toHaveBeenCalledWith('child', 'thread');
});

it('validates the scope before resolving or reading any owner', async () => {
  const result = await app.inject('/agent/owner/thread');
  expect(result.statusCode).toBe(400);
  expect(mocks.resolve).not.toHaveBeenCalled();
});

it('does not substitute another conversation when its owner is missing', async () => {
  mocks.resolve.mockResolvedValue(null);
  const result = await app.inject('/agent/owner/thread?canvasId=child');
  expect(result.statusCode).toBe(404);
  expect(result.json().code).toBe('conversation_owner_missing');
});

it('rejects an association changed between resolution and reading', async () => {
  mocks.read.mockResolvedValue({ title: 'Child', state: { nodes: [] } });
  const result = await app.inject('/agent/owner/thread?canvasId=child');
  expect(result.statusCode).toBe(409);
  expect(result.json().code).toBe('conversation_owner_mismatch');
});
