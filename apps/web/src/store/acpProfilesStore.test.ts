// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listProfiles = vi.hoisted(() => vi.fn());
vi.mock('@/api/acp', () => ({ listAcpProfiles: listProfiles }));

import {
  getDefaultAgentBinding,
  loadDefaultAgentBinding,
  useAcpProfilesStore,
} from './acpProfilesStore';

const profile = {
  id: 'profile-default',
  alias: 'Default Agent',
  agentletId: 'machine',
  workingDirPath: '/workspace',
  launch: { kind: 'acp-command' as const, command: 'agent' },
};
const snapshot = {
  profiles: [profile],
  selectableProfileIds: [],
  agentlet: null,
  agentDefaults: { profileId: profile.id, functionalModel: 'utility-only' },
};

beforeEach(() => {
  listProfiles.mockReset().mockResolvedValue(snapshot);
  useAcpProfilesStore.setState({
    loaded: false,
    error: null,
    profiles: [],
    agentDefaults: null,
  });
});

describe('default Agent snapshot', () => {
  it('awaits shared initialization and selects the configured identity even while offline', async () => {
    const [first, second] = await Promise.all([
      loadDefaultAgentBinding(),
      loadDefaultAgentBinding(),
    ]);
    expect(first).toEqual({
      kind: 'external',
      profileId: profile.id,
      alias: profile.alias,
    });
    expect(second).toEqual(first);
    expect(listProfiles).toHaveBeenCalledOnce();
    expect(useAcpProfilesStore.getState().agentDefaults).toEqual(
      snapshot.agentDefaults,
    );
    expect(first).not.toHaveProperty('functionalModel');
  });

  it('keeps a deleted default ID rather than selecting the remaining Profile', async () => {
    listProfiles.mockResolvedValueOnce({
      ...snapshot,
      agentDefaults: { profileId: 'deleted', functionalModel: '' },
    });
    expect(await loadDefaultAgentBinding()).toEqual({
      kind: 'external',
      profileId: 'deleted',
      alias: 'deleted',
    });
  });

  it.each([undefined, { profileId: null, functionalModel: '' }])(
    'rejects unsupported or unconfigured defaults: %o',
    async (agentDefaults) => {
      listProfiles.mockResolvedValueOnce({ ...snapshot, agentDefaults });
      await expect(loadDefaultAgentBinding()).rejects.toThrow();
      expect(useAcpProfilesStore.getState().agentDefaults).toEqual(
        agentDefaults ?? null,
      );
    },
  );

  it('does not use a previous snapshot after a failed refresh', async () => {
    await loadDefaultAgentBinding();
    listProfiles.mockRejectedValueOnce(new Error('offline'));
    await expect(loadDefaultAgentBinding()).rejects.toThrow();
    expect(() => getDefaultAgentBinding()).toThrow();
    expect(useAcpProfilesStore.getState().profiles).toEqual([profile]);
  });
});
