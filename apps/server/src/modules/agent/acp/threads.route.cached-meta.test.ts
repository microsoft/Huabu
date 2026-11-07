// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The no-spawn meta route awaits a single durable-record snapshot.
 *
 * The route answers in a fixed priority order — live session, then this
 * thread's durable record, then the profile-wide schema cache, then nothing —
 * and the agentlet the live lookup is keyed by is itself read from the record.
 * Missing the asynchronous persistence await degrades quietly:
 * a live session becomes invisible, and a known thread
 * answers as if it had never been used. Each case here holds the read open to
 * be sure the handler waited for the answer it acts on.
 */

import { threadIdentityKey } from '@agenetes/runtime';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import acpThreadsRoutes from './threads.route.js';

import type { Namespace } from '@agenetes/protocol';

const mocks = vi.hoisted(() => ({
  live: new Map<string, unknown>(),
  workspaceOwner: 'workspace-a',
  record: undefined as unknown,
  recordReads: 0,
  afterRecordRead: undefined as (() => void) | undefined,
}));

vi.mock('@agenetes/acp-driver', () => ({
  acpSessionRegistry: {
    get: (agentletId: string, threadId: string, namespace?: Namespace) =>
      mocks.live.get(
        JSON.stringify([
          agentletId,
          threadIdentityKey({ threadId, namespace }),
        ]),
      ),
  },
}));

vi.mock('@agenetes/agentlet-host', () => ({
  getAgentProfileRegistry: () => ({ getProfile: (id: string) => ({ id }) }),
  resolveConnectedAgentletId: (agentletId: string) =>
    agentletId === 'legacy-host' ? 'device-uuid' : agentletId,
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
  canvasAcpNamespace: (canvasId: string) => ({
    name: canvasId,
    ownerId: mocks.workspaceOwner,
  }),
}));

vi.mock('../agenetes/index.js', () => ({
  agenetes: {
    // Every read costs at least a macrotask, the way a networked structured
    // backend does; a handler that forgets to wait sees `undefined`.
    record: async () => {
      mocks.recordReads += 1;
      await new Promise((resolve) => setImmediate(resolve));
      mocks.afterRecordRead?.();
      return mocks.record;
    },
    get: vi.fn(),
    create: vi.fn(),
  },
}));

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  mocks.live.clear();
  mocks.workspaceOwner = 'workspace-a';
  mocks.record = undefined;
  mocks.recordReads = 0;
  mocks.afterRecordRead = undefined;
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
      namespace: { name: 'canvas-1', ownerId: mocks.workspaceOwner },
      spec: { agentletId, binding: { alias: 'A', profileId: 'profile-1' } },
    },
    state: { driverState: {}, ...(metadata ? { metadata } : {}) },
  };
}

const CACHED_META_URL =
  '/api/acp/threads/thread-1/cached-meta?canvasId=canvas-1&profileId=profile-1';

function liveKey(agentletId: string, ownerId = mocks.workspaceOwner): string {
  return JSON.stringify([
    agentletId,
    threadIdentityKey({
      threadId: 'thread-1',
      namespace: { name: 'canvas-1', ownerId },
    }),
  ]);
}

describe('ACP cached-meta across awaited persistence', () => {
  it('finds the live session under the agentlet its durable record names', async () => {
    mocks.record = externalRecord('agentlet-from-record');
    mocks.live.set(liveKey('agentlet-from-record'), {
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
      execution: { agentletId: 'agentlet-from-record' },
      availableCommands: [{ name: 'review' }],
      commandsUpdatedAt: 31,
      sessionMeta: {
        currentModeId: 'plan',
        selections: { mode: 'plan' },
        updatedAt: 32,
      },
    });
  });

  it('finds a live session through unique hostname-era placement resolution', async () => {
    mocks.record = externalRecord('legacy-host');
    mocks.live.set(liveKey('device-uuid'), {
      availableCommands: [{ name: 'review', description: 'Review changes' }],
      commandsUpdatedAt: 5,
      availableModes: [],
      currentModeId: null,
      availableModels: [],
      currentModelId: null,
      configOptions: [],
      selections: {},
      sessionInfo: null,
      usage: null,
      metaUpdatedAt: 6,
    });
    const response = await (await createApp()).inject(CACHED_META_URL);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: 'thread',
      execution: { agentletId: 'device-uuid' },
      availableCommands: [{ name: 'review' }],
    });
  });

  it('does not invent a placement for a thread with no record', async () => {
    mocks.live.set(liveKey('agentlet-supervised'), {
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

    expect(response.json()).toMatchObject({ source: 'none' });
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
      execution: {
        binding: { kind: 'external', alias: 'A', profileId: 'profile-1' },
        agentletId: 'agentlet-from-record',
      },
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
    expect(mocks.recordReads).toBe(1);
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

  it('returns only the current Workspace metadata for same-device matching Space and thread ids', async () => {
    const server = await createApp();
    for (const ownerId of ['workspace-a', 'workspace-b']) {
      mocks.live.set(liveKey('shared-device', ownerId), {
        availableCommands: [{ name: `private-${ownerId}` }],
        commandsUpdatedAt: 1,
        availableModes: [],
        currentModeId: ownerId,
        availableModels: [],
        currentModelId: null,
        configOptions: [],
        selections: { mode: ownerId },
        sessionInfo: { title: `Private ${ownerId}`, updatedAt: null },
        usage: null,
        metaUpdatedAt: 2,
      });
    }
    for (const ownerId of ['workspace-a', 'workspace-b']) {
      mocks.workspaceOwner = ownerId;
      mocks.record = externalRecord('shared-device');
      const response = await server.inject(CACHED_META_URL);
      expect(response.statusCode).toBe(200);
      expect.soft(response.json()).toMatchObject({
        availableCommands: [{ name: `private-${ownerId}` }],
        sessionMeta: {
          currentModeId: ownerId,
          sessionInfo: { title: `Private ${ownerId}` },
          selections: { mode: ownerId },
        },
      });
    }
  });

  it('keeps the record namespace captured before an awaited metadata read', async () => {
    mocks.record = externalRecord('shared-device');
    for (const ownerId of ['workspace-a', 'workspace-b']) {
      mocks.live.set(liveKey('shared-device', ownerId), {
        availableCommands: [],
        commandsUpdatedAt: 1,
        availableModes: [],
        currentModeId: ownerId,
        availableModels: [],
        currentModelId: null,
        configOptions: [],
        selections: {},
        sessionInfo: null,
        usage: null,
        metaUpdatedAt: 2,
      });
    }
    // Simulate a local Workspace switch while persistence is awaited. The
    // session lookup must use the same scope as the already-started read.
    mocks.afterRecordRead = () => {
      mocks.workspaceOwner = 'workspace-b';
    };
    const response = await (await createApp()).inject(CACHED_META_URL);
    expect(response.statusCode).toBe(200);
    expect(response.json().sessionMeta.currentModeId).toBe('workspace-a');
  });
});
