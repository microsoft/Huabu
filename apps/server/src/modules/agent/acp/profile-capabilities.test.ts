// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  discoverProfileCapabilities,
  readProfileCapabilities,
} from './profile-capabilities.js';

import type { AcpProfileSchemaCacheEntry } from './profile-schema-cache.js';
import type { FastifyBaseLogger } from 'fastify';

const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  connected: vi.fn(),
  probe: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  resolveSelections: vi.fn(),
}));
vi.mock('@agenetes/acp-driver', () => ({
  probeAcpCapabilities: mocks.probe,
  resolveInitialPreferenceSelections: mocks.resolveSelections,
}));
vi.mock('@agenetes/agentlet-host', () => ({
  getAgentProfileRegistry: () => ({ getProfile: mocks.getProfile }),
  resolveConnectedAgentletId: mocks.connected,
}));
vi.mock('./profile-schema-cache.js', () => ({
  getProfileSchemaCache: mocks.read,
  mergeProfileSchemaCache: mocks.write,
}));

const profile = {
  id: 'profile',
  alias: 'Agent',
  agentletId: 'machine',
  workingDirPath: '/project',
  executionRevision: 1,
  launch: { kind: 'acp-harness', harnessId: 'copilot' },
};
const logger = { warn: vi.fn() } as unknown as FastifyBaseLogger;
let cache: AcpProfileSchemaCacheEntry | null;

beforeEach(() => {
  vi.resetAllMocks();
  cache = null;
  mocks.getProfile.mockReturnValue(profile);
  mocks.connected.mockReturnValue('machine');
  mocks.resolveSelections.mockReturnValue({});
  mocks.read.mockImplementation(() => cache);
  mocks.write.mockImplementation((_id, entry: AcpProfileSchemaCacheEntry) => {
    cache = entry;
  });
  mocks.probe.mockResolvedValue({
    availableModels: [{ modelId: 'fast', name: 'Fast' }],
    metaUpdatedAt: 10,
  });
});

describe('Profile capability discovery', () => {
  it('keeps cold reads side-effect free and reuses observed cache', async () => {
    expect((await readProfileCapabilities('profile')).source).toBe('none');
    expect(mocks.probe).not.toHaveBeenCalled();
    cache = { metaUpdatedAt: 1, executionRevision: 1, availableModels: [] };
    expect((await discoverProfileCapabilities('profile', logger)).source).toBe(
      'profile',
    );
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it('carries the remembered preferences a new session will start with', async () => {
    mocks.getProfile.mockReturnValue({
      ...profile,
      customData: { sessionPreferences: { model: 'fast' } },
    });
    const availableModels = [{ modelId: 'fast', name: 'Fast' }];
    cache = { metaUpdatedAt: 1, executionRevision: 1, availableModels };
    mocks.resolveSelections.mockReturnValue({ model: 'fast' });

    expect(
      (await readProfileCapabilities('profile')).sessionMeta.selections,
    ).toEqual({
      model: 'fast',
    });
    expect(mocks.resolveSelections).toHaveBeenCalledWith(
      { model: 'fast' },
      { configOptions: [], availableModels },
    );
  });

  it('coalesces concurrent callers, without realizing or addressing any user thread', async () => {
    const [chat, settings] = await Promise.all([
      discoverProfileCapabilities('profile', logger),
      discoverProfileCapabilities('profile', logger),
    ]);
    expect(mocks.probe).toHaveBeenCalledOnce();
    expect(mocks.probe).toHaveBeenCalledWith({
      agentletId: 'machine',
      binding: { profileId: 'profile', alias: 'Agent' },
      profileExecutionRevision: 1,
      recipe: {
        launch: profile.launch,
        cwd: '/project',
        alias: 'Agent',
        autoRestart: true,
      },
      logger,
    });
    expect(chat).toEqual(settings);
    expect(chat.sessionMeta.availableModels).toEqual([
      { modelId: 'fast', name: 'Fast' },
    ]);
    expect(chat.sessionMeta.selections).toEqual({});
    expect(chat).not.toHaveProperty('execution');
    expect(mocks.write).toHaveBeenCalledOnce();
  });

  it('remembers a successful empty observation so it does not repeatedly spawn', async () => {
    mocks.probe.mockResolvedValue({
      availableModels: [],
      configOptions: [],
      metaUpdatedAt: 10,
    });
    await discoverProfileCapabilities('profile', logger);
    const result = await discoverProfileCapabilities('profile', logger);
    expect(result.source).toBe('profile');
    expect(result.sessionMeta.availableModels).toEqual([]);
    expect(mocks.probe).toHaveBeenCalledOnce();
  });

  it.each([undefined, { ...profile, executionRevision: 2 }])(
    'rejects a late observation after Profile deletion or edit',
    async (changed) => {
      mocks.probe.mockImplementation(async () => {
        mocks.getProfile.mockReturnValue(changed);
        return { metaUpdatedAt: 10 };
      });
      await expect(
        discoverProfileCapabilities('profile', logger),
      ).rejects.toMatchObject({
        status: 409,
        code: 'profile_changed',
      });
      expect(mocks.write).not.toHaveBeenCalled();
    },
  );

  it('ignores cache from a different execution revision', async () => {
    cache = { executionRevision: 0, metaUpdatedAt: 1 };
    expect((await readProfileCapabilities('profile')).source).toBe('none');
    await discoverProfileCapabilities('profile', logger);
    expect(cache?.executionRevision).toBe(1);
  });

  it('does not overwrite a catalogue reported by a live session during discovery', async () => {
    mocks.probe.mockImplementation(async () => {
      cache = {
        metaUpdatedAt: 11,
        availableModels: [{ modelId: 'live', name: 'Live' }],
      };
      return { metaUpdatedAt: 10 };
    });
    expect(
      (await discoverProfileCapabilities('profile', logger)).sessionMeta
        .availableModels[0].modelId,
    ).toBe('live');
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('reports failures without caching them and allows retry', async () => {
    mocks.probe.mockRejectedValueOnce(new Error('auth required'));
    await expect(
      discoverProfileCapabilities('profile', logger),
    ).rejects.toThrow('auth required');
    expect(mocks.write).not.toHaveBeenCalled();
    await discoverProfileCapabilities('profile', logger);
    expect(mocks.probe).toHaveBeenCalledTimes(2);
  });

  it('reads cached data while offline, but cannot discover without an Agentlet', async () => {
    mocks.connected.mockReturnValue(undefined);
    await expect(
      discoverProfileCapabilities('profile', logger),
    ).rejects.toMatchObject({
      status: 503,
      code: 'placement_unavailable',
    });
    cache = { metaUpdatedAt: 1 };
    expect((await discoverProfileCapabilities('profile', logger)).source).toBe(
      'profile',
    );
    expect(mocks.probe).not.toHaveBeenCalled();
  });
});
