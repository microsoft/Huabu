// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  live: undefined as unknown,
  record: undefined as unknown,
  profileCache: undefined as unknown,
  realize: vi.fn(),
  ensureSession: vi.fn(),
  control: vi.fn(),
  create: vi.fn(),
  rememberModel: vi.fn(),
}));

vi.mock('@agenetes/acp-driver', () => ({
  acpSessionRegistry: { get: () => mocks.live },
}));

vi.mock('./external-agent-realization.js', () => ({
  externalAgentRealization: {
    realize: mocks.realize,
    ensureSession: mocks.ensureSession,
  },
  realizationHttpError: (error: unknown) => ({
    status: 503,
    body: { message: String(error), code: 'internal' },
  }),
}));

vi.mock('./profile-schema-cache.js', () => ({
  getProfileSchemaCache: () => mocks.profileCache,
}));

vi.mock('./profile-session-preferences.js', () => ({
  rememberProfileConfigPreference: vi.fn(),
  rememberProfileSessionPreference: mocks.rememberModel,
}));

vi.mock('../../workspace/paths.js', () => ({
  canvasAcpNamespace: (canvasId: string) => ({ name: canvasId }),
}));

vi.mock('../agenetes/index.js', () => ({
  agenetes: {
    record: () => mocks.record,
    get: vi.fn(),
    create: mocks.create,
  },
}));

import acpThreadsRoutes, { awaitSchemaQuiescence } from './threads.route.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  mocks.live = undefined;
  mocks.record = undefined;
  mocks.profileCache = undefined;
  mocks.realize.mockReset();
  mocks.ensureSession.mockReset();
  mocks.control.mockReset();
  mocks.create.mockReset();
  mocks.rememberModel.mockReset();
});

async function createApp(): Promise<FastifyInstance> {
  app = Fastify({ logger: false });
  await app.register(acpThreadsRoutes, { prefix: '/api/acp' });
  return app;
}

describe('ACP cached capability route', () => {
  it('projects commands and selector catalogues from the Profile cache', async () => {
    mocks.profileCache = {
      availableCommands: [{ name: 'review', description: 'Review changes' }],
      commandsUpdatedAt: 11,
      availableModes: [{ id: 'plan', name: 'Plan' }],
      currentModeId: 'plan',
      availableModels: [{ modelId: 'model-1', name: 'Model 1' }],
      currentModelId: 'model-1',
      configOptions: [
        {
          id: 'allow_all',
          name: 'Auto approve',
          type: 'boolean',
          currentValue: true,
        },
      ],
      metaUpdatedAt: 12,
    };
    const server = await createApp();

    const response = await server.inject({
      method: 'GET',
      url: '/api/acp/threads/thread-1/cached-meta?canvasId=canvas-1&profileId=profile-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: 'profile',
      availableCommands: [{ name: 'review' }],
      commandsUpdatedAt: 11,
      sessionMeta: {
        currentModeId: 'plan',
        currentModelId: 'model-1',
        selections: {},
        updatedAt: 12,
      },
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('returns a successful empty observation on a cold cache', async () => {
    const server = await createApp();

    const response = await server.inject({
      method: 'GET',
      url: '/api/acp/threads/thread-1/cached-meta?canvasId=canvas-1&profileId=profile-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: 'none',
      availableCommands: [],
      commandsUpdatedAt: 0,
      sessionMeta: { updatedAt: 0 },
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('returns Profile commands when the agent has not published session metadata', async () => {
    mocks.profileCache = {
      availableCommands: [{ name: 'review', description: 'Review changes' }],
      commandsUpdatedAt: 11,
      metaUpdatedAt: 0,
    };
    const server = await createApp();

    const response = await server.inject({
      method: 'GET',
      url: '/api/acp/threads/thread-1/cached-meta?canvasId=canvas-1&profileId=profile-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: 'profile',
      availableCommands: [{ name: 'review' }],
      commandsUpdatedAt: 11,
      sessionMeta: { updatedAt: 0 },
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('does not project a newer Profile cache into an already realized thread without metadata', async () => {
    mocks.record = {
      spec: { spec: { profileExecutionRevision: 0 } },
      state: {},
    };
    mocks.profileCache = {
      availableCommands: [{ name: 'new-profile-command' }],
      commandsUpdatedAt: 10,
    };
    const server = await createApp();
    const response = await server.inject(
      '/api/acp/threads/thread-1/cached-meta?canvasId=canvas-1&profileId=profile-1',
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: 'thread',
      availableCommands: [],
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('realizes and ensures the canonical workload before a first control', async () => {
    const realized = {
      binding: {
        kind: 'external',
        alias: 'Fixed Agent',
        profileId: 'profile-fixed',
      },
      fixedTarget: null,
      spec: { spec: { initialPreamble: ['Bootstrap', 'Space', 'Node'] } },
      handle: { control: mocks.control },
    };
    mocks.realize.mockResolvedValue(realized);
    mocks.ensureSession.mockResolvedValue({
      profileId: 'profile-fixed',
      configOptions: [],
    });
    mocks.control.mockResolvedValue({ ok: true });
    const server = await createApp();

    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/threads/thread-1/mode',
      payload: {
        modeId: 'plan',
        binding: {
          kind: 'external',
          alias: 'Fixed Agent',
          profileId: 'profile-fixed',
        },
        canvasId: 'canvas-1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.realize).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        canvasId: 'canvas-1',
        requestedBinding: {
          kind: 'external',
          alias: 'Fixed Agent',
          profileId: 'profile-fixed',
        },
      }),
    );
    expect(mocks.ensureSession).toHaveBeenCalledWith(
      realized,
      expect.any(Object),
    );
    expect(mocks.control).toHaveBeenCalledWith({
      type: 'set_mode',
      data: { modeId: 'plan' },
    });
  });

  it('warms a never-observed Profile by realizing and ensuring its session, with no control dispatched', async () => {
    const realized = {
      binding: {
        kind: 'external',
        alias: 'Fresh Agent',
        profileId: 'profile-fresh',
      },
      fixedTarget: null,
      spec: { spec: { initialPreamble: ['Bootstrap', 'Space', 'Node'] } },
      handle: { control: mocks.control },
    };
    mocks.realize.mockResolvedValue(realized);
    mocks.ensureSession.mockResolvedValue({
      profileId: 'profile-fresh',
      availableModes: [],
      availableModels: [],
      configOptions: [],
      metaUpdatedAt: 0,
    });
    const server = await createApp();

    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/threads/thread-1/warm',
      payload: {
        binding: {
          kind: 'external',
          alias: 'Fresh Agent',
          profileId: 'profile-fresh',
        },
        canvasId: 'canvas-1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(mocks.realize).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        canvasId: 'canvas-1',
        requestedBinding: {
          kind: 'external',
          alias: 'Fresh Agent',
          profileId: 'profile-fresh',
        },
      }),
    );
    expect(mocks.ensureSession).toHaveBeenCalledWith(
      realized,
      expect.any(Object),
    );
    expect(mocks.control).not.toHaveBeenCalled();
  });

  it('surfaces realization failure from the warm route without dispatching a control', async () => {
    mocks.realize.mockRejectedValue(new Error('spawn failed'));
    const server = await createApp();

    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/threads/thread-1/warm',
      payload: {
        binding: {
          kind: 'external',
          alias: 'Fresh Agent',
          profileId: 'profile-fresh',
        },
      },
    });

    expect(response.statusCode).toBe(503);
    expect(mocks.control).not.toHaveBeenCalled();
  });

  it('rejects a warm request missing the required binding', async () => {
    const server = await createApp();

    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/threads/thread-1/warm',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'validation_failed' });
    expect(mocks.realize).not.toHaveBeenCalled();
  });

  it('waits for a trailing config-option push to settle before responding', async () => {
    // Simulates an agent that reports mode inline in `session/new` but
    // pushes model/config-option catalogue a moment later via
    // `session/update` — the exact race this endpoint exists to close
    // for a warm-up, which has no live SSE stream to catch the straggler.
    const entry = {
      profileId: 'profile-fresh',
      availableModes: ['plan'],
      availableModels: [] as unknown[],
      configOptions: [] as unknown[],
      metaUpdatedAt: 1,
    };
    mocks.realize.mockResolvedValue({
      binding: {
        kind: 'external',
        alias: 'Fresh Agent',
        profileId: 'profile-fresh',
      },
      fixedTarget: null,
      spec: { spec: {} },
      handle: { control: mocks.control },
    });
    mocks.ensureSession.mockResolvedValue(entry);
    // Land the straggler push shortly after ensureSession resolves, well
    // before the route's default quiet window and max-wait budget elapse.
    setTimeout(() => {
      entry.configOptions = [{ id: 'model', category: 'model' }];
      entry.metaUpdatedAt = 2;
    }, 20);
    const server = await createApp();

    const start = Date.now();
    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/threads/thread-1/warm',
      payload: {
        binding: {
          kind: 'external',
          alias: 'Fresh Agent',
          profileId: 'profile-fresh',
        },
      },
    });
    const elapsedMs = Date.now() - start;

    expect(response.statusCode).toBe(200);
    // The route only returns after the entry has been quiet for the
    // default 300ms window measured from the LATEST mutation (~20ms in),
    // so the straggler above is guaranteed to have already landed.
    expect(elapsedMs).toBeGreaterThanOrEqual(300);
    expect(entry.configOptions).toEqual([{ id: 'model', category: 'model' }]);
  }, 10_000);

  it('passes the frozen execution revision when remembering a successful live model control', async () => {
    const binding = {
      kind: 'external',
      alias: 'Agent',
      profileId: 'profile-fixed',
    };
    mocks.realize.mockResolvedValue({
      binding,
      fixedTarget: null,
      spec: { spec: { profileExecutionRevision: 3 } },
      handle: { control: mocks.control },
    });
    mocks.ensureSession.mockResolvedValue({
      profileId: 'profile-fixed',
      configOptions: [],
    });
    mocks.control.mockResolvedValue({ ok: true });
    const server = await createApp();
    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/threads/thread-1/model',
      payload: { modelId: 'new-model', canvasId: 'canvas-1', binding },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.rememberModel).toHaveBeenCalledWith(
      'profile-fixed',
      'model',
      'new-model',
      3,
    );
  });
});

describe('awaitSchemaQuiescence', () => {
  it('resolves once the entry stops changing for the quiet window', async () => {
    const entry = {
      availableModes: [] as unknown[],
      availableModels: [] as unknown[],
      configOptions: [] as unknown[],
      metaUpdatedAt: 0,
    };
    setTimeout(() => {
      entry.configOptions = [{ id: 'model' }];
      entry.metaUpdatedAt = 1;
    }, 10);

    const start = Date.now();
    await awaitSchemaQuiescence(
      entry as unknown as Parameters<typeof awaitSchemaQuiescence>[0],
      { pollIntervalMs: 5, quietWindowMs: 20, maxWaitMs: 500 },
    );
    const elapsedMs = Date.now() - start;

    // Waited past the mutation at ~10ms plus the 20ms quiet window
    // measured from it, but well under the 500ms cap.
    expect(elapsedMs).toBeGreaterThanOrEqual(20);
    expect(elapsedMs).toBeLessThan(500);
    expect(entry.configOptions).toEqual([{ id: 'model' }]);
  });

  it('gives up at the max-wait budget when the entry never settles', async () => {
    const entry = {
      availableModes: [] as unknown[],
      availableModels: [] as unknown[],
      configOptions: [] as unknown[],
      metaUpdatedAt: 0,
    };
    const interval = setInterval(() => {
      entry.metaUpdatedAt += 1;
    }, 5);

    const start = Date.now();
    await awaitSchemaQuiescence(
      entry as unknown as Parameters<typeof awaitSchemaQuiescence>[0],
      { pollIntervalMs: 5, quietWindowMs: 20, maxWaitMs: 60 },
    );
    const elapsedMs = Date.now() - start;
    clearInterval(interval);

    // Never quiet for a full 20ms window, so the loop only exits via the
    // 60ms hard cap.
    expect(elapsedMs).toBeGreaterThanOrEqual(60);
    expect(elapsedMs).toBeLessThan(200);
  });
});
