// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The no-spawn meta route, now that both of its reads are awaited.
 *
 * The route answers in a fixed priority order — live session, then this
 * thread's durable record, then the profile-wide schema cache, then nothing —
 * and the agentlet the live lookup is keyed by is itself read from the record.
 * Asynchronous persistence turns both of those reads into awaits, so a missed
 * one degrades quietly: a live session becomes invisible, and a known thread
 * answers as if it had never been used. Each case here holds the read open to
 * be sure the handler waited for the answer it acts on.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  live: new Map<string, unknown>(),
  record: undefined as unknown,
  recordReads: 0,
}));

vi.mock('@agenetes/acp-driver', () => ({
  acpSessionRegistry: {
    get: (agentletId: string, threadId: string) =>
      mocks.live.get(`${agentletId}\u0000${threadId}`),
  },
}));

vi.mock('@agenetes/agentlet-host', () => ({
  getSupervisedAgentletId: () => 'agentlet-supervised',
}));

vi.mock('./external-agent-realization.js', () => ({
  externalAgentRealization: { realize: vi.fn(), ensureSession: vi.fn() },
  realizationHttpError: () => ({
    status: 503,
    body: { message: 'unused', code: 'internal' },
  }),
}));

vi.mock('./profile-schema-cache.js', () => ({
  getProfileSchemaCache: () => undefined,
}));

vi.mock('./profile-session-preferences.js', () => ({
  rememberProfileConfigPreference: vi.fn(),
  rememberProfileSessionPreference: vi.fn(),
}));

vi.mock('../../workspace/paths.js', () => ({
  canvasAcpNamespace: (canvasId: string) => ({ name: canvasId }),
}));

vi.mock('../agenetes/index.js', () => ({
  agenetes: {
    // Every read costs at least a macrotask, the way a networked structured
    // backend does; a handler that forgets to wait sees `undefined`.
    record: async () => {
      mocks.recordReads += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return mocks.record;
    },
    get: vi.fn(),
    create: vi.fn(),
  },
}));

import acpThreadsRoutes from './threads.route.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  mocks.live.clear();
  mocks.record = undefined;
  mocks.recordReads = 0;
});

async function createApp(): Promise<FastifyInstance> {
  app = Fastify({ logger: false });
  await app.register(acpThreadsRoutes, { prefix: '/api/acp' });
  return app;
}

function externalRecord(agentletId: string, metadata?: unknown) {
  return {
    driverSchemaVersion: 1,
    spec: {
      threadId: 'thread-1',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: { name: 'canvas-1' },
      spec: { agentletId, binding: { alias: 'A', profileId: 'profile-1' } },
    },
    state: { driverState: {}, ...(metadata ? { metadata } : {}) },
  };
}

const CACHED_META_URL =
  '/api/acp/threads/thread-1/cached-meta?canvasId=canvas-1&profileId=profile-1';

describe('ACP cached-meta across awaited persistence', () => {
  it('finds the live session under the agentlet its durable record names', async () => {
    mocks.record = externalRecord('agentlet-from-record');
    mocks.live.set('agentlet-from-record\u0000thread-1', {
      availableCommands: [{ name: 'review', description: 'Review changes' }],
      commandsUpdatedAt: 31,
      availableModes: [{ id: 'plan', name: 'Plan' }],
      currentModeId: 'plan',
      availableModels: [],
      currentModelId: null,
      configOptions: [],
      selections: { mode: 'plan' },
      sessionInfo: null,
      usage: null,
      metaUpdatedAt: 32,
    });
    const server = await createApp();

    const response = await server.inject({
      method: 'GET',
      url: CACHED_META_URL,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: 'thread',
      availableCommands: [{ name: 'review' }],
      commandsUpdatedAt: 31,
      sessionMeta: {
        currentModeId: 'plan',
        selections: { mode: 'plan' },
        updatedAt: 32,
      },
    });
  });

  it('falls back to the supervised agentlet for a thread with no record', async () => {
    mocks.live.set('agentlet-supervised\u0000thread-1', {
      availableCommands: [],
      commandsUpdatedAt: 3,
      availableModes: [],
      currentModeId: null,
      availableModels: [],
      currentModelId: null,
      configOptions: [],
      selections: {},
      sessionInfo: null,
      usage: null,
      metaUpdatedAt: 4,
    });
    const server = await createApp();

    const response = await server.inject({
      method: 'GET',
      url: CACHED_META_URL,
    });

    expect(response.json()).toMatchObject({
      source: 'thread',
      commandsUpdatedAt: 3,
      sessionMeta: { updatedAt: 4 },
    });
  });

  it('answers a dormant thread from the metadata its record kept', async () => {
    mocks.record = externalRecord('agentlet-from-record', {
      availableCommands: [{ name: 'compact', description: 'Compact context' }],
      commandsUpdatedAt: 11,
      availableModes: [{ id: 'ask', name: 'Ask' }],
      currentModeId: 'ask',
      availableModels: [{ modelId: 'model-1', name: 'Model 1' }],
      currentModelId: 'model-1',
      configOptions: [],
      selections: { model: 'model-1' },
      sessionInfo: { title: 'Prior session', updatedAt: null },
      usage: null,
      metaUpdatedAt: 12,
    });
    const server = await createApp();

    const response = await server.inject({
      method: 'GET',
      url: CACHED_META_URL,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      source: 'thread',
      availableCommands: [{ name: 'compact', description: 'Compact context' }],
      commandsUpdatedAt: 11,
      sessionMeta: {
        availableModes: [{ id: 'ask', name: 'Ask' }],
        currentModeId: 'ask',
        availableModels: [{ modelId: 'model-1', name: 'Model 1' }],
        currentModelId: 'model-1',
        configOptions: [],
        selections: { model: 'model-1' },
        sessionInfo: { title: 'Prior session', updatedAt: null },
        usage: null,
        updatedAt: 12,
      },
    });
    // The agentlet lookup and the metadata read are two separate reads.
    expect(mocks.recordReads).toBe(2);
  });

  it('reports a neutral snapshot for a thread nothing has ever opened', async () => {
    const server = await createApp();

    const response = await server.inject({
      method: 'GET',
      url: CACHED_META_URL,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      source: 'none',
      availableCommands: [],
      commandsUpdatedAt: 0,
      sessionMeta: {
        availableModes: [],
        currentModeId: null,
        availableModels: [],
        currentModelId: null,
        configOptions: [],
        selections: {},
        sessionInfo: null,
        usage: null,
        updatedAt: 0,
      },
    });
  });
});
