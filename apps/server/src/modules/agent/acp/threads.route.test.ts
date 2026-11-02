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

import acpThreadsRoutes from './threads.route.js';

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
  it.each([
    ['mode', { modeId: 'plan' }],
    ['model', { modelId: 'model-1' }],
    ['config-option', { configOptionId: 'effort', value: 'high' }],
  ])(
    'passes Chat directory intent through the %s realization entry point',
    async (operation, settings) => {
      mocks.realize.mockResolvedValue({
        binding: { kind: 'external', profileId: 'profile-1', alias: 'Agent' },
        spec: { spec: {} },
        handle: { control: mocks.control },
      });
      mocks.ensureSession.mockResolvedValue({
        availableModes: [],
        availableModels: [],
        configOptions: [],
        metaUpdatedAt: 0,
      });
      mocks.control.mockResolvedValue({ ok: true });
      const server = await createApp();
      const response = await server.inject({
        method: 'POST',
        url: `/api/acp/threads/thread-1/${operation}`,
        payload: {
          ...settings,
          binding: { kind: 'external', profileId: 'profile-1', alias: 'Agent' },
          canvasId: 'canvas-1',
          cwd: '/chat/project',
        },
      });
      expect(response.statusCode).toBe(200);
      expect(mocks.realize).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedCwd: '/chat/project',
        }),
      );
    },
  );

  it.each(['relative/path', ' /path', '', '/'.repeat(4097)])(
    'rejects invalid control cwd %j before realization',
    async (cwd) => {
      const server = await createApp();
      const response = await server.inject({
        method: 'POST',
        url: '/api/acp/threads/thread-1/mode',
        payload: {
          modeId: 'plan',
          binding: { kind: 'external', profileId: 'profile-1', alias: 'Agent' },
          cwd,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(mocks.realize).not.toHaveBeenCalled();
    },
  );
  it('returns frozen execution identity even without live metadata or a Profile', async () => {
    mocks.record = {
      spec: {
        kind: 'external',
        spec: {
          binding: { alias: 'Removed Profile', profileId: 'profile-removed' },
          cwd: '/frozen/project',
          agentletId: 'machine',
        },
      },
      state: {},
    };
    const server = await createApp();
    const response = await server.inject({
      method: 'GET',
      url: '/api/acp/threads/thread-1/cached-meta?canvasId=canvas-1',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: 'thread',
      execution: {
        binding: {
          kind: 'external',
          profileId: 'profile-removed',
          alias: 'Removed Profile',
        },
        workingDirPath: '/frozen/project',
        agentletId: 'machine',
      },
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(response.json().execution).not.toHaveProperty(
      'workingDirectoryOverride',
    );
  });
  it.each([null, '/frozen/project'])(
    'preserves frozen directory origin %s without consulting the current Profile',
    async (workingDirectoryOverride) => {
      mocks.record = {
        spec: {
          kind: 'external',
          spec: {
            binding: { alias: 'Profile', profileId: 'profile-1' },
            cwd: '/frozen/project',
            workingDirectoryOverride,
          },
        },
        state: {},
      };
      const server = await createApp();
      const response = await server.inject({
        method: 'GET',
        url: '/api/acp/threads/thread-1/cached-meta?canvasId=canvas-1',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().execution).toMatchObject({
        workingDirPath: '/frozen/project',
        workingDirectoryOverride,
      });
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );
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

  it('removes the thread warm route without realizing a workload', async () => {
    const server = await createApp();

    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/threads/thread-1/warm',
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(mocks.realize).not.toHaveBeenCalled();
  });

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
