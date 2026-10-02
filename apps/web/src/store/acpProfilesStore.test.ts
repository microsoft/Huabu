// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listProfiles = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({
  getDefaults: vi.fn(),
  updateDefaults: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/api/acp', () => ({ listAcpProfiles: listProfiles }));
vi.mock('@/api/agentDefaults', () => ({
  getAgentDefaults: api.getDefaults,
  updateAgentDefaults: api.updateDefaults,
}));
vi.mock('@/components/Common/Toast', () => ({ toast: api.toast }));

import {
  getDefaultAgentBinding,
  loadDefaultAgentBinding,
  RECENT_CONVERSATION_AGENT_STORAGE_KEY,
  rememberConversationAgentBinding,
  useAcpProfilesStore,
} from './acpProfilesStore';

import type { AgentDefaults, AgentDefaultsResponse } from '@huabu/shared';

const profile = {
  id: 'profile-default',
  alias: 'Default Agent',
  agentletId: 'machine',
  workingDirPath: '/workspace',
  launch: { kind: 'acp-command' as const, command: 'agent' },
};
const snapshot = {
  profiles: [profile],
  selectableProfileIds: [profile.id],
  connectedDevices: [],
  agentlet: null,
  agentDefaults: { profileId: 'huabu', functionalModel: 'utility-only' },
};

beforeEach(() => {
  localStorage.clear();
  listProfiles.mockReset().mockResolvedValue(snapshot);
  api.getDefaults.mockReset().mockResolvedValue({
    defaults: snapshot.agentDefaults,
    selectionState: 'available',
    modelCapability: 'supported',
  });
  api.updateDefaults.mockReset().mockImplementation(
    async (defaults: AgentDefaults): Promise<AgentDefaultsResponse> => ({
      defaults,
      selectionState: 'available',
      modelCapability: 'unknown',
    }),
  );
  api.toast.mockReset();
  useAcpProfilesStore.setState({
    loaded: false,
    error: null,
    profiles: [profile],
    selectableProfileIds: [profile.id],
    connectedDevices: [],
    agentDefaults: null,
    defaultsError: null,
    recentConversationProfileId: null,
  });
});

describe('browser-local recent conversation Agent', () => {
  it('deduplicates Profile refresh and resolves the first selectable Profile', async () => {
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
    expect(api.getDefaults).not.toHaveBeenCalled();
  });

  it('falls back to the first selectable Profile when the local cache is stale', async () => {
    await rememberConversationAgentBinding({
      kind: 'external',
      profileId: 'stale-profile',
      alias: 'Stale',
    });
    await expect(loadDefaultAgentBinding()).resolves.toMatchObject({
      kind: 'external',
      profileId: profile.id,
    });
  });

  it('supports Built-In Pi as an explicit conversational choice', async () => {
    await rememberConversationAgentBinding({ kind: 'internal' });
    await expect(loadDefaultAgentBinding()).resolves.toEqual({
      kind: 'internal',
    });
  });

  it('remembers explicit conversational use independently of Utility Agent settings', async () => {
    await rememberConversationAgentBinding({
      kind: 'external',
      profileId: profile.id,
      alias: profile.alias,
    });
    expect(localStorage.getItem(RECENT_CONVERSATION_AGENT_STORAGE_KEY)).toBe(
      profile.id,
    );
    expect(getDefaultAgentBinding()).toMatchObject({
      profileId: profile.id,
    });
    expect(useAcpProfilesStore.getState().agentDefaults).toBeNull();
  });

  it('does not let Utility Agent changes reroute new conversations', async () => {
    await loadDefaultAgentBinding();
    await useAcpProfilesStore.getState().saveDefaults({
      profileId: 'huabu',
      functionalModel: '',
    });
    expect(getDefaultAgentBinding()).toMatchObject({
      kind: 'external',
      profileId: profile.id,
    });
  });

  it('keeps the last explicit browser selection', () => {
    useAcpProfilesStore.getState().rememberConversationAgent('first');
    useAcpProfilesStore.getState().rememberConversationAgent('second');
    expect(useAcpProfilesStore.getState().recentConversationProfileId).toBe(
      'second',
    );
    expect(localStorage.getItem(RECENT_CONVERSATION_AGENT_STORAGE_KEY)).toBe(
      'second',
    );
  });
});

describe('Utility Agent settings', () => {
  it('serializes saves and publishes the last confirmed settings', async () => {
    let finish!: (response: AgentDefaultsResponse) => void;
    api.updateDefaults.mockImplementationOnce(
      () =>
        new Promise<AgentDefaultsResponse>((resolve) => {
          finish = resolve;
        }),
    );
    const state = useAcpProfilesStore.getState();
    const first = state.saveDefaults({
      profileId: 'first',
      functionalModel: '',
    });
    const second = state.saveDefaults({
      profileId: 'last',
      functionalModel: 'fast',
    });
    await Promise.resolve();
    expect(api.updateDefaults).toHaveBeenCalledTimes(1);
    finish({
      defaults: { profileId: 'first', functionalModel: '' },
      selectionState: 'available',
      modelCapability: 'unknown',
    });
    await Promise.all([first, second]);
    expect(
      api.updateDefaults.mock.calls.map(([config]) => config.profileId),
    ).toEqual(['first', 'last']);
    expect(useAcpProfilesStore.getState().agentDefaults).toEqual({
      profileId: 'last',
      functionalModel: 'fast',
    });
  });

  it('reports failed saves without blocking subsequent edits', async () => {
    api.updateDefaults.mockRejectedValueOnce(new Error('read-only'));
    const state = useAcpProfilesStore.getState();
    const first = state.saveDefaults({
      profileId: 'first',
      functionalModel: '',
    });
    const second = state.saveDefaults({
      profileId: 'last',
      functionalModel: '',
    });
    await expect(first).rejects.toThrow('read-only');
    await second;
    expect(api.toast).toHaveBeenCalledWith('read-only', { tone: 'danger' });
    expect(useAcpProfilesStore.getState().agentDefaults?.profileId).toBe(
      'last',
    );
  });

  it('does not let an older catalogue refresh overwrite a saved setting', async () => {
    let finish!: (value: typeof snapshot) => void;
    listProfiles.mockImplementationOnce(
      () =>
        new Promise<typeof snapshot>((resolve) => {
          finish = resolve;
        }),
    );
    const refreshing = useAcpProfilesStore.getState().refresh();
    await Promise.resolve();
    await useAcpProfilesStore.getState().saveDefaults({
      profileId: 'new-utility',
      functionalModel: '',
    });
    finish(snapshot);
    await refreshing;
    expect(useAcpProfilesStore.getState().agentDefaults?.profileId).toBe(
      'new-utility',
    );
  });
});
