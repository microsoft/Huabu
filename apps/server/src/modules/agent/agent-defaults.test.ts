// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import {
  AgentDefaultsError,
  AgentDefaultsService,
  initializeAgentDefaults,
} from './agent-defaults.js';

import type { AgentDefaults, AgentProfileView } from '@huabu/shared';

vi.mock('@agenetes/agentlet-host', () => ({
  resolveConnectedAgentletId: (id: string) =>
    id === 'connected' || id === 'legacy-host' ? 'connected' : undefined,
}));

function profile(
  id: string,
  agentletId = 'machine-a',
  cliId = 'copilot',
): AgentProfileView {
  return {
    id,
    alias: id,
    agentletId,
    workingDirPath: '/workspace',
    launch: { kind: 'acp-command', command: 'copilot --acp' },
    metadata: { cliId },
  };
}

function setup(initial?: unknown) {
  let persisted = initial;
  const storage = {
    read: async () => persisted,
    write: vi.fn(async (config: AgentDefaults) => {
      persisted = structuredClone(config);
    }),
  };
  return { storage, service: new AgentDefaultsService(storage) };
}

describe('installation Agent defaults', () => {
  it('offers only connected external candidates to automatic initialization', async () => {
    const initialize = vi
      .spyOn(AgentDefaultsService.prototype, 'initializeAgentDefaults')
      .mockResolvedValue({ profileId: null, functionalModel: '' });
    try {
      const online = profile('online', 'connected');
      await initializeAgentDefaults([profile('offline', 'offline'), online]);
      expect(initialize).toHaveBeenCalledWith([online]);
    } finally {
      initialize.mockRestore();
    }
  });

  it('excludes hidden Profiles from absent-only Utility initialization', async () => {
    const hidden = { ...profile('proxy'), visible: false };
    const empty = setup();
    expect(
      (await empty.service.initializeAgentDefaults([hidden])).profileId,
    ).toBeNull();
    expect(empty.storage.write).not.toHaveBeenCalled();
    const ready = setup();
    expect(
      (
        await ready.service.initializeAgentDefaults([
          hidden,
          profile('ordinary'),
        ])
      ).profileId,
    ).toBe('ordinary');
  });

  it('offers a uniquely resolved hostname-era candidate to initialization', async () => {
    const initialize = vi
      .spyOn(AgentDefaultsService.prototype, 'initializeAgentDefaults')
      .mockResolvedValue({ profileId: null, functionalModel: '' });
    try {
      const legacy = profile('legacy', 'legacy-host');
      await initializeAgentDefaults([legacy]);
      expect(initialize).toHaveBeenCalledWith([legacy]);
    } finally {
      initialize.mockRestore();
    }
  });

  it('requires an explicit external default instead of falling back to Huabu', async () => {
    const { service, storage } = setup();
    await expect(service.requireDefaultAgentProfileId()).rejects.toThrow(
      AgentDefaultsError,
    );
    await expect(service.requireDefaultAgentProfileId()).rejects.toThrow(
      expect.objectContaining({ code: 'default_profile_unconfigured' }),
    );
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('returns the saved identity for independent registry validation', async () => {
    const { service } = setup({
      profileId: 'deleted-or-offline',
      functionalModel: '',
    });
    expect(await service.requireDefaultAgentProfileId()).toBe(
      'deleted-or-offline',
    );
  });

  it('does not write on GET or when discovery has no candidates', async () => {
    const { service, storage } = setup();
    expect(await service.getAgentDefaults()).toEqual({
      profileId: null,
      functionalModel: '',
    });
    await service.initializeAgentDefaults([]);
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('persists trimmed overrides independently of Profile data', async () => {
    const { service, storage } = setup();
    const candidate = profile('profile-a');
    await service.initializeAgentDefaults([candidate]);
    await service.setAgentDefaults({
      profileId: 'profile-a',
      functionalModel: '  fast  ',
    });
    expect(await new AgentDefaultsService(storage).getAgentDefaults()).toEqual({
      profileId: 'profile-a',
      functionalModel: 'fast',
    });
    expect(candidate).toEqual(profile('profile-a'));
    await service.setAgentDefaults({
      profileId: 'profile-a',
      functionalModel: ' \t ',
    });
    expect((await service.getAgentDefaults()).functionalModel).toBe('');
  });

  it('initializes once in deterministic machine, harness, then ID order', async () => {
    const { service, storage } = setup();
    const candidates = [
      profile('first', 'machine-b', 'aaa'),
      profile('z-id', 'machine-a', 'aaa'),
      profile('a-id', 'machine-a', 'bbb'),
      profile('b-id', 'machine-a', 'aaa'),
    ];
    expect((await service.initializeAgentDefaults(candidates)).profileId).toBe(
      'b-id',
    );
    expect(candidates[0].id).toBe('first');
    await service.initializeAgentDefaults([...candidates].reverse());
    await service.initializeAgentDefaults([
      profile('new-earlier', 'a-machine'),
    ]);
    expect((await service.getAgentDefaults()).profileId).toBe('b-id');
    expect(storage.write).toHaveBeenCalledTimes(1);
  });

  it('retains a deleted Profile ID across restarts and discovery', async () => {
    const { service, storage } = setup({
      profileId: 'deleted',
      functionalModel: 'small',
    });
    await service.initializeAgentDefaults([profile('replacement')]);
    expect(await new AgentDefaultsService(storage).getAgentDefaults()).toEqual({
      profileId: 'deleted',
      functionalModel: 'small',
    });
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('does not overwrite an explicit null selection or its model', async () => {
    const { service, storage } = setup();
    await service.setAgentDefaults({
      profileId: null,
      functionalModel: 'fast',
    });
    expect(
      await service.initializeAgentDefaults([profile('external')]),
    ).toEqual({
      profileId: null,
      functionalModel: 'fast',
    });
    expect(
      await new AgentDefaultsService(storage).initializeAgentDefaults([
        profile('another'),
      ]),
    ).toEqual({ profileId: null, functionalModel: 'fast' });
    expect(storage.write).toHaveBeenCalledTimes(1);
  });

  it('preserves explicit Built-In selection and the external model across discovery and restart', async () => {
    const { service, storage } = setup();
    await service.setAgentDefaults({
      profileId: 'huabu',
      functionalModel: 'external-model',
    });
    expect(
      await service.initializeAgentDefaults([profile('external')]),
    ).toEqual({
      profileId: 'huabu',
      functionalModel: 'external-model',
    });
    expect(
      await new AgentDefaultsService(storage).requireDefaultAgentProfileId(),
    ).toBe('huabu');
    expect(storage.write).toHaveBeenCalledTimes(1);
  });

  it.each([null, 'broken', { profileId: 2 }])(
    'fails explicitly for corrupt persisted configuration %j',
    async (value) => {
      const { service, storage } = setup(value);
      await expect(service.getAgentDefaults()).rejects.toThrow(
        'Invalid Agent defaults file',
      );
      await expect(
        service.initializeAgentDefaults([profile('external')]),
      ).rejects.toThrow();
      expect(storage.write).not.toHaveBeenCalled();
    },
  );

  it('propagates persistence failures', async () => {
    const { service, storage } = setup();
    storage.write.mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(
      service.setAgentDefaults({ profileId: 'external', functionalModel: '' }),
    ).rejects.toThrow('disk full');
  });
});
