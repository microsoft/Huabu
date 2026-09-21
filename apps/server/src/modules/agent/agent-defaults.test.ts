// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import { AgentDefaultsError, AgentDefaultsService } from './agent-defaults.js';

import type { AgentDefaults, AgentProfileView } from '@huabu/shared';

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
    read: () => persisted,
    write: vi.fn((config: AgentDefaults) => {
      persisted = structuredClone(config);
    }),
  };
  return { storage, service: new AgentDefaultsService(storage) };
}

describe('installation Agent defaults', () => {
  it('requires an explicit external default instead of falling back to Huabu', () => {
    const { service, storage } = setup();
    expect(() => service.requireDefaultAgentProfileId()).toThrow(
      AgentDefaultsError,
    );
    expect(() => service.requireDefaultAgentProfileId()).toThrow(
      expect.objectContaining({ code: 'default_profile_unconfigured' }),
    );
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('returns the saved identity for independent registry validation', () => {
    const { service } = setup({
      profileId: 'deleted-or-offline',
      functionalModel: '',
    });
    expect(service.requireDefaultAgentProfileId()).toBe('deleted-or-offline');
  });

  it('does not write on GET or when discovery has no candidates', () => {
    const { service, storage } = setup();
    expect(service.getAgentDefaults()).toEqual({
      profileId: null,
      functionalModel: '',
    });
    service.initializeAgentDefaults([]);
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('persists trimmed overrides independently of Profile data', () => {
    const { service, storage } = setup();
    const candidate = profile('profile-a');
    service.initializeAgentDefaults([candidate]);
    service.setAgentDefaults({
      profileId: 'profile-a',
      functionalModel: '  fast  ',
    });
    expect(new AgentDefaultsService(storage).getAgentDefaults()).toEqual({
      profileId: 'profile-a',
      functionalModel: 'fast',
    });
    expect(candidate).toEqual(profile('profile-a'));
    service.setAgentDefaults({
      profileId: 'profile-a',
      functionalModel: ' \t ',
    });
    expect(service.getAgentDefaults().functionalModel).toBe('');
  });

  it('initializes once in deterministic machine, harness, then ID order', () => {
    const { service, storage } = setup();
    const candidates = [
      profile('first', 'machine-b', 'aaa'),
      profile('z-id', 'machine-a', 'aaa'),
      profile('a-id', 'machine-a', 'bbb'),
      profile('b-id', 'machine-a', 'aaa'),
    ];
    expect(service.initializeAgentDefaults(candidates).profileId).toBe('b-id');
    expect(candidates[0].id).toBe('first');
    service.initializeAgentDefaults([...candidates].reverse());
    service.initializeAgentDefaults([profile('new-earlier', 'a-machine')]);
    expect(service.getAgentDefaults().profileId).toBe('b-id');
    expect(storage.write).toHaveBeenCalledTimes(1);
  });

  it('retains a deleted Profile ID across restarts and discovery', () => {
    const { service, storage } = setup({
      profileId: 'deleted',
      functionalModel: 'small',
    });
    service.initializeAgentDefaults([profile('replacement')]);
    expect(new AgentDefaultsService(storage).getAgentDefaults()).toEqual({
      profileId: 'deleted',
      functionalModel: 'small',
    });
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('does not overwrite an explicit null selection or its model', () => {
    const { service, storage } = setup();
    service.setAgentDefaults({ profileId: null, functionalModel: 'fast' });
    expect(service.initializeAgentDefaults([profile('external')])).toEqual({
      profileId: null,
      functionalModel: 'fast',
    });
    expect(
      new AgentDefaultsService(storage).initializeAgentDefaults([
        profile('another'),
      ]),
    ).toEqual({ profileId: null, functionalModel: 'fast' });
    expect(storage.write).toHaveBeenCalledTimes(1);
  });

  it.each([null, 'broken', { profileId: 2 }, { profileId: 'huabu' }])(
    'fails explicitly for corrupt persisted configuration %j',
    (value) => {
      const { service, storage } = setup(value);
      expect(() => service.getAgentDefaults()).toThrow(
        'Invalid Agent defaults file',
      );
      expect(() =>
        service.initializeAgentDefaults([profile('external')]),
      ).toThrow();
      expect(storage.write).not.toHaveBeenCalled();
    },
  );

  it('propagates persistence failures', () => {
    const { service, storage } = setup();
    storage.write.mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() =>
      service.setAgentDefaults({ profileId: 'external', functionalModel: '' }),
    ).toThrow('disk full');
  });
});
